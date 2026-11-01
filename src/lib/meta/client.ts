import { appSecretProof } from "@/lib/crypto";
import { shiftDateKey } from "@/lib/dates";
import type { BreakdownKey } from "@/db/schema";

/**
 * Meta Marketing API client.
 *
 * Version is pinned explicitly on every call. This matters more than it looks:
 * an expired Marketing API version does NOT error — Meta silently falls back to
 * the next oldest usable version, changing behaviour with no signal. Versions
 * last roughly 12 months, so this needs reviewing about twice a year.
 */

const DEFAULT_VERSION = "v25.0";

export function metaVersion(): string {
  return process.env.META_API_VERSION || DEFAULT_VERSION;
}

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "MetaApiError";
  }

  /** Throttling responses worth backing off and retrying. */
  get isRateLimit(): boolean {
    return (
      this.code === 4 ||
      this.code === 17 ||
      this.code === 32 ||
      this.code === 613 ||
      this.code === 80000 ||
      this.code === 80004
    );
  }
}

/** Fields Meta returns as JSON strings that we want as numbers. */
function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export interface MetaAdAccount {
  id: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  timezone_offset_hours_utc?: number;
  account_status?: number;
}

/**
 * One row of `/me/adaccounts`.
 *
 * `account_id` rather than `id`: this edge returns both, where `id` carries the
 * `act_` prefix and `account_id` is the bare number. The bare form is what
 * `meta_ad_accounts.ad_account_id` stores, so taking it directly avoids a strip
 * that someone would eventually forget.
 */
export interface MetaAdAccountSummary {
  account_id: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  /** 1 = active. Meta documents several other states; 1 is the only "usable" one. */
  account_status?: number;
}

export interface MetaAction {
  action_type: string;
  value?: string;
  [k: string]: unknown;
}

export interface MetaInsightRow {
  date_start: string;
  date_stop: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  account_currency?: string;
  reach?: string;
  frequency?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  inline_link_clicks?: string;
  inline_link_click_ctr?: string;
  spend?: string;
  actions?: MetaAction[];
  outbound_clicks?: MetaAction[];
  /* Video metrics arrive as action ARRAYS, not scalars — each is a list of
   * `{action_type, value}` and the useful entry is `video_view`. */
  video_play_actions?: MetaAction[];
  video_thruplay_watched_actions?: MetaAction[];
  video_p25_watched_actions?: MetaAction[];
  video_p50_watched_actions?: MetaAction[];
  video_p75_watched_actions?: MetaAction[];
  video_p95_watched_actions?: MetaAction[];
  video_p100_watched_actions?: MetaAction[];
  quality_ranking?: string;
  engagement_rate_ranking?: string;
  conversion_rate_ranking?: string;
  [k: string]: unknown;
}

export type InsightLevel = "account" | "campaign" | "adset" | "ad";

/**
 * One native Lead Ad submission, ids only.
 *
 * Every field is optional because Meta omits rather than nulls: an ad deleted
 * since the lead came in can return a row with no `ad_id` at all.
 */
export interface MetaLeadgenRow {
  id?: string;
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  form_id?: string;
  created_time?: string;
}

/** One ad from `/act_X/ads`, with its creative expanded inline. */
export interface MetaAdRow {
  id: string;
  name?: string;
  status?: string;
  adset_id?: string;
  campaign_id?: string;
  /** Facebook's shareable preview of the ad (`fb.me/…`); opening it needs a Facebook login. */
  preview_shareable_link?: string;
  creative?: Record<string, unknown>;
  adset?: {
    id?: string;
    name?: string;
    /** `{ learning_stage_info: { status: "LEARNING" | "SUCCESS", ... } }` */
    learning_stage_info?: { status?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Fields every level needs. */
const BASE_INSIGHT_FIELDS = [
  "campaign_id",
  "campaign_name",
  "account_currency",
  "reach",
  "frequency",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "inline_link_clicks",
  "inline_link_click_ctr",
  "spend",
  "actions",
];

/**
 * The delivery rankings, named apart because they are the costly part of an
 * ad-level request: see `getDailyInsights`.
 */
export const RANKING_FIELDS = [
  "quality_ranking",
  "engagement_rate_ranking",
  "conversion_rate_ranking",
] as const;

/**
 * Extra fields that only exist, or only mean anything, below campaign level.
 *
 * Requested only for `adset`/`ad` on purpose. Meta charges the same either way,
 * but the delivery rankings are ad-level-only and return `UNKNOWN` above it —
 * asking for them everywhere would put a meaningless "unknown" ranking on every
 * campaign row, which reads as a real diagnostic rather than a wrong question.
 */
const AD_INSIGHT_FIELDS = [
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "outbound_clicks",
  "video_play_actions",
  "video_thruplay_watched_actions",
  "video_p25_watched_actions",
  "video_p50_watched_actions",
  "video_p75_watched_actions",
  "video_p95_watched_actions",
  "video_p100_watched_actions",
  ...RANKING_FIELDS,
];

/* ------------------------------------------------------------------ *
 * Audience breakdowns
 * ------------------------------------------------------------------ */

/**
 * The five breakdowns worth pulling, and how each maps onto Meta's parameters.
 *
 * `region` is first among equals for a local service business: clicks forty
 * miles outside the service area are usually the single largest silent waste in
 * an account, and nothing at campaign level can reveal them.
 */
export interface MetaBreakdownSpec {
  key: BreakdownKey;
  /** The literal `breakdowns` query parameter. */
  apiBreakdowns: string;
  /** Fields on the returned row that carry the segment, in label order. */
  segmentFields: readonly string[];
}

export const META_BREAKDOWNS: readonly MetaBreakdownSpec[] = [
  { key: "age", apiBreakdowns: "age", segmentFields: ["age"] },
  { key: "gender", apiBreakdowns: "gender", segmentFields: ["gender"] },
  { key: "region", apiBreakdowns: "region", segmentFields: ["region"] },
  {
    // The one documented combination in use. Splitting these apart would lose
    // "Instagram Reels" as a unit and leave only "Instagram, somewhere".
    key: "placement",
    apiBreakdowns: "publisher_platform,platform_position",
    segmentFields: ["publisher_platform", "platform_position"],
  },
  { key: "device", apiBreakdowns: "impression_device", segmentFields: ["impression_device"] },
] as const;

/**
 * Reach IS requested here, unlike in `getDailyInsights`.
 *
 * It is meaningful for a single segment on a single day and is stored as such —
 * but it is not additive across segments or days, so the read side returns null
 * for any aggregate rather than summing it. One person reached on both Facebook
 * and Instagram is counted once in each placement row and once overall; adding
 * the rows double-counts them.
 */
const BREAKDOWN_FIELDS = [
  "impressions",
  "clicks",
  "spend",
  "reach",
  "actions",
].join(",");

/** A breakdown row: the base metrics plus whichever segment fields were asked for. */
export type MetaBreakdownRow = MetaInsightRow & Record<string, unknown>;

/**
 * Meta's raw segment values, made readable without losing meaning.
 *
 * `unknown` is preserved rather than dropped or relabelled: Meta genuinely
 * cannot classify some impressions, and silently folding them into a real
 * segment would overstate that segment.
 */
export function segmentLabel(
  spec: MetaBreakdownSpec,
  row: Record<string, unknown>,
): string {
  const parts = spec.segmentFields
    .map((f) => (typeof row[f] === "string" ? (row[f] as string) : ""))
    .filter((v) => v !== "");
  if (parts.length === 0) return "unknown";
  return parts.map(prettySegment).join(" · ");
}

const SEGMENT_WORDS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  audience_network: "Audience Network",
  messenger: "Messenger",
  threads: "Threads",
  unknown: "Unknown",
  desktop: "Desktop",
  mobile_app: "Mobile app",
  mobile_web: "Mobile web",
  iphone: "iPhone",
  ipad: "iPad",
  android_smartphone: "Android phone",
  android_tablet: "Android tablet",
  female: "Female",
  male: "Male",
};

function prettySegment(v: string): string {
  const known = SEGMENT_WORDS[v.toLowerCase()];
  if (known) return known;
  // feed → Feed, instagram_reels → Instagram reels, 25-34 → 25-34
  if (/^[a-z0-9_]+$/.test(v)) {
    const spaced = v.replace(/_/g, " ");
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }
  return v;
}

/**
 * Ads Manager's own "Results" for the row, and the campaign objective.
 *
 * `results` is a list of `{ indicator, values: [{ value, attribution_windows }] }`.
 * The indicator names what the ad set optimises for
 * (`actions:offsite_conversion.fb_pixel_lead`), and it is present even on a day
 * with no results — which is what lets a day of spend keep its type. Verified
 * against v25.0 on live accounts, 24 Oct 2026; see `metrics/results.ts`.
 *
 * Optional by construction. If Meta ever refuses either field, the request is
 * retried once without them (`getDailyInsights`): spend and leads must never
 * depend on a field the results feature added.
 */
export const RESULT_INSIGHT_FIELDS = ["results", "objective"] as const;

export function insightFields(
  level: InsightLevel,
  opts: { results?: boolean; rankings?: boolean } = {},
): string {
  let fields: string[] =
    level === "ad" || level === "adset"
      ? [...BASE_INSIGHT_FIELDS, ...AD_INSIGHT_FIELDS]
      : [...BASE_INSIGHT_FIELDS];
  if (opts.results !== false) fields.push(...RESULT_INSIGHT_FIELDS);
  if (opts.rankings === false) {
    fields = fields.filter((f) => !(RANKING_FIELDS as readonly string[]).includes(f));
  }
  return fields.join(",");
}

/**
 * A refusal of one of the optional results fields, as opposed to any other
 * failure. Code 100 is Meta's "invalid parameter"; the message names the field
 * ("Tried accessing nonexisting field (results)", "results is not valid for
 * fields param"). Anything else — a bad token, a rate limit — is rethrown.
 */
export function isResultFieldRefusal(err: unknown): boolean {
  return isFieldRefusal(err, RESULT_INSIGHT_FIELDS);
}

/** Meta refusing one of these optional fields (code 100, the field named), and nothing else. */
export function isFieldRefusal(err: unknown, fields: readonly string[]): boolean {
  if (!(err instanceof MetaApiError) || err.code !== 100) return false;
  return fields.some((f) => new RegExp(`\\b${f}\\b`, "i").test(err.message));
}

/**
 * Meta asking for a smaller request: "Please reduce the amount of data you're
 * asking for, then retry your request" (code 1). Nothing is wrong with the
 * request but its size — a shorter window or a smaller page is the answer.
 */
export function isReduceDataError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /reduce the amount of data/i.test(message);
}

/**
 * Meta giving up on a request too heavy to finish in time. After about 30
 * seconds it answers "An unknown error occurred" (code 1, subcode 99) or
 * "Service temporarily unavailable" (code 2). Both were seen on 2 Nov 2026 for
 * an ad-level request that succeeds when asked for in smaller parts. Not
 * "reduce the amount of data", which names its own cause and has its own path.
 */
export function isMetaTimeout(err: unknown): boolean {
  if (!(err instanceof MetaApiError) || isReduceDataError(err)) return false;
  return (err.code === 1 && err.subcode === 99) || err.code === 2;
}

/** A window as consecutive weeks, the last one short. Date keys are calendar labels, so this is plain arithmetic. */
function weeksOf(since: string, until: string): Array<[string, string]> {
  const weeks: Array<[string, string]> = [];
  for (let from = since; from <= until; from = shiftDateKey(from, 7)) {
    const to = shiftDateKey(from, 6);
    weeks.push([from, to < until ? to : until]);
  }
  return weeks;
}

/** The ad's shareable preview link — optional: the listing never fails for want of it. */
export const PREVIEW_FIELDS = ["preview_shareable_link"] as const;

/**
 * Ads per listing page.
 *
 * 🔴 Not 200. With the creative expansion, a page of 200 ads is a third of a
 * megabyte or more, and from 23 Oct 2026 Meta refused it outright on every
 * account with more than ~150 ads ("reduce the amount of data"), failing two
 * clients' nightly sync for days. 100 was accepted on both; a page Meta still
 * refuses is asked for again at half the size, down to `ADS_MIN_PAGE`.
 */
const ADS_PAGE = 100;
const ADS_MIN_PAGE = 25;
/** Ids per `ad.id IN` filter — kept well inside one page. */
export const ADS_PER_ID_FILTER = 50;
/** The most ads one listing returns before refusing to report a partial list. */
const ADS_LISTING_CAP = 10_000;

/**
 * The creative sub-fields, named once.
 *
 * Shared by the nightly listing and the single-ad re-read behind the preview
 * proxy. Two copies would drift, and the failure would be quiet: a preview
 * resolved from a shorter field list picks a different image than the grid
 * synced, so the card and its thumbnail would slowly stop agreeing.
 */
const CREATIVE_FIELD_EXPANSION =
  "creative{id,image_hash,image_url,video_id,thumbnail_url,title,body,object_story_spec,asset_feed_spec,effective_object_story_id}";

export class MetaClient {
  private readonly token: string;
  private readonly appSecret: string | undefined;

  /**
   * 🔴 Takes a token. It does NOT reach for `META_SYSTEM_USER_TOKEN`.
   *
   * That fallback used to live here, which meant every construction site was a
   * potential use of the shared credential and none of them said so. Deciding
   * whether an agency may use our token is a tenancy question, and it now has
   * exactly one answer, in `shared-credentials.ts`.
   */
  constructor(token: string) {
    if (!token) {
      throw new Error(
        "No Meta access token. Connect a Facebook account for this client.",
      );
    }
    this.token = token;
    this.appSecret = process.env.META_APP_SECRET;
  }

  private async request<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    attempt = 0,
  ): Promise<T> {
    const url = new URL(`https://graph.facebook.com/${metaVersion()}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    url.searchParams.set("access_token", this.token);
    // Documented best practice: hardens against a leaked token being replayed.
    if (this.appSecret) {
      url.searchParams.set(
        "appsecret_proof",
        appSecretProof(this.token, this.appSecret),
      );
    }

    const res = await fetch(url, { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string; code?: number; error_subcode?: number } }
      | null;

    if (!res.ok) {
      const err = new MetaApiError(
        body?.error?.message ?? `Meta ${res.status} on ${path}`,
        res.status,
        body?.error?.code,
        body?.error?.error_subcode,
        body,
      );

      /*
       * Back off on throttling. Meta explicitly warns that firing several
       * queries at once is more likely to trip rate limiting, so we retry
       * serially with exponential backoff rather than racing.
       */
      if (err.isRateLimit && attempt < 4) {
        const waitMs = Math.min(60_000, 2 ** attempt * 2_000);
        await new Promise((r) => setTimeout(r, waitMs));
        return this.request<T>(path, params, attempt + 1);
      }
      throw err;
    }

    await this.readThrottleHeaders(res);
    return body as T;
  }

  /**
   * Watch utilisation and ease off BEFORE the cap trips, not after.
   *
   * Reacting to a 429 recovers a request that already failed; the cheaper move
   * is to notice we are near the ceiling on a *successful* response and pause
   * before the next call. Because per-account calls are serialised, a pause here
   * throttles the whole run — which is exactly the intent. Meta reports these as
   * percentages of allowance (0–100).
   */
  private async readThrottleHeaders(res: Response) {
    const insights = res.headers.get("x-fb-ads-insights-throttle");
    if (!insights) return;
    try {
      const parsed = JSON.parse(insights) as {
        app_id_util_pct?: number;
        acc_id_util_pct?: number;
      };
      const worst = Math.max(
        parsed.app_id_util_pct ?? 0,
        parsed.acc_id_util_pct ?? 0,
      );
      if (worst >= 95) {
        // On the edge of the cap — spend a few seconds now rather than eat a
        // hard block (code 4/17) that stalls the account for minutes.
        console.warn(`[meta] insights throttle at ${worst}% — easing off`);
        await new Promise((r) => setTimeout(r, 5_000));
      } else if (worst >= 80) {
        console.warn(
          `[meta] insights throttle at ${worst}% — approaching the cap`,
        );
      }
    } catch {
      /* header shape drifts; never fail a request over telemetry */
    }
  }

  /** Normalise `act_123` / `123` to the `act_`-prefixed form the API needs. */
  static normalizeAccountId(id: string): string {
    const clean = id.trim().replace(/^act_/i, "");
    // Meta ad-account ids are purely numeric. Enforcing that here — the single
    // point where the id is interpolated into the request path — closes any
    // path-traversal / endpoint-redirect vector at the source.
    if (!/^\d+$/.test(clean)) {
      throw new Error(`Invalid Meta ad account id: "${id}" (must be numeric)`);
    }
    return `act_${clean}`;
  }

  /**
   * Verification call for onboarding. Returns the account's real name,
   * currency, and timezone so a wrong account id is caught immediately rather
   * than producing a silently empty dashboard.
   */
  async getAdAccount(accountId: string): Promise<MetaAdAccount> {
    const act = MetaClient.normalizeAccountId(accountId);
    return this.request<MetaAdAccount>(`/${act}`, {
      fields:
        "id,name,currency,timezone_name,timezone_offset_hours_utc,account_status",
    });
  }

  /**
   * Every ad account this token can reach.
   *
   * The discovery half of "Continue with Facebook": after consent we hold a
   * token but no idea which accounts it opens, and the operator must not be
   * asked to type an id they just authorised. Equivalent to Google's
   * `listAccessibleCustomers`, and simpler — Meta has no manager hierarchy to
   * expand, so one paginated call is the whole tree.
   *
   * 🔴 Paginated, with the same refuse-to-truncate rule as `getAds`. A partial
   * account list is worse than an error here: the missing account looks like one
   * the user does not have access to, so someone re-authorises repeatedly trying
   * to make it appear.
   */
  async listAdAccounts(): Promise<MetaAdAccountSummary[]> {
    const rows: MetaAdAccountSummary[] = [];
    let next: string | undefined;
    let page = 0;

    do {
      /*
       * 🔴 Do NOT add `business` or `owner` here to label which Business
       * Manager each account belongs to. Verified against v25.0 on 2026-08-17:
       * both are gated behind `business_management`, and Meta rejects the
       * WHOLE request with code 100/200 rather than omitting the field — so
       * one extra field turns account discovery into a hard failure. Grouping
       * the picker by Business Manager is not worth requesting a heavier
       * permission that would force App Review.
       */
      const res: { data?: MetaAdAccountSummary[]; paging?: { next?: string } } = next
        ? await this.followCursor(next)
        : await this.request("/me/adaccounts", {
            fields: "account_id,name,currency,timezone_name,account_status",
            limit: 100,
          });
      rows.push(...(res.data ?? []));
      next = res.paging?.next;
    } while (next && ++page < 20);

    if (next) {
      throw new Error(
        "This Facebook account can reach more than 2,000 ad accounts; refusing to show a partial list",
      );
    }
    return rows;
  }

  /**
   * Every ad in the account, with its creative.
   *
   * A SEPARATE call from insights, because insights does not carry creative
   * identity at all — it reports `ad_id` and `ad_name` and nothing about what
   * the ad shows. `image_hash` / `video_id` live only on the creative object,
   * and they are the identity creative reporting has to group by.
   *
   * `object_story_spec` is where a normal ad's asset actually is;
   * `asset_feed_spec` is where a Dynamic Creative ad's is, and it holds LISTS
   * (several images, several videos) which is why such an ad resolves to
   * `carousel` rather than pretending to have one identity.
   */
  /**
   * Resolve one native Lead Ad submission back to the ad that produced it.
   *
   * The only route to attribution for Instant Form leads, which have no landing
   * page and therefore no URL parameters to read ids out of. See
   * `meta/leadgen.ts` for the permission constraint — this call needs
   * `leads_retrieval`, not `ads_read`, and will very likely refuse until that
   * scope is granted.
   *
   * 🔴 `field_data` is deliberately NOT requested. It contains the name, email
   * and phone number the person typed into the form, and nothing in this
   * product needs them — GoHighLevel already holds the contact. Asking for the
   * three ids and the timestamp keeps personal data out of a response we would
   * otherwise have to be careful about logging.
   */
  async getLeadgen(leadId: string): Promise<MetaLeadgenRow> {
    if (!/^\d{6,25}$/.test(leadId)) {
      // The single point where this id is interpolated into a request path.
      throw new Error(`Invalid Meta leadgen id: "${leadId}" (must be numeric)`);
    }
    return this.request<MetaLeadgenRow>(`/${leadId}`, {
      fields: "id,ad_id,adset_id,campaign_id,form_id,created_time",
    });
  }

  /**
   * Ads of the account, with their creative and preview link.
   *
   * `adIds`: only these ads, asked for 50 at a time — what the syncs use, since
   * they need the ads that delivered, and a large account lists thousands that
   * never will again (one client: 1,569 ads, 70 of them delivering). An empty
   * list asks Meta nothing. Without it, every ad in the account.
   *
   * `statuses`: Meta's default listing leaves ARCHIVED ads out (and DELETED
   * cannot be asked for at all), so callers pass ARCHIVED to find the archived
   * ads that still have delivery to report.
   *
   * The preview link is optional: refused, the listing restarts without it, so
   * the creatives sync — and with it every thumbnail — never fails for a link.
   */
  async getAds(
    accountId: string,
    opts: { statuses?: readonly string[]; adIds?: readonly string[] } = {},
  ): Promise<MetaAdRow[]> {
    try {
      return await this.listAdsBy(accountId, opts, true);
    } catch (err) {
      if (!isFieldRefusal(err, PREVIEW_FIELDS)) throw err;
      console.warn(
        `[meta] preview links refused for ${accountId}; listing ads without them:`,
        err instanceof Error ? err.message : err,
      );
      return this.listAdsBy(accountId, opts, false);
    }
  }

  private async listAdsBy(
    accountId: string,
    opts: { statuses?: readonly string[]; adIds?: readonly string[] },
    withPreview: boolean,
  ): Promise<MetaAdRow[]> {
    if (!opts.adIds) return this.listAds(accountId, opts.statuses, withPreview);
    const ids = [...new Set(opts.adIds)];
    for (const id of ids) {
      // Interpolated into the filter: ad ids are purely numeric.
      if (!/^\d{1,25}$/.test(id)) throw new Error(`Invalid Meta ad id: "${id}" (must be numeric)`);
    }
    const rows: MetaAdRow[] = [];
    for (let i = 0; i < ids.length; i += ADS_PER_ID_FILTER) {
      const filter = [{ field: "ad.id", operator: "IN", value: ids.slice(i, i + ADS_PER_ID_FILTER) }];
      rows.push(...(await this.listAds(accountId, opts.statuses, withPreview, filter)));
    }
    return rows;
  }

  /**
   * One listing, page by page on Meta's `after` cursor — followed with our own
   * request rather than the `next` URL, so a page Meta finds too big can be
   * asked for again, smaller, from the same place.
   */
  private async listAds(
    accountId: string,
    statuses: readonly string[] | undefined,
    withPreview: boolean,
    filtering?: unknown,
  ): Promise<MetaAdRow[]> {
    const act = MetaClient.normalizeAccountId(accountId);
    const fields = [
      "id",
      "name",
      "status",
      "adset_id",
      "campaign_id",
      ...(withPreview ? PREVIEW_FIELDS : []),
      // Nested field expansion — one round trip instead of one per ad.
      CREATIVE_FIELD_EXPANSION,
      "adset{id,name,learning_stage_info}",
    ].join(",");
    const rows: MetaAdRow[] = [];
    let limit = ADS_PAGE;
    let after: string | undefined;

    for (;;) {
      let res: { data?: MetaAdRow[]; paging?: { next?: string; cursors?: { after?: string } } };
      try {
        res = await this.request(`/${act}/ads`, {
          fields,
          limit,
          ...(statuses ? { effective_status: JSON.stringify(statuses) } : {}),
          ...(filtering ? { filtering: JSON.stringify(filtering) } : {}),
          ...(after ? { after } : {}),
        });
      } catch (err) {
        if (!isReduceDataError(err) || limit <= ADS_MIN_PAGE) throw err;
        limit = Math.max(ADS_MIN_PAGE, Math.floor(limit / 2));
        continue;
      }
      rows.push(...(res.data ?? []));
      if (!res.paging?.next) return rows;
      after = res.paging.cursors?.after;
      if (!after) {
        throw new Error(
          `Meta ads listing for ${act} gave a next page without a cursor; refusing to report partial creative data`,
        );
      }
      if (rows.length >= ADS_LISTING_CAP) {
        throw new Error(
          `Meta ads listing exceeded ${ADS_LISTING_CAP} rows for ${act}; refusing to report partial creative data`,
        );
      }
    }
  }

  /**
   * One ad's creative, re-read live, purely to mint a working preview URL.
   *
   * Meta's image URLs are signed and expire in about two weeks, so the copy
   * stored at sync time dies long before the ad does. The preview proxy calls
   * this only when the stored URL has actually stopped working — a re-read per
   * card per view would spend the account's whole API budget on pictures.
   */
  async getAdCreative(adId: string): Promise<unknown> {
    const res = await this.request<{ creative?: unknown }>(
      `/${encodeURIComponent(adId)}`,
      { fields: CREATIVE_FIELD_EXPANSION },
    );
    return res.creative ?? null;
  }

  /**
   * Video durations, by id.
   *
   * Needed because ThruPlay means "watched to completion" under 15 seconds and
   * merely "reached 15 seconds" above it, so hold rate cannot be compared
   * across lengths without knowing them. Insights does not expose duration, and
   * the video object is the only source.
   *
   * Batched, and failure-tolerant per id: a video deleted from the library
   * 400s, and one dead asset must not cost us the durations of the rest.
   */
  async getVideoLengths(videoIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const unique = [...new Set(videoIds.filter(Boolean))];

    for (let i = 0; i < unique.length; i += 25) {
      const batch = unique.slice(i, i + 25);
      await Promise.all(
        batch.map(async (id) => {
          try {
            const res = await this.request<{ length?: number | string }>(`/${id}`, {
              fields: "length",
            });
            const len = num(res.length);
            if (len > 0) out.set(id, len);
          } catch {
            /* deleted or inaccessible — no duration, so no length benchmark */
          }
        }),
      );
    }
    return out;
  }

  /**
   * Daily, campaign-level insights over a date range.
   *
   * `use_unified_attribution_setting=true` makes the `actions` figures respect
   * the ad set's attribution setting, which is what reproduces the numbers the
   * client sees in Ads Manager.
   *
   * An ad-level window Meta times out on is asked for again in parts (see
   * `adInsightsInParts`). Campaign level is never split: it is the light request,
   * and a timeout there is an outage, not a size problem.
   */
  async getDailyInsights(
    accountId: string,
    since: string,
    until: string,
    level: InsightLevel = "campaign",
  ): Promise<MetaInsightRow[]> {
    try {
      return await this.withOptionalResults(level, (results) =>
        this.dailyInsights(accountId, since, until, level, insightFields(level, { results })),
      );
    } catch (err) {
      if (level !== "ad" || !isMetaTimeout(err)) throw err;
      console.warn(
        `[meta] ad-level insights for ${since}..${until} timed out at Meta; asking a week at a time, rankings apart:`,
        (err as Error).message,
      );
      return this.adInsightsInParts(accountId, since, until);
    }
  }

  /**
   * Ask with the results fields, and once more without them if Meta refuses
   * them. Loud in the log, quiet for the client: their spend still syncs, and
   * the results widgets say "no results yet" for these days.
   */
  private async withOptionalResults(
    level: InsightLevel,
    pull: (results: boolean) => Promise<MetaInsightRow[]>,
  ): Promise<MetaInsightRow[]> {
    try {
      return await pull(true);
    } catch (err) {
      if (!isResultFieldRefusal(err)) throw err;
      console.warn(
        `[meta] insights refused the results fields at ${level} level; retrying without them:`,
        (err as Error).message,
      );
      return pull(false);
    }
  }

  /**
   * Ad-level insights for a window Meta cannot answer in one request.
   *
   * Measured on a live account, 2 Nov 2026: one week of ad rows WITH the
   * delivery rankings hit Meta's 30-second limit ("An unknown error occurred").
   * The same week without them took 12.6 s, and the rankings alone took 4 s for
   * all 28 days. So the figures are asked for a week at a time without the
   * rankings, the rankings in one request of their own, and the two are joined
   * on ad and day: the same rows the single request would have returned.
   *
   * A ranking is a diagnostic, not a figure. If that request fails as well, the
   * rows are kept without rankings rather than lost. A week that still times out
   * is a real failure and is thrown.
   */
  private async adInsightsInParts(
    accountId: string,
    since: string,
    until: string,
  ): Promise<MetaInsightRow[]> {
    const rows: MetaInsightRow[] = [];
    for (const [from, to] of weeksOf(since, until)) {
      rows.push(
        ...(await this.withOptionalResults("ad", (results) =>
          this.dailyInsights(accountId, from, to, "ad", insightFields("ad", { results, rankings: false })),
        )),
      );
    }

    let ranked: MetaInsightRow[] = [];
    try {
      ranked = await this.dailyInsights(accountId, since, until, "ad", ["ad_id", ...RANKING_FIELDS].join(","));
    } catch (err) {
      console.warn(
        `[meta] delivery rankings unavailable for ${since}..${until}; keeping the rows without them:`,
        (err as Error).message,
      );
    }
    const byAdDay = new Map(ranked.map((r) => [`${r.ad_id}|${r.date_start}`, r]));
    return rows.map((row) => {
      const r = byAdDay.get(`${row.ad_id}|${row.date_start}`);
      return r
        ? {
            ...row,
            quality_ranking: r.quality_ranking,
            engagement_rate_ranking: r.engagement_rate_ranking,
            conversion_rate_ranking: r.conversion_rate_ranking,
          }
        : row;
    });
  }

  private async dailyInsights(
    accountId: string,
    since: string,
    until: string,
    level: InsightLevel,
    fields: string,
  ): Promise<MetaInsightRow[]> {
    const act = MetaClient.normalizeAccountId(accountId);
    const rows: MetaInsightRow[] = [];

    let next: string | undefined;
    let page = 0;
    do {
      const res: { data?: MetaInsightRow[]; paging?: { next?: string } } = next
        ? await this.followCursor(next)
        : await this.request(`/${act}/insights`, {
            level,
            time_increment: 1,
            time_range: JSON.stringify({ since, until }),
            fields,
            use_unified_attribution_setting: true,
            limit: 500,
          });

      rows.push(...(res.data ?? []));
      next = res.paging?.next;
    } while (next && ++page < 100);

    // Fail LOUD rather than return partial spend that reports success. A silent
    // truncation is exactly the wrong-money-looks-fine failure this app exists to
    // prevent — the caller records the sync_run as failed and the health check
    // goes red, instead of the dashboard understating spend on the tail campaigns.
    // The cap is generous (100 × 500 = 50k daily rows); a genuinely larger account
    // needs Meta's async insights job.
    if (next) {
      throw new Error(
        `Meta insights exceeded ${100 * 500} rows for ${act} ${since}..${until}; refusing to report partial data`,
      );
    }

    return rows;
  }

  /**
   * Daily insights split by ONE audience breakdown.
   *
   * Deliberately one breakdown per call. Meta's own documentation says "due to
   * storage constraints, only some permutations of breakdowns are available",
   * and `age`/`gender` appear in no permitted permutation with
   * `publisher_platform` / `platform_position` / `impression_device`. An
   * unlisted pair is a hard 400, so combining them to save a request would trade
   * one round trip for a breakdown that never returns.
   *
   * Account level: the campaign dimension would multiply every segment by the
   * campaign count for a question ("which age group converts") that is
   * account-level by nature.
   */
  async getBreakdownInsights(
    accountId: string,
    since: string,
    until: string,
    breakdown: MetaBreakdownSpec,
  ): Promise<MetaBreakdownRow[]> {
    const act = MetaClient.normalizeAccountId(accountId);
    const rows: MetaBreakdownRow[] = [];

    let next: string | undefined;
    let page = 0;
    do {
      const res: { data?: MetaBreakdownRow[]; paging?: { next?: string } } = next
        ? await this.followCursor(next)
        : await this.request(`/${act}/insights`, {
            level: "account",
            time_increment: 1,
            time_range: JSON.stringify({ since, until }),
            breakdowns: breakdown.apiBreakdowns,
            fields: BREAKDOWN_FIELDS,
            use_unified_attribution_setting: true,
            limit: 500,
          });

      rows.push(...(res.data ?? []));
      next = res.paging?.next;
    } while (next && ++page < 60);

    // Same rule as `getDailyInsights`: a truncated breakdown understates exactly
    // the long tail of segments this feature exists to expose, and would do it
    // while reporting success.
    if (next) {
      throw new Error(
        `Meta ${breakdown.key} breakdown exceeded ${60 * 500} rows for ${act} ${since}..${until}; refusing to report partial data`,
      );
    }

    return rows;
  }

  /**
   * Reach for one whole period, as a single query.
   *
   * MUST NOT be replaced by summing daily reach. Reach counts distinct people
   * inside the queried window: someone who saw an ad on ten days contributes 10
   * to a naive daily sum but 1 to the true figure, overstating it 2–5x on
   * high-frequency campaigns.
   */
  async getPeriodReach(
    accountId: string,
    since: string,
    until: string,
    level: "account" | "campaign" = "campaign",
  ): Promise<Array<{ campaignId: string; reach: number; frequency: number }>> {
    const act = MetaClient.normalizeAccountId(accountId);
    const res = await this.request<{
      data?: MetaInsightRow[];
      paging?: { next?: string };
    }>(`/${act}/insights`, {
      level,
      time_range: JSON.stringify({ since, until }),
      fields: "campaign_id,reach,frequency",
      limit: 500,
    });
    // Account-level reach is a single row, so this never trips in practice. At
    // campaign level an account with >500 campaigns would truncate — and a
    // half-a-reach-table is worse than none, since the read side would treat the
    // partial as authoritative. Fail loud, exactly like getDailyInsights.
    if (res.paging?.next) {
      throw new Error(
        `Meta reach exceeded 500 rows for ${act} ${since}..${until}; refusing to report partial data`,
      );
    }
    return (res.data ?? []).map((r) => ({
      campaignId: r.campaign_id ?? "",
      reach: num(r.reach),
      frequency: num(r.frequency),
    }));
  }

  private async followCursor<T>(cursorUrl: string): Promise<T> {
    // Meta's `paging.next` URL carries the access_token but NOT the
    // appsecret_proof. If the app has "Require app secret proof" enabled, page 1
    // succeeds but every subsequent page 190-fails — silently truncating a large
    // account to its first page. Re-attach the proof on the cursor URL too.
    const url = new URL(cursorUrl);
    if (this.appSecret && !url.searchParams.has("appsecret_proof")) {
      url.searchParams.set(
        "appsecret_proof",
        appSecretProof(this.token, this.appSecret),
      );
    }
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      // Meta's own message, as on the first page: "reduce the amount of data"
      // on page 3 must still read as "ask for a shorter window".
      const body = (await res.json().catch(() => null)) as
        | { error?: { message?: string; code?: number; error_subcode?: number } }
        | null;
      throw new MetaApiError(
        body?.error?.message ?? `Meta pagination failed`,
        res.status,
        body?.error?.code,
        body?.error?.error_subcode,
        body,
      );
    }
    return (await res.json()) as T;
  }
}

/**
 * Extract the metrics we store from one insights row.
 *
 * Two traps handled here:
 *
 *  1. `actions` is SPARSE — zero-activity types are absent entirely, and the
 *     whole key can be missing on a quiet day. Everything defaults to 0 and we
 *     filter by `action_type` rather than indexing positionally.
 *  2. Lead action types NEST. `lead` already contains both
 *     `onsite_conversion.lead_grouped` and `offsite_conversion.fb_pixel_lead`,
 *     so summing the three would double-count — the single most common
 *     lead-reporting bug against this API.
 */
/**
 * Sum an action-array field.
 *
 * Meta returns the video metrics as ARRAYS of `{action_type, value}`, not
 * scalars — `video_thruplay_watched_actions` is a list whose useful entry is
 * `video_view`. The whole key can also be absent when there was no video
 * activity, which is why every read here defaults to 0 rather than indexing
 * positionally into something that may not exist.
 */
function actionSum(field: unknown, type = "video_view"): number {
  if (!Array.isArray(field)) return 0;
  const hit = (field as MetaAction[]).find((a) => a.action_type === type);
  return hit ? num(hit.value) : 0;
}

/** Meta's ranking strings → our enum. `UNKNOWN` survives as itself. */
function ranking(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const t = v.trim().toLowerCase();
  const allowed = new Set([
    "above_average",
    "average",
    "below_average_35",
    "below_average_20",
    "below_average_10",
    "unknown",
  ]);
  return allowed.has(t) ? t : "unknown";
}

export function parseInsightRow(row: MetaInsightRow) {
  const actions = Array.isArray(row.actions) ? row.actions : [];
  const action = (type: string): number => {
    const hit = actions.find((a) => a.action_type === type);
    return hit ? num(hit.value) : 0;
  };

  const linkClicksAttributed = action("link_click");
  const inlineLinkClicks = num(row.inline_link_clicks);

  return {
    dateKey: row.date_start,
    campaignId: row.campaign_id ?? "",
    campaignName: row.campaign_name ?? null,
    adsetId: row.adset_id ?? "",
    adsetName: row.adset_name ?? null,
    adId: row.ad_id ?? "",
    adName: row.ad_name ?? null,
    currency: row.account_currency ?? null,

    reach: num(row.reach),
    impressions: num(row.impressions),
    clicksAll: num(row.clicks),

    /*
     * Prefer the attribution-respecting figure, which matches the Ads Manager
     * "Link clicks" column. `inline_link_clicks` is pinned to a 1-day-click
     * window and reads lower. Fall back to it only when `actions` is absent.
     */
    linkClicks: linkClicksAttributed || inlineLinkClicks,
    inlineLinkClicks,

    spend: num(row.spend),

    leadsTotal: action("lead"),
    leadsPixel: action("offsite_conversion.fb_pixel_lead"),
    leadsOnsite: action("onsite_conversion.lead_grouped"),

    /*
     * HOOK RATE's numerator: 3-second views, from `actions[video_view]`.
     *
     * NOT `video_play_actions`. A "play" counts an autoplay start the viewer
     * never chose — on feed placements, which autoplay by default, that is most
     * impressions, and hook rate computed from plays comes out flattering and
     * meaningless. `video_view` is Meta's 3-second threshold and is the figure
     * every published benchmark is stated against.
     */
    video3sViews: action("video_view"),
    videoPlays: actionSum(row.video_play_actions),

    /*
     * HOLD RATE's numerator. Comparable only within a video-length bucket —
     * see the note on `fbDailyMetrics.thruPlays`.
     */
    thruPlays: actionSum(row.video_thruplay_watched_actions),

    videoP25: actionSum(row.video_p25_watched_actions),
    videoP50: actionSum(row.video_p50_watched_actions),
    videoP75: actionSum(row.video_p75_watched_actions),
    videoP95: actionSum(row.video_p95_watched_actions),
    videoP100: actionSum(row.video_p100_watched_actions),

    /** The click→land leak: people who clicked but never saw the page. */
    landingPageViews: action("landing_page_view"),
    outboundClicks: actionSum(row.outbound_clicks, "outbound_click"),

    qualityRanking: ranking(row.quality_ranking),
    engagementRateRanking: ranking(row.engagement_rate_ranking),
    conversionRateRanking: ranking(row.conversion_rate_ranking),
  };
}

export type ParsedInsight = ReturnType<typeof parseInsightRow>;
