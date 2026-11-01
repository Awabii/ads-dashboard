import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Client } from "@/db/schema";
import { createTestDb, type TestDb } from "@/lib/metrics/__testdb__/harness";
import { todayKey, trailingWindowInclusive } from "@/lib/dates";

/**
 * The ingest run: what gets written, and what the sync_runs row says afterwards.
 *
 * ── Why the bookkeeping matters as much as the numbers ────────────────
 *
 * Almost everything here exists to stop the dashboard LYING about its own
 * freshness. `sync_runs` and the two timestamps on `clients` are what the health
 * checklist reads, and every rule below was written because some combination of
 * them could report a healthy pipe that was not:
 *
 *   · a failed run that still stamped `lastSyncedAt` reads as "synced 2m ago"
 *   · an intraday refresh logged as `meta_daily` lets a page view mask a dead
 *     cron, or fake a red for a pipe that was never broken
 *   · an intraday refresh counted as a reconcile makes a dashboard someone
 *     keeps open look permanently current while never being trued up against
 *     Meta's 28-day restatements
 *   · a run killed at the route's timeout leaves `running` forever, so health
 *     shows "in progress" instead of the failure it actually was
 *
 * None of those are visible as errors. They are all a green badge over a stale
 * number, which is precisely the failure this product replaced.
 *
 * The Meta API is mocked at `./accounts`, the seam where an account becomes a
 * client — so the orchestration, the upserts and the bookkeeping all run for
 * real against Postgres.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

/** What the fake Meta returns, and what it was asked. */
let insightRows: Record<string, unknown>[] = [];
let reachRows: { campaignId: string; reach: number; frequency: number }[] = [];
let breakdownError: Error | null = null;
let dailyError: Error | null = null;
/** When set, insights are answered by this instead — for the ad-level import, which asks per window and level. */
let dailyImpl: ((since: string, until: string, level: string) => Record<string, unknown>[]) | null = null;
/** The ads listing, by the statuses asked for. Asked for by id, only those ids come back. */
let adsListing: (opts?: { statuses?: readonly string[] }) => unknown[] = () => [];
const calls: {
  method: string;
  account: string;
  since?: string;
  until?: string;
  level?: string;
  ids?: readonly string[];
}[] = [];

const ACC_1 = "cccccccc-0000-4000-8000-000000000001";
const ACC_2 = "cccccccc-0000-4000-8000-000000000002";
const ACCOUNTS = [
  { id: ACC_1, adAccountId: "111", currency: "USD", isPrimary: true, status: "active" },
  { id: ACC_2, adAccountId: "222", currency: "USD", isPrimary: false, status: "active" },
];
let activeAccounts = [ACCOUNTS[0]];

vi.mock("./accounts", () => ({
  activeAdAccounts: async () => activeAccounts,
  metaClientForAccount: (account: { adAccountId: string }) => ({
    async getDailyInsights(acct: string, since: string, until: string, level = "campaign") {
      calls.push({ method: "daily", account: acct, since, until, level });
      if (dailyError) throw dailyError;
      if (dailyImpl) return dailyImpl(since, until, level).map((r) => ({ ...r, account_id: account.adAccountId }));
      return insightRows.map((r) => ({ ...r, account_id: account.adAccountId }));
    },
    async getPeriodReach(acct: string, since: string, until: string) {
      calls.push({ method: "reach", account: acct, since, until });
      return reachRows;
    },
    async getBreakdownInsights(acct: string) {
      calls.push({ method: "breakdown", account: acct });
      if (breakdownError) throw breakdownError;
      return [];
    },
    async getAds(acct: string, opts?: { statuses?: readonly string[]; adIds?: readonly string[] }) {
      calls.push({
        method: opts?.statuses ? `ads:${opts.statuses.join(",")}` : "ads",
        account: acct,
        ids: opts?.adIds,
      });
      const listed = adsListing(opts) as Array<{ id: string }>;
      return opts?.adIds ? listed.filter((ad) => opts.adIds!.includes(ad.id)) : listed;
    },
    async getVideoLengths() {
      return new Map();
    },
  }),
}));

let mod: typeof import("./sync");

const CLIENT_ID = "11111111-1111-1111-1111-111111111111";
const AGENCY = "aaaaaaaa-0000-4000-8000-00000000000a";
const TZ = "America/Los_Angeles";

const client = (over: Partial<Client> = {}): Client =>
  ({
    id: CLIENT_ID,
    agencyId: AGENCY,
    slug: "acme",
    name: "Acme",
    timezone: TZ,
    lastSyncedAt: null,
    ...over,
  }) as Client;

async function run(q: string) {
  return (await harness.db.execute(sql.raw(q))) as unknown as {
    rows: Record<string, unknown>[];
  };
}

const runs = async () =>
  (
    await run(
      `SELECT kind, status, rows_written, error, meta FROM sync_runs ORDER BY started_at`,
    )
  ).rows;

const clientStamps = async () =>
  (
    await run(
      `SELECT last_synced_at, last_meta_reconciled_at FROM clients WHERE id = '${CLIENT_ID}'`,
    )
  ).rows[0];

/** One day of insights, shaped the way the API sends it. */
const insight = (over: Record<string, unknown> = {}) => ({
  date_start: "2026-07-20",
  campaign_id: "camp_1",
  campaign_name: "Prospecting",
  account_currency: "USD",
  impressions: "1000",
  clicks: "50",
  spend: "123.45",
  reach: "800",
  actions: [{ action_type: "lead", value: "9" }],
  ...over,
});

beforeAll(async () => {
  harness = await createTestDb();
  mod = await import("./sync");
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  calls.length = 0;
  dailyImpl = null;
  adsListing = () => [];
  insightRows = [insight()];
  reachRows = [];
  breakdownError = null;
  dailyError = null;
  activeAccounts = [ACCOUNTS[0]];
  await run(
    `TRUNCATE sync_runs, fb_daily_metrics, fb_period_reach, fb_breakdown_metrics, clients RESTART IDENTITY CASCADE`,
  );
  await run(
    `INSERT INTO clients (id, name, slug, agency_id, timezone) VALUES ('${CLIENT_ID}', 'Acme', 'acme', '${AGENCY}', '${TZ}')`,
  );
});

/* ------------------------------------------------------------------ *
 * The run record
 * ------------------------------------------------------------------ */

describe("syncClientMetrics — bookkeeping", () => {
  it("records a successful run with what it wrote", async () => {
    const res = await mod.syncClientMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
    });

    expect(res.rowsWritten).toBe(1);
    const [r] = await runs();
    expect(r).toMatchObject({ kind: "meta_daily", status: "success", rows_written: 1 });
    expect(r.meta).toMatchObject({ since: "2026-07-20", until: "2026-07-20", accounts: 1 });
  });

  it("🔴 logs an intraday refresh under its own kind", async () => {
    /*
     * Health reads only the full-sync kind. An intraday run races the page
     * response and can be killed with the invocation — letting it write
     * `meta_daily` meant a page view could mask a dead cron ("synced 2m ago")
     * or fake a red for a pipe that was never broken.
     */
    await mod.syncClientMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
      intraday: true,
    });
    expect((await runs())[0].kind).toBe("meta_intraday");
  });

  it("🔴 marks the run failed and rethrows when the client has no ad account", async () => {
    activeAccounts = [];

    await expect(
      mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" }),
    ).rejects.toThrow(/no Meta ad account/i);

    // A sync that silently no-ops is exactly the failure that left six blocks
    // of the old spreadsheet empty.
    const [r] = await runs();
    expect(r.status).toBe("failed");
    expect(String(r.error)).toMatch(/no Meta ad account/i);
  });

  it("🔴 records the API's own message, then rethrows", async () => {
    dailyError = new Error("Meta says: (#17) User request limit reached");

    await expect(
      mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" }),
    ).rejects.toThrow(/#17/);

    // The message has to survive onto the run row: "sync failed" tells the
    // operator nothing, while a throttling code tells them to wait and a token
    // error tells them to reconnect.
    const [r] = await runs();
    expect(r.status).toBe("failed");
    expect(String(r.error)).toMatch(/User request limit reached/);
  });
});

/* ------------------------------------------------------------------ *
 * Freshness stamps — the two that health reads
 * ------------------------------------------------------------------ */

describe("syncClientMetrics — freshness stamps", () => {
  it("stamps lastSyncedAt on success", async () => {
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    expect((await clientStamps()).last_synced_at).not.toBeNull();
  });

  it("🔴 stamps lastMetaReconciledAt ONLY for a real reconciliation", async () => {
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    /*
     * The intraday path calls this same function with since = until = today. If
     * that counted as a reconcile, a dashboard someone keeps open would look
     * permanently up to date while never being trued up against Meta's 28-day
     * restatements.
     */
    let stamps = await clientStamps();
    expect(stamps.last_synced_at).not.toBeNull();
    expect(stamps.last_meta_reconciled_at).toBeNull();

    await mod.syncClientMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
      isReconcile: true,
    });
    stamps = await clientStamps();
    expect(stamps.last_meta_reconciled_at).not.toBeNull();
  });

  it("🔴 leaves both stamps alone when the run fails", async () => {
    activeAccounts = [];

    await expect(
      mod.syncClientMetrics(client(), {
        since: "2026-07-20",
        until: "2026-07-20",
        isReconcile: true,
      }),
    ).rejects.toThrow();

    // A failed run that looked reconciled would make the overdue gate skip this
    // client until tomorrow — a whole day of drift, invisibly.
    expect(await clientStamps()).toMatchObject({
      last_synced_at: null,
      last_meta_reconciled_at: null,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Multiple ad accounts
 * ------------------------------------------------------------------ */

describe("syncClientMetrics — multi-account", () => {
  it("🔴 accumulates across accounts instead of one overwriting another", async () => {
    activeAccounts = ACCOUNTS;

    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    /*
     * Every row is tagged with its own `meta_ad_account_id`, which is part of
     * the unique key. Without that tag both accounts collapse onto one row and
     * a two-account client reports half its spend.
     */
    const rows = (await run(
      `SELECT meta_ad_account_id, spend FROM fb_daily_metrics ORDER BY meta_ad_account_id`,
    )).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.meta_ad_account_id)).toEqual(["111", "222"]);
  });

  it("serialises the accounts rather than firing them together", async () => {
    activeAccounts = ACCOUNTS;
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    // Meta warns that several concurrent insights queries invite throttling,
    // which costs the whole run rather than one request.
    expect(calls.filter((c) => c.method === "daily").map((c) => c.account)).toEqual([
      "111",
      "222",
    ]);
  });

  it("stamps each account's own lastSyncedAt", async () => {
    activeAccounts = ACCOUNTS;
    await run(
      `INSERT INTO meta_ad_accounts (id, client_id, ad_account_id) VALUES
         ('${ACC_1}', '${CLIENT_ID}', '111'),
         ('${ACC_2}', '${CLIENT_ID}', '222')`,
    );
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    const rows = (await run(
      `SELECT ad_account_id FROM meta_ad_accounts WHERE last_synced_at IS NOT NULL ORDER BY ad_account_id`,
    )).rows;
    expect(rows.map((r) => r.ad_account_id)).toEqual(["111", "222"]);
  });
});

/* ------------------------------------------------------------------ *
 * Upserting
 * ------------------------------------------------------------------ */

describe("syncClientMetrics — upsert", () => {
  it("🔴 re-running the same window updates rather than duplicating", async () => {
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    insightRows = [insight({ spend: "999.99", actions: [{ action_type: "lead", value: "20" }] })];
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    /*
     * The nightly job re-pulls the whole 28-day restatement window every night.
     * If that inserted instead of upserting, a month of spend would multiply by
     * the number of nights it had been running.
     */
    const rows = (await run(`SELECT spend, leads_total FROM fb_daily_metrics`)).rows;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].spend)).toBe(999.99);
    expect(rows[0].leads_total).toBe(20);
  });

  it("🔴 flags rows inside Meta's restatement window as provisional", async () => {
    const today = new Date().toISOString().slice(0, 10);
    insightRows = [insight({ date_start: today }), insight({ date_start: "2020-01-01" })];

    await mod.syncClientMetrics(client(), { since: "2020-01-01", until: today });

    const rows = (await run(
      `SELECT date::text AS d, is_provisional FROM fb_daily_metrics ORDER BY d`,
    )).rows;
    // Old data is final; anything Meta may still restate is marked so the UI
    // can say the number is not settled yet.
    expect(rows[0]).toMatchObject({ d: "2020-01-01", is_provisional: false });
    expect(rows[1]).toMatchObject({ d: today, is_provisional: true });
  });

  it("keeps campaign rows on their own key with empty adset/ad ids", async () => {
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });

    // Empty strings above ad level are what stop a campaign row and an ad row
    // colliding on the unique key.
    expect((await run(
      `SELECT level, meta_adset_id, meta_ad_id, quality_ranking FROM fb_daily_metrics`,
    )).rows[0]).toMatchObject({
      level: "campaign",
      meta_adset_id: "",
      meta_ad_id: "",
      // Rankings exist only at ad level; storing Meta's "unknown" above it would
      // read as a real diagnostic rather than a question that does not apply.
      quality_ranking: null,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Reach and breakdowns
 * ------------------------------------------------------------------ */

describe("syncClientMetrics — reach", () => {
  it("is skipped unless asked for", async () => {
    await mod.syncClientMetrics(client(), { since: "2026-07-20", until: "2026-07-20" });
    expect(calls.some((c) => c.method === "reach")).toBe(false);
  });

  it("🔴 caches period reach separately, because it cannot be summed", async () => {
    reachRows = [{ campaignId: "", reach: 5000, frequency: 1.83 }];

    await mod.syncClientMetrics(client(), {
      since: "2026-07-01",
      until: "2026-07-20",
      includeReach: true,
    });

    /*
     * Reach is deduplicated PEOPLE. Adding 20 daily values overstates a month
     * 2–5×, so the period total has to be its own query against its own row —
     * it can never be derived from the daily table.
     */
    const rows = (await run(
      `SELECT period_start::text AS s, period_end::text AS e, reach, meta_campaign_id
         FROM fb_period_reach`,
    )).rows;
    expect(rows).toEqual([
      { s: "2026-07-01", e: "2026-07-20", reach: 5000, meta_campaign_id: "" },
    ]);
  });
});

describe("syncClientMetrics — breakdowns", () => {
  it("🔴 records a rejected breakdown without failing the whole sync", async () => {
    breakdownError = new Error("(#100) breakdown combination not supported");

    const res = await mod.syncClientMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
      includeBreakdowns: true,
    });

    /*
     * One rejected breakdown must not discard a sync that pulled spend and
     * leads correctly — but it must not vanish either, or that panel silently
     * serves stale data forever. Visible on the run, not fatal to it.
     */
    expect(res.rowsWritten).toBeGreaterThan(0);
    const [r] = await runs();
    expect(r.status).toBe("success");
    expect((r.meta as { breakdownFailures?: string[] }).breakdownFailures?.length)
      .toBeGreaterThan(0);
  });

  it("says nothing about breakdowns when they all succeed", async () => {
    await mod.syncClientMetrics(client(), {
      since: "2026-07-20",
      until: "2026-07-20",
      includeBreakdowns: true,
    });
    const [r] = await runs();
    expect((r.meta as { breakdownFailures?: string[] }).breakdownFailures).toBeUndefined();
  });
});

describe("syncClientMetrics — the ad-level pass", () => {
  const adRow = (ad: string, over: Record<string, unknown> = {}) => ({
    ...insight(over),
    ad_id: ad,
    ad_name: `Ad ${ad}`,
    adset_id: "set_1",
    adset_name: "Set",
  });
  const video = (id: string) => ({
    id,
    name: `Ad ${id}`,
    status: "ACTIVE",
    creative: { id: `cr_${id}`, video_id: `vid_${id}`, thumbnail_url: "https://cdn.example/t.jpg" },
  });
  const nightly = (since = "2026-07-20", until = "2026-07-20") =>
    mod.syncClientMetrics(client(), { since, until, includeAdLevel: true });
  const keys = async () =>
    (await run(`SELECT meta_ad_id, creative_key FROM fb_daily_metrics WHERE level = 'ad' ORDER BY meta_ad_id`)).rows;
  const storeCreative = (ad: string, key: string) =>
    run(`INSERT INTO meta_ad_creatives (client_id, meta_ad_account_id, meta_ad_id, creative_key, creative_type)
         VALUES ('${CLIENT_ID}', '111', '${ad}', '${key}', 'video')`);

  beforeEach(async () => {
    await run(`TRUNCATE meta_ad_creatives`);
    dailyImpl = (_since, _until, level) => (level === "ad" ? [adRow("a1"), adRow("a2"), adRow("a9")] : [insight()]);
    // a9 ran and was archived since, so the default listing leaves it out. The
    // account also holds ads that never ran in the window ("idle", "old").
    adsListing = (opts) =>
      opts?.statuses?.includes("ARCHIVED") ? [video("a9"), video("old")] : [video("a1"), video("a2"), video("idle")];
  });

  it("🔴 asks Meta for exactly the ads that delivered, by id — never the whole account", async () => {
    await nightly();
    /*
     * Listing every ad was what Meta refused from 23 Oct 2026 ("reduce the
     * amount of data"), failing two clients' whole reconcile for days. One of
     * them holds 1,569 ads, of which 70 delivered.
     */
    expect(calls.filter((c) => c.method.startsWith("ads")).map((c) => [c.method, c.ids])).toEqual([
      ["ads", ["a1", "a2", "a9"]],
      ["ads:ARCHIVED", ["a9"]],
    ]);
    expect(await keys()).toEqual([
      { meta_ad_id: "a1", creative_key: "vid_a1" },
      { meta_ad_id: "a2", creative_key: "vid_a2" },
      { meta_ad_id: "a9", creative_key: "vid_a9" },
    ]);
    const stored = (await run(`SELECT meta_ad_id FROM meta_ad_creatives ORDER BY meta_ad_id`)).rows;
    expect(stored.map((r) => r.meta_ad_id)).toEqual(["a1", "a2", "a9"]);
  });

  it("🔴 names an ad archived after it ran — its spend is not 'not attributable'", async () => {
    await nightly();
    expect((await keys()).find((r) => r.meta_ad_id === "a9")).toEqual({ meta_ad_id: "a9", creative_key: "vid_a9" });
  });

  it("keeps the stored creative of an ad Meta no longer returns at all", async () => {
    await storeCreative("a3", "img_a3");
    dailyImpl = (_since, _until, level) => (level === "ad" ? [adRow("a3")] : [insight()]);
    await nightly();
    // Deleted: in neither listing. Writing an empty key would move its spend
    // out of its creative's card on every nightly run.
    expect(await keys()).toEqual([{ meta_ad_id: "a3", creative_key: "img_a3" }]);
  });

  it("🔴 writes the ad rows anyway when Meta will not list the ads — under their stored creatives, with the failure on the run", async () => {
    await storeCreative("a1", "vid_a1");
    adsListing = () => {
      throw new Error("Please reduce the amount of data you're asking for, then retry your request");
    };
    // Days the nightly pulls again tomorrow: today's.
    const res = await nightly(todayKey(TZ), todayKey(TZ));

    // Spend, leads and every per-ad figure stay current; a name and a thumbnail
    // are not worth failing — and so not reconciling — the client's whole sync.
    expect(res.rowsWritten).toBe(4);
    const [r] = await runs();
    expect(r.status).toBe("success");
    expect((r.meta as { creativeFailures?: string[] }).creativeFailures).toEqual([
      expect.stringMatching(/^111: Please reduce the amount of data/),
    ]);
    expect(await keys()).toEqual([
      { meta_ad_id: "a1", creative_key: "vid_a1" },
      { meta_ad_id: "a2", creative_key: "" },
      { meta_ad_id: "a9", creative_key: "" },
    ]);
  });

  it("🔴 throws instead for days the nightly will not pull again — nothing re-asks for those", async () => {
    adsListing = () => {
      throw new Error("(#2) Service temporarily unavailable");
    };
    // An old month, as the backfill scripts sync: written unnamed, the history
    // import would then skip it as complete and never name its ads.
    await expect(nightly("2026-07-20", "2026-07-20")).rejects.toThrow(/temporarily unavailable/);
    const [r] = await runs();
    expect(r.status).toBe("failed");
    expect(await keys()).toEqual([]);
  });

  it("keeps what the first lookup found when the ARCHIVED lookup fails", async () => {
    adsListing = (opts) => {
      if (opts?.statuses) throw new Error("(#1) An unknown error occurred");
      return [video("a1"), video("a2")];
    };
    await nightly(todayKey(TZ), todayKey(TZ));
    // a1 and a2 were found and stored before the second lookup failed.
    expect(await keys()).toEqual([
      { meta_ad_id: "a1", creative_key: "vid_a1" },
      { meta_ad_id: "a2", creative_key: "vid_a2" },
      { meta_ad_id: "a9", creative_key: "" },
    ]);
    const [r] = await runs();
    expect(r.status).toBe("success");
    expect((r.meta as { creativeFailures?: string[] }).creativeFailures).toHaveLength(1);
  });

  it("🔴 names older rows by the creative their ad is now known by — but leaves a Dynamic Creative ad's empty key", async () => {
    await storeCreative("a7", "vid_a7");
    await run(`INSERT INTO meta_ad_creatives (client_id, meta_ad_account_id, meta_ad_id, creative_key, creative_type)
               VALUES ('${CLIENT_ID}', '111', 'dc1', '', 'carousel')`);
    // Written unnamed weeks ago (an archived ad the old nightly never asked
    // about), long outside the window the nightly rewrites.
    await run(`INSERT INTO fb_daily_metrics (client_id, meta_ad_account_id, date, level, meta_campaign_id, meta_ad_id, creative_key, creative_type, spend)
               VALUES ('${CLIENT_ID}', '111', '2026-05-01', 'ad', 'camp_1', 'a7', '', 'unknown', 5),
                      ('${CLIENT_ID}', '111', '2026-05-01', 'ad', 'camp_1', 'dc1', '', 'carousel', 5)`);
    await nightly();
    const old = (
      await run(`SELECT meta_ad_id, creative_key FROM fb_daily_metrics WHERE date = '2026-05-01' ORDER BY meta_ad_id`)
    ).rows;
    expect(old).toEqual([
      { meta_ad_id: "a7", creative_key: "vid_a7" },
      { meta_ad_id: "dc1", creative_key: "" },
    ]);
  });

  it("🔴 carries an ad set's learning state onto its ads that did not deliver", async () => {
    await run(`INSERT INTO meta_ad_creatives (client_id, meta_ad_account_id, meta_ad_id, meta_adset_id, creative_key, creative_type, learning_stage)
               VALUES ('${CLIENT_ID}', '111', 'stopped', 'set_1', 'vid_s', 'video', 'LEARNING'),
                      ('${CLIENT_ID}', '111', 'other', 'set_2', 'vid_o', 'video', 'LEARNING')`);
    adsListing = (opts) =>
      opts?.statuses
        ? []
        : [{ ...video("a1"), adset_id: "set_1", adset: { id: "set_1", learning_stage_info: { status: "SUCCESS" } } }];
    await nightly();
    // "stopped" is no longer listed; left at LEARNING it would hold its whole
    // campaign out of keep/kill. Its set exited learning — so has it.
    const stages = (
      await run(`SELECT meta_ad_id, learning_stage FROM meta_ad_creatives WHERE meta_ad_id IN ('stopped', 'other') ORDER BY meta_ad_id`)
    ).rows;
    expect(stages).toEqual([
      { meta_ad_id: "other", learning_stage: "LEARNING" },
      { meta_ad_id: "stopped", learning_stage: "SUCCESS" },
    ]);
  });

  it("says nothing about creatives when every ad resolves", async () => {
    await nightly();
    const [r] = await runs();
    expect((r.meta as { creativeFailures?: string[] }).creativeFailures).toBeUndefined();
  });

  it("halves a window Meta says is too much, as the history import does", async () => {
    dailyImpl = (since, until, level) => {
      if (level !== "ad") return [insight({ date_start: since })];
      const days = (Date.parse(until) - Date.parse(since)) / 86_400_000 + 1;
      if (days > 14) throw new Error("Please reduce the amount of data you're asking for, then retry your request");
      return [adRow("a1", { date_start: since })];
    };
    const res = await nightly("2026-07-01", "2026-07-28");
    expect(res.rowsWritten).toBeGreaterThan(1);
    const windows = calls
      .filter((c) => c.method === "daily" && c.level === "ad")
      .map((c) => (Date.parse(c.until!) - Date.parse(c.since!)) / 86_400_000 + 1);
    expect(windows).toEqual([28, 14, 14]);
    // The halves share their ads: a1 is asked for once.
    expect(calls.filter((c) => c.method === "ads").map((c) => c.ids)).toEqual([["a1"]]);
  });

  describe("re-reading ads that stopped delivering", () => {
    const reconcile = (over: Partial<Parameters<typeof mod.syncClientMetrics>[1]> = {}) =>
      mod.syncClientMetrics(client(), {
        since: todayKey(TZ),
        until: todayKey(TZ),
        includeAdLevel: true,
        isReconcile: true,
        ...over,
      });
    /** A stored ad last read `readDaysAgo` days ago, which delivered `ranDaysAgo` days ago. */
    const storeStopped = async (ad: string, { readDaysAgo = 30, ranDaysAgo = 60 } = {}) => {
      await run(`INSERT INTO meta_ad_creatives (client_id, meta_ad_account_id, meta_ad_id, creative_key, creative_type, synced_at)
                 VALUES ('${CLIENT_ID}', '111', '${ad}', 'vid_${ad}', 'video', now() - interval '${readDaysAgo} days')`);
      await run(`INSERT INTO fb_daily_metrics (client_id, meta_ad_account_id, date, level, meta_campaign_id, meta_ad_id, creative_key, creative_type, spend)
                 VALUES ('${CLIENT_ID}', '111', current_date - ${ranDaysAgo}, 'ad', 'camp_1', '${ad}', 'vid_${ad}', 'video', 5)`);
    };
    const askedFor = () => calls.filter((c) => c.method === "ads").flatMap((c) => c.ids ?? []);

    it("🔴 re-reads a stored ad whose picture link is going old, so share links and PDFs keep its picture", async () => {
      await storeStopped("old1");
      adsListing = (opts) => (opts?.statuses ? [] : [video("a1"), video("a2"), video("old1")]);
      await reconcile();
      expect(askedFor()).toContain("old1");
      const [row] = (
        await run(`SELECT synced_at > now() - interval '1 minute' AS fresh FROM meta_ad_creatives WHERE meta_ad_id = 'old1'`)
      ).rows;
      expect(row).toEqual({ fresh: true });
    });

    it("leaves alone an ad read this week, and one no report can show any more", async () => {
      await storeStopped("recent", { readDaysAgo: 2 });
      await storeStopped("ancient", { ranDaysAgo: 600 });
      await reconcile();
      expect(askedFor()).not.toContain("recent");
      expect(askedFor()).not.toContain("ancient");
    });

    it("marks an ad Meta no longer has, and stops asking for it", async () => {
      await storeStopped("deleted");
      await reconcile();
      expect(askedFor()).toContain("deleted");
      const [row] = (await run(`SELECT raw ? 'gone_at' AS gone FROM meta_ad_creatives WHERE meta_ad_id = 'deleted'`)).rows;
      expect(row).toEqual({ gone: true });

      calls.length = 0;
      await reconcile();
      expect(askedFor()).not.toContain("deleted");
    });

    it("re-reads at most 250 a night, the longest-unread first", async () => {
      await run(`INSERT INTO meta_ad_creatives (client_id, meta_ad_account_id, meta_ad_id, creative_key, creative_type, synced_at)
                 SELECT '${CLIENT_ID}', '111', 's' || i, 'vid_s' || i, 'video', now() - make_interval(days => 8 + i)
                 FROM generate_series(1, 251) AS i`);
      await run(`INSERT INTO fb_daily_metrics (client_id, meta_ad_account_id, date, level, meta_campaign_id, meta_ad_id, spend)
                 SELECT '${CLIENT_ID}', '111', current_date - 40, 'ad', 'camp_1', 's' || i, 1
                 FROM generate_series(1, 251) AS i`);
      await reconcile();
      const stale = askedFor().filter((id) => id.startsWith("s"));
      expect(stale).toHaveLength(250);
      expect(stale).toContain("s251");
      expect(stale).not.toContain("s1");
    });

    it("is the nightly's upkeep only — not a manual sync's", async () => {
      await storeStopped("old1");
      await reconcile({ isReconcile: false });
      expect(askedFor()).not.toContain("old1");
    });
  });
});

/* ------------------------------------------------------------------ *
 * refreshIfStale — the stale-while-revalidate path
 * ------------------------------------------------------------------ */

/**
 * ⚠️ Only the gates BEFORE the lock are covered here, and that is a harness
 * limit rather than a choice.
 *
 * `refreshIfStale` opens a transaction to take `pg_try_advisory_xact_lock`, then
 * calls `syncClientMetrics` inside it — and that call writes through the
 * module-level `db`, not the transaction handle. Against Neon that is fine and
 * deliberate: it is a connection POOL, so the lock is held on one connection
 * for the duration while the sync writes on another.
 *
 * PGlite has exactly ONE connection. The inner query queues behind the still-open
 * transaction and neither can proceed — a deadlock, verified directly: a
 * transaction whose callback queries the outer `db` never resolves, while the
 * same transaction using `tx` completes and `pg_try_advisory_xact_lock` itself
 * works fine.
 *
 * So the locked path cannot be exercised in-process, and faking a transaction to
 * force it would assert behaviour that does not match production — worse than
 * not asserting it. What that leaves untested here: that the refresh syncs only
 * TODAY, that it logs as intraday, and that it swallows its own failure. Those
 * need a real pooled Postgres.
 */
describe("refreshIfStale — the gates before the lock", () => {
  it("does nothing for a dashboard synced moments ago", async () => {
    const fresh = client({ lastSyncedAt: new Date(Date.now() - 60_000) });

    expect(await mod.refreshIfStale(fresh)).toBe(false);
    // Ten people opening the same fresh dashboard must not each burn an API
    // call — and must not each wait for one.
    expect(calls).toHaveLength(0);
  });

  it("treats a never-synced client as stale rather than fresh", async () => {
    // `lastSyncedAt` null must not read as "recently synced" — a brand new
    // client would then never pull anything until the first nightly cron.
    activeAccounts = [];
    expect(await mod.refreshIfStale(client({ lastSyncedAt: null }))).toBe(false);
    // Reached the account check, which is the gate after freshness.
    expect(calls).toHaveLength(0);
  });

  it("🔴 does nothing for a client with no ad accounts", async () => {
    activeAccounts = [];
    expect(await mod.refreshIfStale(client({ lastSyncedAt: new Date(0) }))).toBe(false);
    // Short-circuits before taking a lock, so a half-configured client cannot
    // hold one while doing nothing.
    expect((await runs())).toHaveLength(0);
  });

  it("exposes the freshness window as a constant the dashboard shares", () => {
    // The page and this module must agree on what "stale" means, or the page
    // triggers refreshes this function then declines to perform.
    expect(mod.STALE_AFTER_MS).toBe(15 * 60 * 1000);
  });
});

/* ------------------------------------------------------------------ *
 * reapAbandonedSyncRuns
 * ------------------------------------------------------------------ */

describe("reapAbandonedSyncRuns", () => {
  const insertRun = (status: string, minutesAgo: number, id: string) =>
    run(
      `INSERT INTO sync_runs (id, client_id, kind, status, started_at)
       VALUES ('${id}', '${CLIENT_ID}', 'meta_daily', '${status}',
               now() - interval '${minutesAgo} minutes')`,
    );

  it("🔴 fails a run that was killed without recording a terminal status", async () => {
    await insertRun("running", 120, "aaaaaaaa-0000-4000-8000-00000000ff01");

    expect(await mod.reapAbandonedSyncRuns(30)).toBe(1);

    /*
     * A run ends three ways: success, a caught error, or the process being
     * killed. The third writes nothing — a hard timeout at the route's
     * maxDuration runs neither branch — and the row sits in `running` forever,
     * so health reads a stale "in progress" instead of the failure it was.
     */
    const [r] = await runs();
    expect(r.status).toBe("failed");
    expect(String(r.error)).toMatch(/abandoned/i);
  });

  it("leaves a run that is still plausibly alive", async () => {
    await insertRun("running", 5, "aaaaaaaa-0000-4000-8000-00000000ff02");
    expect(await mod.reapAbandonedSyncRuns(30)).toBe(0);
    expect((await runs())[0].status).toBe("running");
  });

  it("🔴 never touches a run that already finished", async () => {
    await insertRun("success", 999, "aaaaaaaa-0000-4000-8000-00000000ff03");
    await insertRun("failed", 999, "aaaaaaaa-0000-4000-8000-00000000ff04");

    expect(await mod.reapAbandonedSyncRuns(30)).toBe(0);
    // Rewriting a success as failed would invent an outage that never happened.
    expect((await runs()).map((r) => r.status).sort()).toEqual(["failed", "success"]);
  });
});

describe("usualMetaRunMs", () => {
  let n = 0;
  const insertRun = (secs: number, opts: { daysAgo?: number; kind?: string; status?: string } = {}) =>
    run(
      `INSERT INTO sync_runs (id, client_id, kind, status, started_at, finished_at)
       VALUES ('aaaaaaaa-0000-4000-8000-0000000000${String(++n).padStart(2, "0")}', '${CLIENT_ID}',
               '${opts.kind ?? "meta_daily"}', '${opts.status ?? "success"}',
               now() - interval '${opts.daysAgo ?? 1} days',
               now() - interval '${opts.daysAgo ?? 1} days' + interval '${secs} seconds')`,
    );

  it("🔴 is the longest of the client's last three successful reconciles", async () => {
    await insertRun(90, { daysAgo: 1 });
    await insertRun(120, { daysAgo: 2 });
    await insertRun(95, { daysAgo: 3 });
    await insertRun(250, { daysAgo: 4 }); // a fourth run back no longer counts
    expect((await mod.usualMetaRunMs()).get(CLIENT_ID)).toBe(120_000);
  });

  it("ignores failures, on-load refreshes and anything older than a fortnight", async () => {
    await insertRun(300, { status: "failed" });
    await insertRun(200, { kind: "meta_intraday" });
    await insertRun(280, { daysAgo: 20 });
    expect((await mod.usualMetaRunMs()).has(CLIENT_ID)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The window constant
 * ------------------------------------------------------------------ */

describe("CREATIVE_HORIZON_DAYS", () => {
  it("covers the longest report range, opened late through the longest-lived share link", async () => {
    const { MAX_RANGE_DAYS } = await import("@/lib/dates");
    const { SHARE_TTL_DAYS } = await import("@/lib/share");
    // Not imported by the sync (it would pull the Board in), so pinned here.
    expect(mod.CREATIVE_HORIZON_DAYS).toBe(MAX_RANGE_DAYS + Math.max(...SHARE_TTL_DAYS));
  });
});

describe("RECONCILE_DAYS", () => {
  it("🔴 is coupled to Meta's restatement horizon", async () => {
    const { META_PROVISIONAL_DAYS } = await import("@/lib/dates");

    /*
     * These must not drift apart. When the re-pull window was 7 and the
     * provisional window 28, days 8–28 were flagged "still changing" and never
     * re-pulled — frozen at stale values that quietly disagreed with Ads
     * Manager forever.
     */
    expect(mod.RECONCILE_DAYS).toBe(META_PROVISIONAL_DAYS);
  });
});


/* ------------------------------------------------------------------ *
 * Ad-level history import
 * ------------------------------------------------------------------ */

describe("planMonths", () => {
  it("lists the window's months newest first, clipped to the window", () => {
    expect(mod.planMonths({ startKey: "2026-07-15", endKey: "2026-09-10" })).toEqual([
      { month: "2026-09", since: "2026-09-01", until: "2026-09-10" },
      { month: "2026-08", since: "2026-08-01", until: "2026-08-31" },
      { month: "2026-07", since: "2026-07-15", until: "2026-07-31" },
    ]);
  });

  it("carries on with the months before a day", () => {
    const months = mod.planMonths({ startKey: "2026-07-15", endKey: "2026-09-10" }, "2026-08-31");
    expect(months.map((m) => m.month)).toEqual(["2026-08", "2026-07"]);
  });
});

describe("importMetaAdLevelHistory", () => {
  /** An ad-level insight on a day, shaped the way the API sends it. */
  const adInsight = (date: string, ad: string, spend = "10") => ({
    ...insight({ date_start: date, spend }),
    ad_id: ad,
    ad_name: `Ad ${ad}`,
    adset_id: "set_1",
    adset_name: "Set",
  });
  const video = (id: string, link?: string) => ({
    id,
    name: `Ad ${id}`,
    status: "ACTIVE",
    ...(link ? { preview_shareable_link: link } : {}),
    creative: { id: `cr_${id}`, video_id: `vid_${id}`, thumbnail_url: "https://cdn.example/t.jpg" },
  });

  beforeEach(async () => {
    await run(`TRUNCATE meta_ad_creatives`);
    // One ad row per requested window; the archived ad on every second one.
    dailyImpl = (since, _until, level) =>
      level === "ad" ? [adInsight(since, "a1"), adInsight(since, "a9", "5")] : [];
    adsListing = (opts) => (opts?.statuses?.includes("ARCHIVED") ? [video("a9")] : [video("a1", "https://fb.me/one")]);
  });

  it("🔴 imports newest month first, names archived ads, and writes no sync run", async () => {
    const res = await mod.importMetaAdLevelHistory(client(), { days: 60 });
    expect(res.done).toBe(true);
    expect(res.nextBefore).toBeNull();
    const windows = calls.filter((c) => c.method === "daily" && c.level === "ad").map((c) => c.since!);
    expect(windows.length).toBeGreaterThanOrEqual(2);
    expect([...windows].sort().reverse()).toEqual(windows);
    expect(calls.map((c) => c.method)).toEqual(expect.arrayContaining(["ads", "ads:ARCHIVED"]));

    const named = (await run(`SELECT DISTINCT creative_key FROM fb_daily_metrics WHERE meta_ad_id = 'a9'`)).rows;
    expect(named).toEqual([{ creative_key: "vid_a9" }]);
    // A failed month from last year must not turn the Meta pipe red.
    expect(await runs()).toEqual([]);
  });

  it("skips a month whose ad rows already add up to its campaign rows", async () => {
    // The window's newest month, as the import will plan it.
    const [newest] = mod.planMonths(trailingWindowInclusive(20, TZ));
    const start = newest.since;
    await run(`
      INSERT INTO fb_daily_metrics (client_id, meta_ad_account_id, date, level, meta_campaign_id, meta_ad_id, spend)
      VALUES ('${CLIENT_ID}', '111', '${start}', 'campaign', 'camp_1', '', 40),
             ('${CLIENT_ID}', '111', '${start}', 'ad', 'camp_1', 'a1', 40)
    `);
    const res = await mod.importMetaAdLevelHistory(client(), { days: 20 });
    expect(res.months[0]).toEqual({ month: start.slice(0, 7), status: "complete", rows: 0 });
    expect(calls.some((c) => c.method === "daily" && c.since === start)).toBe(false);
  });

  it("🔴 stops at its budget and carries on", async () => {
    const first = await mod.importMetaAdLevelHistory(client(), { days: 60, budgetMs: -1 });
    expect(first.done).toBe(false);
    expect(first.months).toEqual([]);
    expect(first.nextBefore).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calls).toEqual([]);

    const rest = await mod.importMetaAdLevelHistory(client(), { days: 60, before: first.nextBefore! });
    expect(rest.done).toBe(true);
    expect(rest.months.length).toBeGreaterThanOrEqual(2);
  });

  it("🔴 asks only for the ads its months delivered, each once — never the whole account", async () => {
    await mod.importMetaAdLevelHistory(client(), { days: 60 });
    const asked = calls.filter((c) => c.method.startsWith("ads"));
    // Listing a large account up front is what Meta refused ("reduce the amount of data").
    expect(asked.map((c) => [c.method, c.ids])).toEqual([
      ["ads", ["a1", "a9"]],
      ["ads:ARCHIVED", ["a9"]],
    ]);
  });

  it("does not halve a month when it was the ads lookup Meta refused", async () => {
    adsListing = () => {
      throw new Error("Please reduce the amount of data you're asking for, then retry your request");
    };
    await expect(mod.importMetaAdLevelHistory(client(), { days: 20 })).rejects.toThrow(/reduce the amount of data/);
    // Halving the window would re-pull the same insights to ask for the same ads.
    expect(calls.filter((c) => c.method === "daily" && c.level === "ad")).toHaveLength(1);
  });

  it("names the unnamed rows of months it skips as complete", async () => {
    const [newest] = mod.planMonths(trailingWindowInclusive(20, TZ));
    const start = newest.since;
    await run(`INSERT INTO meta_ad_creatives (client_id, meta_ad_account_id, meta_ad_id, creative_key, creative_type)
               VALUES ('${CLIENT_ID}', '111', 'a5', 'vid_a5', 'video')`);
    await run(`
      INSERT INTO fb_daily_metrics (client_id, meta_ad_account_id, date, level, meta_campaign_id, meta_ad_id, spend)
      VALUES ('${CLIENT_ID}', '111', '${start}', 'campaign', 'camp_1', '', 40),
             ('${CLIENT_ID}', '111', '${start}', 'ad', 'camp_1', 'a5', 40)
    `);
    const res = await mod.importMetaAdLevelHistory(client(), { days: 20 });
    expect(res.months[0].status).toBe("complete");
    const [row] = (await run(`SELECT creative_key FROM fb_daily_metrics WHERE meta_ad_id = 'a5'`)).rows;
    expect(row).toEqual({ creative_key: "vid_a5" });
  });

  it("🔴 stops on a month whose ads Meta will not list, rather than filing it done with them unnamed", async () => {
    adsListing = () => {
      throw new Error("(#2) Service temporarily unavailable");
    };
    await expect(mod.importMetaAdLevelHistory(client(), { days: 20 })).rejects.toThrow(/temporarily unavailable/);
    expect((await run(`SELECT count(*)::int AS n FROM fb_daily_metrics WHERE level = 'ad'`)).rows).toEqual([{ n: 0 }]);
  });

  it("halves a window Meta says is too much, down to a week", async () => {
    dailyImpl = (since, until, level) => {
      if (level !== "ad") return [];
      const days = (Date.parse(until) - Date.parse(since)) / 86_400_000 + 1;
      if (days > 10) throw new Error("Please reduce the amount of data you're asking for, then retry your request");
      return [adInsight(since, "a1")];
    };
    const res = await mod.importMetaAdLevelHistory(client(), { days: 45 });
    expect(res.done).toBe(true);
    const long = calls.filter((c) => c.method === "daily" && c.level === "ad");
    expect(long.some((c) => (Date.parse(c.until!) - Date.parse(c.since!)) / 86_400_000 + 1 <= 10)).toBe(true);
  });

  it("🔴 keeps a stored preview link when a later listing comes back without it", async () => {
    await mod.importMetaAdLevelHistory(client(), { days: 20 });
    adsListing = (opts) => (opts?.statuses ? [] : [video("a1")]);
    await mod.importMetaAdLevelHistory(client(), { days: 20 });
    const [row] = (
      await run(`SELECT raw->>'preview_shareable_link' AS link FROM meta_ad_creatives WHERE meta_ad_id = 'a1'`)
    ).rows;
    expect(row).toEqual({ link: "https://fb.me/one" });
  });
});
