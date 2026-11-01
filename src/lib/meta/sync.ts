import { and, eq, lt, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  clients,
  fbBreakdownMetrics,
  fbDailyMetrics,
  fbPeriodReach,
  metaAdAccounts,
  metaAdCreatives,
  syncRuns,
  type Client,
  type DeliveryRanking,
  type MetaAdAccount,
} from "@/db/schema";
import { META_BREAKDOWNS, isReduceDataError, parseInsightRow, segmentLabel } from "./client";
import { resolveCreative, type CreativeType } from "./creative";
import { activeAdAccounts, metaClientForAccount } from "./accounts";
import {
  MAX_RANGE_DAYS,
  META_PROVISIONAL_DAYS,
  isProvisional,
  todayKey,
  trailingWindowInclusive,
} from "@/lib/dates";

/**
 * How far back each nightly run re-pulls.
 *
 * Meta restates spend and conversions for up to 28 days as attribution windows
 * fill, so a write-once-and-never-revisit sync drifts permanently out of
 * agreement with Ads Manager. We re-pull the ENTIRE restatement window every
 * night and upsert, so every day still eligible to change keeps being trued up
 * until Meta finalises it — which is what makes an arbitrary calendar range
 * match Ads Manager exactly, not merely the last few days. Coupled to
 * META_PROVISIONAL_DAYS so the "still changing" and "still re-pulled" windows
 * can never silently drift apart. (Earlier this was 7, which left days 8–28
 * frozen at stale values.)
 */
export const RECONCILE_DAYS = META_PROVISIONAL_DAYS;

/** Dashboards older than this trigger a background refresh on load. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

export interface SyncOptions {
  /** `YYYY-MM-DD` in the client's timezone. Defaults to a trailing window. */
  since?: string;
  until?: string;
  /** Also refresh cached period-reach rows. Skipped on fast intraday syncs. */
  includeReach?: boolean;
  /**
   * This is a FULL trailing-window reconciliation, so stamp
   * `clients.lastReconciledAt` on success.
   *
   * Set only by the cron routes. The intraday stale-while-revalidate path calls
   * this same function with `since = until = today`, and if that also counted as
   * a reconcile, a dashboard someone keeps open would look permanently up to
   * date while never being trued up against Meta's 28-day restatements.
   */
  isReconcile?: boolean;
  /**
   * This is the best-effort current-day refresh fired by a dashboard load, so
   * log it under `meta_intraday` rather than `meta_daily`.
   *
   * Health reads only the full-sync kind. An intraday run races the page
   * response and can be killed with the invocation; letting it write the same
   * kind meant a page view could either mask a dead cron ("synced 2m ago") or
   * fake a red ("last sync failed") for a pipe that was never broken.
   */
  intraday?: boolean;
  /**
   * Also run the ad-level pass: pull insights at `level=ad`, resolve the
   * creative of each ad in them, and stamp the creative key onto each row.
   *
   * Off by default because it is materially more work — a second insights query
   * over the same window at a much higher row count, plus a lookup of the ads
   * that delivered and one video-length lookup per new asset. The intraday refresh runs on every
   * dashboard load and must stay cheap; the nightly reconciliation turns this
   * on, which is the right cadence for creative reporting anyway.
   */
  includeAdLevel?: boolean;
  /**
   * Also pull the audience breakdowns (age, gender, region, placement, device).
   *
   * Five extra insights requests per account, so it shares the ad-level cadence:
   * on the nightly reconciliation and a manual sync, never on the intraday
   * refresh that fires on every dashboard load.
   */
  includeBreakdowns?: boolean;
}

/**
 * Pull Meta insights for one client and upsert them.
 *
 * Iterates EVERY active ad account attached to the client and tags each row
 * with its `metaAdAccountId`, so a multi-account client's spend accumulates
 * rather than one account overwriting another. The read side then sums across
 * accounts automatically, since every row shares the client id.
 *
 * Returns the number of daily rows written across all accounts. Throws on a
 * hard API failure so the caller can record it — a sync that silently no-ops is
 * exactly the failure mode that left six blocks of the old spreadsheet empty.
 */
export async function syncClientMetrics(
  client: Client,
  opts: SyncOptions = {},
): Promise<{ rowsWritten: number; runId: string }> {
  const [run] = await db
    .insert(syncRuns)
    .values({
      clientId: client.id,
      kind: opts.intraday ? "meta_intraday" : "meta_daily",
      status: "running",
    })
    .returning({ id: syncRuns.id });

  try {
    const accounts = await activeAdAccounts(client.id);
    if (accounts.length === 0) {
      throw new Error("Client has no Meta ad account configured");
    }

    const tz = client.timezone;
    const window = trailingWindowInclusive(RECONCILE_DAYS, tz);
    const since = opts.since ?? window.startKey;
    const until = opts.until ?? window.endKey;

    let written = 0;
    /*
     * Breakdowns that Meta refused, collected rather than thrown.
     *
     * One rejected breakdown must not fail a sync that pulled spend, leads and
     * creatives correctly — but it must not vanish either, or that panel
     * silently serves stale data forever. Recorded on the sync_run, so the
     * failure is visible without being fatal.
     */
    const breakdownFailures: string[] = [];
    /*
     * Ads Meta would not describe, collected the same way. Their rows are still
     * written, under the creative stored for each ad, so spend, leads and every
     * per-ad figure stay current; the night after, they are asked for again.
     * Failing the run for a name and a thumbnail is what kept two clients'
     * whole Meta reconcile red from 23 Oct 2026.
     */
    const creativeFailures: string[] = [];
    // One account's failure must not stop the others. A closed location's
    // revoked access used to freeze every healthy account after it, while the
    // health check said only the dead account was missing. Each account now
    // syncs on its own; the run still ends failed (so not reconciled, and
    // retried) when any account failed, so the dead one stays visible.
    const failures: unknown[] = [];
    // Serialised per account — Meta warns that firing several insights queries
    // at once invites throttling.
    for (const account of accounts) {
      try {
        written += await syncAccountMetrics(client, account, since, until, tz);

        /*
         * The ad-level pass. Each ad's creative is resolved BEFORE its rows are
         * written, because the metrics rows carry the creative key — writing
         * first would leave a window of rows with empty keys that only the next
         * night's run would repair, and any leaderboard read in between would
         * silently omit them.
         */
        if (opts.includeAdLevel) {
          /*
           * Collect-and-continue only for days the nightly pulls again: a
           * listing that fails tonight is asked for again tomorrow. Older days
           * (the backfill scripts) throw instead, so a month is never written
           * with its ads unnamed and then skipped as complete by the import.
           */
          const resolve = creativeResolver(
            client,
            account,
            since >= window.startKey ? { failures: creativeFailures } : {},
          );
          written += await pullAdLevel(client, account, since, until, resolve);
          if (opts.isReconcile) {
            await refreshStaleCreatives(client, account, resolve, creativeFailures);
          }
        }

        if (opts.includeBreakdowns) {
          const b = await syncAccountBreakdowns(client, account, since, until);
          written += b.rowsWritten;
          breakdownFailures.push(...b.failures);
        }

        if (opts.includeReach) {
          await syncAccountPeriodReach(client, account, since, until);
        }
        await db
          .update(metaAdAccounts)
          .set({ lastSyncedAt: new Date() })
          .where(eq(metaAdAccounts.id, account.id));
      } catch (err) {
        failures.push(err);
      }
    }
    if (opts.includeAdLevel) {
      await rekeyUnnamedAdRows(client.id).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[meta] unnamed ad rows not re-keyed", message);
        creativeFailures.push(`re-key: ${message.slice(0, 200)}`);
      });
    }
    if (failures.length > 0) throw failures[0];

    // Stamped only on success — a failed run must never look reconciled, or the
    // overdue gate would skip the client until tomorrow.
    const finishedAt = new Date();
    await db
      .update(clients)
      .set({
        lastSyncedAt: finishedAt,
        ...(opts.isReconcile ? { lastMetaReconciledAt: finishedAt } : {}),
      })
      .where(eq(clients.id, client.id));

    await db
      .update(syncRuns)
      .set({
        status: "success",
        finishedAt,
        rowsWritten: written,
        meta: {
          since,
          until,
          accounts: accounts.length,
          ...(breakdownFailures.length ? { breakdownFailures } : {}),
          ...(creativeFailures.length ? { creativeFailures } : {}),
        },
      })
      .where(eq(syncRuns.id, run.id));

    return { rowsWritten: written, runId: run.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(syncRuns)
      .set({ status: "failed", finishedAt: new Date(), error: message })
      .where(eq(syncRuns.id, run.id));
    throw err;
  }
}

/**
 * Daily insights for one account of a client, at one level.
 *
 * Campaign level is the dashboard's spine and always runs. Ad level is a second
 * pass over the same window with a wider field set, and it is what makes
 * creative reporting possible — the plan called this "a sync change, not a
 * migration", and it is: `fb_daily_metrics.level` was always an enum column,
 * only ever written with one value.
 *
 * `creatives` resolves the ads in the window to their creative identity (insights
 * carries none), after the insights are read and before a row is written. It is
 * denormalised onto each ad row so the creative leaderboard is one indexed
 * GROUP BY rather than a join.
 */
async function syncAccountMetrics(
  client: Client,
  account: MetaAdAccount,
  since: string,
  until: string,
  tz: string,
  level: "campaign" | "ad" = "campaign",
  creatives?: CreativeResolver,
): Promise<number> {
  const meta = metaClientForAccount(account, client.agencyId);
  const rows = await meta.getDailyInsights(
    account.adAccountId,
    since,
    until,
    level,
  );

  const adIds = [...new Set(rows.map((r) => r.ad_id ?? "").filter(Boolean))];
  let identity: CreativeMap | undefined;
  if (level === "ad" && creatives) {
    try {
      identity = await creatives(adIds);
    } catch (err) {
      throw new CreativeLookupError(err);
    }
  }

  const batch: Array<typeof fbDailyMetrics.$inferInsert> = [];
  for (const raw of rows) {
    const parsed = parseInsightRow(raw);
    const isAd = level === "ad";
    const creative = isAd ? identity?.get(parsed.adId) : undefined;

    const values = {
      clientId: client.id,
      metaAdAccountId: account.adAccountId,
      date: parsed.dateKey,
      level,
      metaCampaignId: parsed.campaignId,
      campaignName: parsed.campaignName,
      // Empty strings above ad level keep campaign rows on their own unique key.
      metaAdsetId: isAd ? parsed.adsetId : "",
      adsetName: isAd ? parsed.adsetName : null,
      metaAdId: isAd ? parsed.adId : "",
      adName: isAd ? parsed.adName : null,
      creativeKey: creative?.key ?? "",
      creativeType: creative?.type ?? ("unknown" as const),

      reach: parsed.reach,
      impressions: parsed.impressions,
      clicksAll: parsed.clicksAll,
      linkClicks: parsed.linkClicks,
      inlineLinkClicks: parsed.inlineLinkClicks,
      spend: String(parsed.spend),
      leadsTotal: parsed.leadsTotal,
      leadsPixel: parsed.leadsPixel,
      leadsOnsite: parsed.leadsOnsite,

      video3sViews: parsed.video3sViews,
      videoPlays: parsed.videoPlays,
      thruPlays: parsed.thruPlays,
      videoP25: parsed.videoP25,
      videoP50: parsed.videoP50,
      videoP75: parsed.videoP75,
      videoP95: parsed.videoP95,
      videoP100: parsed.videoP100,
      landingPageViews: parsed.landingPageViews,
      outboundClicks: parsed.outboundClicks,

      // Rankings exist only at ad level; storing Meta's "unknown" above it would
      // read as a real diagnostic rather than a question that does not apply.
      qualityRanking: isAd
        ? (parsed.qualityRanking as DeliveryRanking | null)
        : null,
      engagementRateRanking: isAd
        ? (parsed.engagementRateRanking as DeliveryRanking | null)
        : null,
      conversionRateRanking: isAd
        ? (parsed.conversionRateRanking as DeliveryRanking | null)
        : null,

      currency: parsed.currency ?? account.currency,
      isProvisional: isProvisional(parsed.dateKey, tz),
      raw: raw as object,
      syncedAt: new Date(),
    };
    batch.push(values);
  }
  return upsertFbDailyRows(batch);
}

/** Rows per INSERT. A year of ad-level history is tens of thousands of rows; one round trip each would not fit a request. */
const UPSERT_BATCH = 250;

/** `excluded.<column>` for every column a row sets, so a multi-row upsert writes each row's own values. */
function excludedSet(table: Record<string, unknown>, sample: Record<string, unknown>): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const key of Object.keys(sample)) {
    const name = (table[key] as { name?: unknown } | undefined)?.name;
    if (typeof name === "string") set[key] = sql.raw(`excluded."${name}"`);
  }
  return set;
}

/**
 * Upsert daily metric rows in batches.
 *
 * Upsert, not insert — this is what makes re-pulling a restated day correct
 * rather than a duplicate-key error. Rows are de-duplicated on the conflict key
 * first: Postgres refuses a statement that would update one row twice.
 *
 * `raw` is merged, not replaced. If Meta ever refuses the optional results
 * fields, the retry stores a row without them — and that must not erase the
 * results an earlier run stored for the same day.
 */
export async function upsertFbDailyRows(
  rows: ReadonlyArray<typeof fbDailyMetrics.$inferInsert>,
): Promise<number> {
  const byKey = new Map<string, typeof fbDailyMetrics.$inferInsert>();
  for (const r of rows) {
    byKey.set(
      [r.clientId, r.metaAdAccountId, r.date, r.level, r.metaCampaignId, r.metaAdsetId, r.metaAdId].join("|"),
      r,
    );
  }
  const unique = [...byKey.values()];
  for (let i = 0; i < unique.length; i += UPSERT_BATCH) {
    const chunk = unique.slice(i, i + UPSERT_BATCH);
    await db
      .insert(fbDailyMetrics)
      .values(chunk)
      .onConflictDoUpdate({
        target: [
          fbDailyMetrics.clientId,
          fbDailyMetrics.metaAdAccountId,
          fbDailyMetrics.date,
          fbDailyMetrics.level,
          fbDailyMetrics.metaCampaignId,
          fbDailyMetrics.metaAdsetId,
          fbDailyMetrics.metaAdId,
        ],
        set: {
          ...excludedSet(fbDailyMetrics as unknown as Record<string, unknown>, chunk[0] as Record<string, unknown>),
          raw: sql`COALESCE(${fbDailyMetrics.raw}, '{}'::jsonb) || excluded.raw`,
        },
      });
  }
  return unique.length;
}

/**
 * Audience breakdowns for one account: age, gender, region, placement, device.
 *
 * Five independent requests, because Meta permits only a documented subset of
 * breakdown permutations and `age`/`gender` appear in none alongside
 * `publisher_platform` / `platform_position` / `impression_device`.
 *
 * Each is caught individually. A breakdown Meta rejects — a combination it
 * withdraws in a later version, a field an account is not entitled to — must not
 * discard the four that worked, and must not fail a sync whose spend and leads
 * are correct. The failure is returned and lands on the `sync_run`, so it is
 * visible rather than silent.
 */
async function syncAccountBreakdowns(
  client: Client,
  account: MetaAdAccount,
  since: string,
  until: string,
): Promise<{ rowsWritten: number; failures: string[] }> {
  const meta = metaClientForAccount(account, client.agencyId);
  const tz = client.timezone;
  let rowsWritten = 0;
  const failures: string[] = [];

  for (const spec of META_BREAKDOWNS) {
    try {
      const rows = await meta.getBreakdownInsights(
        account.adAccountId,
        since,
        until,
        spec,
      );

      for (const raw of rows) {
        const parsed = parseInsightRow(raw);
        const values = {
          clientId: client.id,
          metaAdAccountId: account.adAccountId,
          // Daily granularity: start == end. Any date range aggregates from
          // these; period-only rows would leave the date picker inert here.
          dateStart: parsed.dateKey,
          dateEnd: parsed.dateKey,
          level: "account" as const,
          metaCampaignId: "",
          breakdownKey: spec.key,
          segmentValue: segmentLabel(spec, raw),

          impressions: parsed.impressions,
          clicksAll: parsed.clicksAll,
          linkClicks: parsed.linkClicks,
          spend: String(parsed.spend),
          leadsTotal: parsed.leadsTotal,
          // Valid for THIS segment on THIS day only. The read side refuses to
          // sum it, exactly as it refuses to sum daily reach.
          reach: parsed.reach,

          isProvisional: isProvisional(parsed.dateKey, tz),
          syncedAt: new Date(),
        };

        await db
          .insert(fbBreakdownMetrics)
          .values(values)
          .onConflictDoUpdate({
            target: [
              fbBreakdownMetrics.clientId,
              fbBreakdownMetrics.metaAdAccountId,
              fbBreakdownMetrics.dateStart,
              fbBreakdownMetrics.dateEnd,
              fbBreakdownMetrics.level,
              fbBreakdownMetrics.metaCampaignId,
              fbBreakdownMetrics.breakdownKey,
              fbBreakdownMetrics.segmentValue,
            ],
            set: values,
          });
        rowsWritten++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[meta] ${spec.key} breakdown failed`, message);
      failures.push(`${spec.key}: ${message.slice(0, 200)}`);
    }
  }

  return { rowsWritten, failures };
}

/**
 * Resolve ads to the creative each shows, and store it — the ads named in
 * `opts.adIds`, or every ad in the account.
 *
 * Returns ad id → creative identity so the ad-level insights pass can stamp it
 * onto each metrics row.
 *
 * Video durations are fetched for the videos we have not already measured —
 * they never change, so re-reading them nightly would be pure API budget spent
 * on a constant. They exist solely to keep hold rate honest: ThruPlay changes
 * definition at 15 seconds, so a benchmark without a length is a benchmark
 * against the wrong thing.
 */
async function syncAccountCreatives(
  client: Client,
  account: MetaAdAccount,
  opts: { statuses?: readonly string[]; adIds?: readonly string[] } = {},
): Promise<CreativeMap> {
  if (opts.adIds?.length === 0) return new Map();
  const meta = metaClientForAccount(account, client.agencyId);
  const ads = await meta.getAds(account.adAccountId, opts);

  const resolved = ads.map((ad) => ({ ad, creative: resolveCreative(ad.creative) }));

  // Durations we already hold — a video's length is immutable, so this is a
  // one-time cost per asset rather than a nightly one.
  const known = await db
    .select({
      videoId: metaAdCreatives.videoId,
      len: metaAdCreatives.videoLengthSeconds,
    })
    .from(metaAdCreatives)
    .where(eq(metaAdCreatives.clientId, client.id));
  const haveLength = new Set(
    known.filter((k) => k.videoId && k.len !== null).map((k) => k.videoId as string),
  );

  const missing = resolved
    .map((r) => r.creative.videoId)
    .filter((v): v is string => typeof v === "string" && v !== "" && !haveLength.has(v));
  const lengths = missing.length > 0 ? await meta.getVideoLengths(missing) : new Map();
  const knownLen = new Map(
    known
      .filter((k) => k.videoId && k.len !== null)
      .map((k) => [k.videoId as string, Number(k.len)]),
  );

  const out: CreativeMap = new Map();

  for (const { ad, creative } of resolved) {
    const videoLength = creative.videoId
      ? (lengths.get(creative.videoId) ?? knownLen.get(creative.videoId) ?? null)
      : null;

    const values = {
      clientId: client.id,
      metaAdAccountId: account.adAccountId,
      metaAdId: ad.id,
      adName: ad.name ?? null,
      metaAdsetId: ad.adset_id ?? null,
      metaCampaignId: ad.campaign_id ?? null,
      metaCreativeId:
        typeof ad.creative?.id === "string" ? (ad.creative.id as string) : null,
      creativeKey: creative.key,
      creativeType: creative.type,
      imageHash: creative.imageHash,
      videoId: creative.videoId,
      videoLengthSeconds: videoLength === null ? null : String(videoLength),
      title: creative.title,
      body: creative.body,
      callToActionType: creative.callToActionType,
      linkUrl: creative.linkUrl,
      thumbnailUrl: creative.thumbnailUrl,
      status: ad.status ?? null,
      /*
       * Learning state, from the ad set. A correctness input for keep/kill
       * rather than a decoration: an ad set still in LEARNING has not reached
       * its steady-state cost per result, so recommending a kill on its current
       * numbers is exactly the wrong call.
       */
      learningStage: ad.adset?.learning_stage_info?.status ?? null,
      raw: ad as object,
      syncedAt: new Date(),
    };

    await db
      .insert(metaAdCreatives)
      .values(values)
      .onConflictDoUpdate({
        target: [metaAdCreatives.clientId, metaAdCreatives.metaAdId],
        /*
         * `raw` merged, not replaced: a listing run without the preview link
         * (Meta refused the field) must not erase the link stored before. An
         * ad Meta lists is not gone, whatever an earlier lookup concluded.
         */
        set: {
          ...values,
          raw: sql`(COALESCE(${metaAdCreatives.raw}, '{}'::jsonb) - 'gone_at') || excluded.raw`,
        },
      });

    out.set(ad.id, { key: creative.key, type: creative.type });
  }

  /*
   * Learning is the ad set's state, stored on each of its ads — and the syncs
   * now list only the ads that delivered. Carry what Meta just said onto the
   * set's other ads too, or an ad that stopped weeks ago would keep its old
   * "LEARNING" and hold the whole campaign out of keep/kill long after the set
   * exited learning (`getLearningCampaigns`).
   */
  const stages = new Map<string, string | null>();
  for (const { ad } of resolved) {
    if (ad.adset_id) stages.set(ad.adset_id, ad.adset?.learning_stage_info?.status ?? null);
  }
  if (stages.size > 0) {
    const rows = [...stages].map(([set, stage]) => sql`(${set}::text, ${stage}::text)`);
    await db.execute(sql`
      UPDATE meta_ad_creatives AS c SET learning_stage = v.stage
      FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(adset_id, stage)
      WHERE c.client_id = ${client.id}
        AND c.meta_adset_id = v.adset_id
        AND c.learning_stage IS DISTINCT FROM v.stage
    `);
  }

  return out;
}

type CreativeMap = Map<string, { key: string; type: CreativeType }>;

/** Ad ids in a window's insights → the creative to stamp on each one's rows. */
type CreativeResolver = (adIds: string[]) => Promise<CreativeMap>;

/**
 * Resolves the ads a window delivered — by id, never by listing the account.
 *
 * Listing every ad was what Meta refused: a large account lists thousands that
 * will never deliver again, each with its whole creative attached. By id it is
 * exactly the ads with rows to write, fifty to a request. The ones Meta's
 * default listing leaves out are asked for again as ARCHIVED — an ad archived
 * after it ran still has spend to report, and before this its rows lost their
 * creative every night ("Not attributable to one asset"). What neither listing
 * returns (deleted) keeps the creative stored for it.
 *
 * `failures`: collect what went wrong instead of throwing, and fall back to
 * the stored creatives — the nightly sync, which pulls these days again
 * tomorrow. Without it a failure throws, so the history import stops on the
 * month instead of filing it as done with its ads unnamed.
 *
 * Ads already resolved by this resolver are not asked for again — a window
 * split in halves, the months of one import, and the night's refresh of stale
 * ads share their ads. An ad in neither listing is marked `gone_at` on its
 * stored row, which takes it out of `refreshStaleCreatives`' queue.
 */
function creativeResolver(
  client: Client,
  account: MetaAdAccount,
  opts: { failures?: string[] } = {},
): CreativeResolver {
  const asked = new Set<string>();
  const resolved: CreativeMap = new Map();
  return async (adIds) => {
    const stored = await storedCreativeMap(client.id);
    const ask = adIds.filter((id) => !asked.has(id));
    try {
      const found = await syncAccountCreatives(client, account, { adIds: ask });
      // Kept before the second lookup: those rows are already stored, and a
      // failed ARCHIVED lookup must not cost this write their creatives.
      for (const [id, c] of found) resolved.set(id, c);
      const left = ask.filter((id) => !found.has(id));
      const archived = await syncAccountCreatives(client, account, { adIds: left, statuses: ["ARCHIVED"] });
      for (const [id, c] of archived) resolved.set(id, c);
      for (const id of ask) asked.add(id);
      const gone = left.filter((id) => !archived.has(id));
      if (gone.length > 0) {
        await db.execute(sql`
          UPDATE meta_ad_creatives
          SET raw = COALESCE(raw, '{}'::jsonb) || jsonb_build_object('gone_at', now())
          WHERE client_id = ${client.id}
            AND meta_ad_id IN (${sql.join(gone.map((id) => sql`${id}`), sql`, `)})
        `);
      }
    } catch (err) {
      if (!opts.failures) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[meta] creatives not listed for ${account.adAccountId}`, message);
      opts.failures.push(`${account.adAccountId}: ${message.slice(0, 200)}`);
    }
    return new Map([...stored, ...resolved]);
  };
}

/** A failure to look up the ads' creatives — not a sign the insights window was too big. */
class CreativeLookupError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "CreativeLookupError";
  }
}

/** Stored ads not re-read for this long are — well inside the ~2 weeks Meta's signed image URLs live. */
const STALE_CREATIVE_DAYS = 7;
/** Stale ads re-read per account per night, on top of the ones that delivered. */
const STALE_CREATIVE_CAP = 250;
/**
 * How far back an ad can still be on screen: the longest report range, opened
 * late through the longest-lived share link (90 days, `SHARE_TTL_DAYS` in
 * lib/share.ts — not imported, it would pull the Board into the sync; a test
 * pins the two together).
 */
export const CREATIVE_HORIZON_DAYS = MAX_RANGE_DAYS + 90;

/**
 * Re-read stored ads that stopped delivering, a capped batch a night.
 *
 * The nightly once listed every ad in the account, which kept each stored
 * thumbnail URL alive — Meta signs them for about two weeks. It now asks only
 * for the ads that delivered, so an ad that stopped would keep a dead URL, and
 * a share link or PDF of an older range (which never asks Meta for a fresh one)
 * would print its card without a picture. Old ads stored before preview links
 * existed get theirs the same way.
 *
 * Only ads with ad-level rows inside `CREATIVE_HORIZON_DAYS` are worth it — an
 * ad no report can show needs no picture. Oldest first, `STALE_CREATIVE_CAP` a
 * night: a large account's backlog clears over a few nights, then keeps up.
 * Failures are collected, never thrown: this is upkeep, not the sync.
 */
async function refreshStaleCreatives(
  client: Client,
  account: MetaAdAccount,
  resolve: CreativeResolver,
  failures: string[],
): Promise<void> {
  try {
    const res = await db.execute(sql`
      WITH recent AS (
        SELECT DISTINCT meta_ad_id
        FROM fb_daily_metrics
        WHERE client_id = ${client.id}
          AND meta_ad_account_id = ${account.adAccountId}
          AND level = 'ad'
          AND meta_ad_id <> ''
          AND date >= (CURRENT_DATE - ${CREATIVE_HORIZON_DAYS}::int)
      )
      SELECT c.meta_ad_id AS ad_id
      FROM meta_ad_creatives c
      JOIN recent r ON r.meta_ad_id = c.meta_ad_id
      WHERE c.client_id = ${client.id}
        AND c.synced_at < now() - make_interval(days => ${STALE_CREATIVE_DAYS}::int)
        AND NOT (COALESCE(c.raw, '{}'::jsonb) ? 'gone_at')
      ORDER BY c.synced_at ASC
      LIMIT ${STALE_CREATIVE_CAP}
    `);
    const ids = (res as unknown as { rows: Array<{ ad_id: string }> }).rows.map((r) => r.ad_id);
    if (ids.length > 0) await resolve(ids);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[meta] stale creatives not refreshed for ${account.adAccountId}`, message);
    failures.push(`${account.adAccountId}: ${message.slice(0, 200)}`);
  }
}

/**
 * Give unnamed ad rows the creative their ad is now known by.
 *
 * A row is written with an empty key when its ad could not be resolved at the
 * time — Meta would not list it that night, or (before 25 Oct 2026) it was an
 * archived ad the nightly never asked about. The nightly only rewrites its own
 * 28 days, so without this an older row stayed under "Not attributable to one
 * asset" for good. Only rows that are empty for want of an answer
 * (`creative_type = 'unknown'`) — a Dynamic Creative ad's empty key is the
 * right one, and stays.
 */
async function rekeyUnnamedAdRows(clientId: string): Promise<void> {
  await db.execute(sql`
    UPDATE fb_daily_metrics AS m
    SET creative_key = c.creative_key, creative_type = c.creative_type
    FROM meta_ad_creatives AS c
    WHERE m.client_id = ${clientId}
      AND c.client_id = m.client_id
      AND c.meta_ad_id = m.meta_ad_id
      AND m.level = 'ad'
      AND m.creative_key = ''
      AND m.creative_type = 'unknown'
      AND c.creative_key <> ''
  `);
}

/**
 * Cache reach for one account over one period, as a single query.
 *
 * Kept separate from the daily sync precisely because reach cannot be derived
 * from daily rows — see the note on `fbPeriodReach`. Note reach also cannot be
 * summed ACROSS accounts (one person reached by two accounts is one person), so
 * it is stored per account and the dashboard treats a multi-account total as
 * unavailable rather than adding them.
 */
export async function syncAccountPeriodReach(
  client: Client,
  account: MetaAdAccount,
  since: string,
  until: string,
): Promise<number> {
  const meta = metaClientForAccount(account, client.agencyId);
  // ACCOUNT-level, not campaign-level: reach is deduplicated people and cannot be
  // summed across campaigns, so we store the one true account total (campaign id
  // "") that the read side can trust. A per-campaign pull produced rows the reader
  // could only pick from arbitrarily, understating reach.
  const rows = await meta.getPeriodReach(account.adAccountId, since, until, "account");

  let written = 0;
  for (const r of rows) {
    const values = {
      clientId: client.id,
      metaAdAccountId: account.adAccountId,
      periodStart: since,
      periodEnd: until,
      metaCampaignId: r.campaignId,
      reach: r.reach,
      frequency: String(r.frequency),
      syncedAt: new Date(),
    };
    await db
      .insert(fbPeriodReach)
      .values(values)
      .onConflictDoUpdate({
        target: [
          fbPeriodReach.clientId,
          fbPeriodReach.metaAdAccountId,
          fbPeriodReach.periodStart,
          fbPeriodReach.periodEnd,
          fbPeriodReach.metaCampaignId,
        ],
        set: values,
      });
    written++;
  }
  return written;
}

/**
 * Backfill historical daily metrics, chunked by month.
 *
 * Chunked rather than one big call to stay under Meta's row limits and so a
 * throttle mid-way loses only the current chunk. Meta retains at most 37 months.
 */
export async function backfillClientMetrics(
  client: Client,
  days = 90,
): Promise<number> {
  const [run] = await db
    .insert(syncRuns)
    .values({ clientId: client.id, kind: "meta_backfill", status: "running" })
    .returning({ id: syncRuns.id });

  try {
    const tz = client.timezone;
    const window = trailingWindowInclusive(days, tz);
    let total = 0;

    // Walk month-sized chunks from the start of the window to today.
    let cursor = window.startKey;
    let guard = 0;
    while (cursor <= window.endKey && guard++ < 60) {
      const [y, m] = cursor.split("-").map(Number);
      const lastOfMonth = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const chunkEnd = lastOfMonth < window.endKey ? lastOfMonth : window.endKey;

      const { rowsWritten } = await syncClientMetrics(client, {
        since: cursor,
        until: chunkEnd,
      });
      total += rowsWritten;

      const next = new Date(Date.UTC(y, m, 1));
      cursor = next.toISOString().slice(0, 10);
      // Meta warns that firing several queries at once invites throttling.
      await new Promise((r) => setTimeout(r, 500));
    }

    await db
      .update(syncRuns)
      .set({ status: "success", finishedAt: new Date(), rowsWritten: total })
      .where(eq(syncRuns.id, run.id));
    return total;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(syncRuns)
      .set({ status: "failed", finishedAt: new Date(), error: message })
      .where(eq(syncRuns.id, run.id));
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Ad-level history import
 * ------------------------------------------------------------------ */

/** One calendar month of an import window, clipped to the window. */
export interface ImportMonth {
  /** "YYYY-MM". */
  month: string;
  since: string;
  until: string;
}

/**
 * The window's months, NEWEST first — the months a report reads first are the
 * ones that should land first — and only those before `before` (a day key), so
 * a resumed import picks up where the last request stopped.
 */
export function planMonths(window: { startKey: string; endKey: string }, before?: string): ImportMonth[] {
  const out: ImportMonth[] = [];
  let cursor = window.startKey;
  let guard = 0;
  while (cursor <= window.endKey && guard++ < 60) {
    const [y, m] = cursor.split("-").map(Number);
    const lastOfMonth = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    out.push({
      month: cursor.slice(0, 7),
      since: cursor,
      until: lastOfMonth < window.endKey ? lastOfMonth : window.endKey,
    });
    cursor = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  }
  out.reverse();
  return before ? out.filter((x) => x.since < before) : out;
}

export interface AdLevelImportResult {
  /** Every month of the window is now complete. */
  done: boolean;
  /** Where the next request carries on (months before this day), or null when done. */
  nextBefore: string | null;
  months: Array<{ month: string; status: "imported" | "complete"; rows: number }>;
  rowsWritten: number;
}

/**
 * Meta asking for less, or our own refusal to truncate — both mean "ask for a
 * shorter window". Not when it was the creative lookup that failed: halving the
 * window would re-pull the same insights to ask for the same ads.
 */
function isTooMuchData(err: unknown): boolean {
  if (err instanceof CreativeLookupError) return false;
  const message = err instanceof Error ? err.message : String(err);
  return isReduceDataError(err) || /exceeded [\d,]+ rows/i.test(message);
}

function addDays(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(since: string, until: string): number {
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * Ad-level insights for one window, halving it when Meta says it is too much —
 * a large account's month of ads can exceed one response. Down to a week; a
 * week Meta still refuses is a real failure and is thrown.
 */
async function pullAdLevel(
  client: Client,
  account: MetaAdAccount,
  since: string,
  until: string,
  creatives: CreativeResolver,
): Promise<number> {
  try {
    return await syncAccountMetrics(client, account, since, until, client.timezone, "ad", creatives);
  } catch (err) {
    const days = daysBetween(since, until);
    if (!isTooMuchData(err) || days <= 7) throw err;
    const mid = addDays(since, Math.floor(days / 2) - 1);
    return (
      (await pullAdLevel(client, account, since, mid, creatives)) +
      (await pullAdLevel(client, account, addDays(mid, 1), until, creatives))
    );
  }
}

/** Spend by level for one window: a month whose ad rows already add up to its campaign rows is done. */
async function monthIsComplete(clientId: string, since: string, until: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(spend) FILTER (WHERE level = 'campaign'), 0)::float AS campaign,
           COALESCE(SUM(spend) FILTER (WHERE level = 'ad'), 0)::float AS ad
    FROM fb_daily_metrics
    WHERE client_id = ${clientId} AND date >= ${since} AND date <= ${until}
  `);
  const row = (res as unknown as { rows: Array<{ campaign: number; ad: number }> }).rows[0];
  const campaign = Number(row?.campaign) || 0;
  const ad = Number(row?.ad) || 0;
  return campaign > 0 && Math.abs(ad - campaign) <= campaign * 0.005;
}

/** Ad id → creative identity, from what earlier syncs stored. */
async function storedCreativeMap(clientId: string): Promise<CreativeMap> {
  const rows = await db
    .select({
      adId: metaAdCreatives.metaAdId,
      key: metaAdCreatives.creativeKey,
      type: metaAdCreatives.creativeType,
    })
    .from(metaAdCreatives)
    .where(eq(metaAdCreatives.clientId, clientId));
  return new Map(rows.map((r) => [r.adId, { key: r.key ?? "", type: r.type ?? "unknown" }]));
}

/**
 * Import ad-level history — what creative cards, ad tables and every per-ad
 * stat read — for a window the nightly sync never reached.
 *
 * Campaign history is imported by `backfillClientMetrics`; ad rows only ever
 * came from the nightly 28-day reconcile, so before this a report on last
 * quarter's creatives had nothing to show. One request does as many months as
 * fit in `budgetMs` (a route has 300s) and says where to carry on; months whose
 * ad rows already add up to their campaign rows are skipped in a single query,
 * so pressing the button again resumes rather than starting over.
 *
 * Each month names its own ads: the ones it delivered are asked for by id,
 * archived ones included (Meta's default listing leaves them out), so old
 * months name their ads without listing an account's thousands up front — the
 * listing Meta refused for two large clients. It writes no `sync_runs` row: an
 * import that fails on a month from last year must not turn the client's Meta
 * pipe red for the sync that is working fine.
 */
export async function importMetaAdLevelHistory(
  client: Client,
  opts: { days: number; before?: string; budgetMs?: number },
): Promise<AdLevelImportResult> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 180_000;
  const accounts = await activeAdAccounts(client.id);
  if (accounts.length === 0) throw new Error("Client has no Meta ad account configured");

  const months = planMonths(trailingWindowInclusive(opts.days, client.timezone), opts.before);
  const creatives = new Map(accounts.map((a) => [a.id, creativeResolver(client, a)]));

  const done: AdLevelImportResult["months"] = [];
  let rowsWritten = 0;
  /*
   * Each request ends by naming the rows earlier syncs left unnamed — months
   * already complete included, which this import skips without reading. Best
   * effort: the months it imported are written either way.
   */
  const finish = async (result: AdLevelImportResult) => {
    await rekeyUnnamedAdRows(client.id).catch((err: unknown) => {
      console.warn(`[meta] unnamed ad rows not re-keyed for ${client.slug}:`, err instanceof Error ? err.message : err);
    });
    return result;
  };
  for (const m of months) {
    if (Date.now() - started > budget) {
      // The next request starts with this month: every month it covers begins before the day after it.
      return finish({ done: false, nextBefore: addDays(m.until, 1), months: done, rowsWritten });
    }
    if (await monthIsComplete(client.id, m.since, m.until)) {
      done.push({ month: m.month, status: "complete", rows: 0 });
      continue;
    }
    let rows = 0;
    for (const account of accounts) {
      rows += await pullAdLevel(client, account, m.since, m.until, creatives.get(account.id)!);
    }
    rowsWritten += rows;
    done.push({ month: m.month, status: "imported", rows });
    // Meta warns that firing queries back to back invites throttling.
    await new Promise((r) => setTimeout(r, 300));
  }
  return finish({ done: true, nextBefore: null, months: done, rowsWritten });
}

/**
 * Stale-while-revalidate entry point, called on dashboard load.
 *
 * Returns immediately if data is fresh. Otherwise takes a Postgres advisory
 * lock and syncs TODAY only — a fast single-day pull, not the full window — so
 * the page never blocks. The lock means ten people opening the same dashboard
 * trigger one sync, not ten.
 */
export async function refreshIfStale(client: Client): Promise<boolean> {
  const fresh =
    client.lastSyncedAt &&
    Date.now() - client.lastSyncedAt.getTime() < STALE_AFTER_MS;
  if (fresh) return false;

  // Nothing to refresh if the client has no ad accounts yet.
  const accounts = await activeAdAccounts(client.id);
  if (accounts.length === 0) return false;

  // A TRANSACTION-scoped advisory lock, not a session-scoped one. The old
  // pg_try_advisory_lock + pg_advisory_unlock ran as two separate statements on
  // a connection pool, so the unlock could land on a different connection than
  // the one holding the lock — silently failing and wedging this client's
  // intraday refresh until the idle connection closed. pg_advisory_xact_lock is
  // bound to the transaction and released automatically (same connection) when it
  // ends, so it cannot leak.
  const lockKey = hashToInt(client.id);
  try {
    return await db.transaction(async (tx) => {
      const { rows } = (await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${lockKey}) AS locked`,
      )) as unknown as { rows: Array<{ locked: boolean }> };
      if (!rows[0]?.locked) return false;
      const today = todayKey(client.timezone);
      await syncClientMetrics(client, {
        since: today,
        until: today,
        intraday: true,
      });
      return true;
    });
  } catch (err) {
    console.error(`[meta] refresh failed for ${client.slug}:`, err);
    return false;
  }
}

/** Stable 32-bit key from a uuid, for pg advisory locks. */
function hashToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}

/**
 * Mark abandoned `sync_runs` rows as failed.
 *
 * A run can only end three ways: success, a caught error, or the process being
 * killed. The third writes no terminal status — `syncClientMetrics` updates the
 * row inside `try`/`catch`, and a hard timeout at the route's `maxDuration` runs
 * neither branch. The row then sits in `running` forever, and the health
 * checklist reads a stale "in progress" instead of the failure it was.
 *
 * Nothing can legitimately outlive the route's own 300s ceiling, so anything
 * older than this cutoff was killed. Called at the top of each cron run.
 */
export async function reapAbandonedSyncRuns(
  olderThanMinutes = 30,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const reaped = await db
    .update(syncRuns)
    .set({
      status: "failed",
      finishedAt: new Date(),
      error: `abandoned — no terminal status recorded within ${olderThanMinutes}m (process killed mid-run)`,
    })
    .where(and(eq(syncRuns.status, "running"), lt(syncRuns.startedAt, cutoff)))
    .returning({ id: syncRuns.id });
  return reaped.length;
}

/**
 * How long each client's Meta reconcile usually takes, in ms: the longest of its
 * last three successful runs in the past fortnight. The longest, so a slow night
 * is planned for. The cron uses it to avoid starting a client it cannot finish
 * before the function is killed (see `fitsBeforeDeadline`). A client with no
 * recent success is absent, and the caller assumes a default.
 */
export async function usualMetaRunMs(): Promise<Map<string, number>> {
  const result = await db.execute<{ client_id: string; ms: number }>(sql`
    SELECT client_id, max(extract(epoch FROM finished_at - started_at) * 1000)::float AS ms
      FROM (SELECT client_id, started_at, finished_at,
                   row_number() OVER (PARTITION BY client_id ORDER BY started_at DESC) AS n
              FROM sync_runs
             WHERE kind = 'meta_daily' AND status = 'success'
               AND finished_at IS NOT NULL
               AND started_at > now() - interval '14 days') recent
     WHERE n <= 3
     GROUP BY client_id
  `);
  return new Map((result.rows ?? []).map((r) => [r.client_id, Number(r.ms)]));
}
