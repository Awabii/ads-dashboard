import { describe, it, expect, afterEach, vi } from "vitest";
import { shiftDateKey } from "@/lib/dates";
import {
  parseInsightRow,
  segmentLabel,
  insightFields,
  isFieldRefusal,
  isReduceDataError,
  isResultFieldRefusal,
  isMetaTimeout,
  RANKING_FIELDS,
  metaVersion,
  META_BREAKDOWNS,
  MetaApiError,
  MetaClient,
} from "./client";

/**
 * Parsing what Meta actually sends back.
 *
 * ── Why this function is worth more attention than its size suggests ──
 *
 * `parseInsightRow` is pure, ~60 lines, and every number on every dashboard
 * passes through it. It also encodes most of the hard-won rules about this API
 * — the ones where the wrong answer is a plausible number rather than an error,
 * so nothing downstream can catch it:
 *
 *   · `actions` is SPARSE. Zero-activity types are absent and the whole key can
 *     be missing on a quiet day.
 *   · Lead action types NEST. `lead` already contains the pixel and onsite
 *     types, so summing them triple-counts — the single most common
 *     lead-reporting bug against this API, and it inflates the number the
 *     client is billed against.
 *   · Every numeric field arrives as a JSON STRING.
 *   · Hook rate must come from `video_view` (Meta's 3-second threshold), never
 *     `video_play_actions`, which counts autoplay starts nobody chose.
 *
 * None of these produce a crash when you get them wrong. They produce a
 * dashboard that looks right and disagrees with Ads Manager, which is precisely
 * the failure this whole product exists to replace.
 *
 * It had no test at all.
 */

/** A row shaped the way the API really sends it: numbers as strings. */
const row = (over: Record<string, unknown> = {}) => ({
  date_start: "2026-07-20",
  campaign_id: "23851234567890123",
  campaign_name: "Consults — Prospecting",
  account_currency: "USD",
  reach: "4821",
  impressions: "9134",
  clicks: "312",
  spend: "364.45",
  inline_link_clicks: "180",
  ...over,
});

describe("parseInsightRow — the numbers are strings", () => {
  it("🔴 casts every numeric field, including a decimal spend", () => {
    const p = parseInsightRow(row() as never);

    // Left as strings these silently concatenate instead of summing: "1" + "2"
    // is "12", and a month's spend becomes a very long number.
    expect(p.spend).toBe(364.45);
    expect(p.impressions).toBe(9134);
    expect(p.reach).toBe(4821);
    expect(p.clicksAll).toBe(312);
    expect(typeof p.spend).toBe("number");
  });

  it("treats missing and unparseable numerics as 0, not NaN", () => {
    const p = parseInsightRow(
      row({ spend: undefined, impressions: "", reach: "not-a-number", clicks: null }) as never,
    );

    // NaN propagates through every aggregate and renders as "NaN" in a cell.
    for (const v of [p.spend, p.impressions, p.reach, p.clicksAll]) {
      expect(v).toBe(0);
    }
  });
});

describe("parseInsightRow — leads must not be double-counted", () => {
  it("🔴 leadsTotal is the `lead` type ALONE, never the sum of the three", () => {
    const p = parseInsightRow(
      row({
        actions: [
          { action_type: "lead", value: "10" },
          { action_type: "offsite_conversion.fb_pixel_lead", value: "6" },
          { action_type: "onsite_conversion.lead_grouped", value: "4" },
        ],
      }) as never,
    );

    /*
     * `lead` ALREADY CONTAINS the other two. Summing gives 20 for a day that
     * produced 10 — which halves the reported cost per lead and makes a
     * campaign look twice as efficient as it is.
     */
    expect(p.leadsTotal).toBe(10);
    expect(p.leadsPixel).toBe(6);
    expect(p.leadsOnsite).toBe(4);
    expect(p.leadsPixel + p.leadsOnsite).toBe(p.leadsTotal);
  });

  it("keeps the breakdown when only one source is present", () => {
    const p = parseInsightRow(
      row({
        actions: [
          { action_type: "lead", value: "7" },
          { action_type: "offsite_conversion.fb_pixel_lead", value: "7" },
        ],
      }) as never,
    );
    expect(p.leadsTotal).toBe(7);
    expect(p.leadsOnsite).toBe(0);
  });
});

describe("parseInsightRow — the actions array is sparse", () => {
  it("🔴 defaults everything to 0 when `actions` is missing entirely", () => {
    // A day with impressions and no conversions omits the key altogether.
    const p = parseInsightRow(row() as never);

    expect(p.leadsTotal).toBe(0);
    expect(p.leadsPixel).toBe(0);
    expect(p.landingPageViews).toBe(0);
    expect(p.video3sViews).toBe(0);
    // …but the metrics that DID arrive are still parsed.
    expect(p.impressions).toBe(9134);
  });

  it("survives `actions` arriving as a non-array", () => {
    for (const bad of [null, undefined, "", {}, 0]) {
      const p = parseInsightRow(row({ actions: bad }) as never);
      expect(p.leadsTotal).toBe(0);
    }
  });

  it("🔴 filters by action_type and never by position", () => {
    /*
     * Meta does not promise an order, and omits zero-activity types — so the
     * index of `lead` moves between days. Reading positionally works on the
     * fixture you developed against and silently reports link clicks as leads
     * on a day when something else was absent.
     */
    const forward = parseInsightRow(
      row({
        actions: [
          { action_type: "link_click", value: "200" },
          { action_type: "lead", value: "12" },
          { action_type: "landing_page_view", value: "150" },
        ],
      }) as never,
    );
    const shuffled = parseInsightRow(
      row({
        actions: [
          { action_type: "landing_page_view", value: "150" },
          { action_type: "lead", value: "12" },
          { action_type: "link_click", value: "200" },
        ],
      }) as never,
    );

    expect(forward.leadsTotal).toBe(12);
    expect(forward.landingPageViews).toBe(150);
    expect(shuffled).toEqual(forward);
  });

  it("ignores action types it does not know", () => {
    const p = parseInsightRow(
      row({
        actions: [
          { action_type: "post_reaction", value: "88" },
          { action_type: "lead", value: "3" },
        ],
      }) as never,
    );
    expect(p.leadsTotal).toBe(3);
  });
});

describe("parseInsightRow — link clicks", () => {
  it("🔴 prefers the attribution-respecting figure over the inline one", () => {
    const p = parseInsightRow(
      row({
        inline_link_clicks: "180",
        actions: [{ action_type: "link_click", value: "240" }],
      }) as never,
    );

    /*
     * `inline_link_clicks` is pinned to a 1-day-click window and reads LOWER
     * than the Ads Manager "Link clicks" column, which respects the account's
     * attribution setting. Reporting the inline figure makes cost-per-click look
     * worse than the client sees in their own dashboard, which is the kind of
     * discrepancy that costs trust in every other number on the page.
     */
    expect(p.linkClicks).toBe(240);
    // Both stored, so the two can be compared when they disagree.
    expect(p.inlineLinkClicks).toBe(180);
  });

  it("falls back to the inline figure when `actions` carries no link_click", () => {
    const p = parseInsightRow(row({ inline_link_clicks: "180", actions: [] }) as never);
    expect(p.linkClicks).toBe(180);
  });

  it("is 0 when neither is present", () => {
    const p = parseInsightRow(row({ inline_link_clicks: undefined }) as never);
    expect(p.linkClicks).toBe(0);
  });
});

describe("parseInsightRow — video", () => {
  it("🔴 hook rate counts 3-second views, NOT autoplay starts", () => {
    const p = parseInsightRow(
      row({
        actions: [{ action_type: "video_view", value: "1200" }],
        video_play_actions: [{ action_type: "video_view", value: "8600" }],
      }) as never,
    );

    /*
     * A "play" counts an autoplay start the viewer never chose. On feed
     * placements — which autoplay by default — that is most impressions, so a
     * hook rate computed from plays comes out flattering and meaningless. Every
     * published benchmark is stated against the 3-second threshold.
     */
    expect(p.video3sViews).toBe(1200);
    expect(p.videoPlays).toBe(8600);
  });

  it("reads the array-shaped video fields by action_type", () => {
    const p = parseInsightRow(
      row({
        video_thruplay_watched_actions: [{ action_type: "video_view", value: "410" }],
        video_p25_watched_actions: [{ action_type: "video_view", value: "900" }],
        video_p100_watched_actions: [{ action_type: "video_view", value: "120" }],
        outbound_clicks: [{ action_type: "outbound_click", value: "77" }],
      }) as never,
    );

    // These arrive as ARRAYS of {action_type, value}, not scalars — a mistake
    // that yields NaN or "[object Object]" rather than a number.
    expect(p.thruPlays).toBe(410);
    expect(p.videoP25).toBe(900);
    expect(p.videoP100).toBe(120);
    expect(p.outboundClicks).toBe(77);
  });

  it("returns 0 for every video field on a non-video ad", () => {
    const p = parseInsightRow(row() as never);
    for (const v of [p.thruPlays, p.videoP25, p.videoP50, p.videoP75, p.videoP95, p.videoP100, p.videoPlays, p.outboundClicks]) {
      expect(v).toBe(0);
    }
  });
});

describe("parseInsightRow — delivery rankings", () => {
  it("passes through the known values", () => {
    const p = parseInsightRow(
      row({
        quality_ranking: "ABOVE_AVERAGE",
        engagement_rate_ranking: "below_average_10",
        conversion_rate_ranking: "UNKNOWN",
      }) as never,
    );
    expect(p.qualityRanking).toBe("above_average");
    expect(p.engagementRateRanking).toBe("below_average_10");
    // `unknown` survives as itself — Meta genuinely cannot rank low-volume ads,
    // and that is different from us not having asked.
    expect(p.conversionRateRanking).toBe("unknown");
  });

  it("🔴 maps an unrecognised value to `unknown` rather than storing it", () => {
    // The column is a Postgres enum; an unmapped string is a write that throws
    // mid-sync and loses the rest of the batch.
    const p = parseInsightRow(row({ quality_ranking: "SOMETHING_NEW" }) as never);
    expect(p.qualityRanking).toBe("unknown");
  });

  it("maps absent or blank to null, which is not the same as unknown", () => {
    expect(parseInsightRow(row() as never).qualityRanking).toBeNull();
    expect(parseInsightRow(row({ quality_ranking: "  " }) as never).qualityRanking).toBeNull();
    expect(parseInsightRow(row({ quality_ranking: 7 }) as never).qualityRanking).toBeNull();
  });
});

describe("parseInsightRow — identity fields", () => {
  it("keeps ids as strings and defaults missing ones to empty", () => {
    const p = parseInsightRow(row() as never);

    // 🔴 Never a number: Meta's ids exceed 2^53 and JSON-parsing them as
    // numbers silently rounds, so two campaigns can collide.
    expect(p.campaignId).toBe("23851234567890123");
    expect(typeof p.campaignId).toBe("string");
    // Campaign-level rows carry no adset/ad id.
    expect(p.adsetId).toBe("");
    expect(p.adId).toBe("");
    expect(p.adsetName).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Breakdowns
 * ------------------------------------------------------------------ */

describe("segmentLabel", () => {
  const spec = (key: string) => META_BREAKDOWNS.find((b) => b.key === key)!;

  it("joins a multi-field placement into one unit", () => {
    // Splitting these apart would lose "Instagram Reels" as a unit and leave
    // only "Instagram, somewhere".
    expect(
      segmentLabel(spec("placement"), {
        publisher_platform: "instagram",
        platform_position: "instagram_reels",
      }),
    ).toBe("Instagram · Instagram reels");
  });

  it("prettifies known words and title-cases the rest", () => {
    expect(segmentLabel(spec("device"), { impression_device: "android_smartphone" })).toBe(
      "Android phone",
    );
    expect(segmentLabel(spec("gender"), { gender: "female" })).toBe("Female");
    expect(segmentLabel(spec("region"), { region: "California" })).toBe("California");
    expect(segmentLabel(spec("age"), { age: "25-34" })).toBe("25-34");
  });

  it("🔴 preserves `unknown` rather than dropping or relabelling it", () => {
    // Meta genuinely cannot classify some impressions. Folding them into a real
    // segment would overstate that segment.
    expect(segmentLabel(spec("gender"), { gender: "unknown" })).toBe("Unknown");
  });

  it("returns `unknown` when the segment fields are absent or wrong-typed", () => {
    expect(segmentLabel(spec("age"), {})).toBe("unknown");
    expect(segmentLabel(spec("age"), { age: 25 })).toBe("unknown");
    // A partial placement still labels with what it has, rather than dropping
    // the row entirely.
    expect(segmentLabel(spec("placement"), { publisher_platform: "facebook" })).toBe(
      "Facebook",
    );
  });
});

describe("META_BREAKDOWNS", () => {
  it("every spec's api string matches its segment fields", () => {
    // These are sent to Meta as one param and read back as separate columns; if
    // they disagree the row parses to "unknown" for every segment.
    for (const spec of META_BREAKDOWNS) {
      expect(spec.apiBreakdowns.split(",")).toEqual(spec.segmentFields);
    }
  });

  it("has unique keys, since they key a database enum", () => {
    const keys = META_BREAKDOWNS.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/* ------------------------------------------------------------------ *
 * Request shape
 * ------------------------------------------------------------------ */

describe("insightFields", () => {
  it("asks for the video and ranking fields only below campaign level", () => {
    const campaign = insightFields("campaign").split(",");
    const ad = insightFields("ad").split(",");

    // Requesting ad-level fields at campaign level is an API error, not an
    // empty column.
    expect(campaign).not.toContain("video_play_actions");
    expect(campaign).not.toContain("quality_ranking");
    expect(ad).toContain("video_play_actions");
    expect(ad).toContain("quality_ranking");
    expect(insightFields("adset")).toContain("adset_id");
  });

  it("always asks for the fields the parser reads", () => {
    const campaign = insightFields("campaign").split(",");
    for (const f of ["actions", "spend", "impressions", "reach", "inline_link_clicks"]) {
      expect(campaign).toContain(f);
    }
  });

  it("leaves only the rankings out when told to", () => {
    const all = insightFields("ad").split(",");
    const without = insightFields("ad", { rankings: false }).split(",");
    expect(without).toEqual(all.filter((f) => !(RANKING_FIELDS as readonly string[]).includes(f)));
    expect(all.length - without.length).toBe(RANKING_FIELDS.length);
  });
});

describe("an ad-level window Meta times out on", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ok = (body: unknown) =>
    ({ ok: true, status: 200, headers: new Headers(), json: async () => body }) as unknown as Response;
  const timedOut = (code: number, subcode: number, message: string) =>
    ({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => ({ error: { code, error_subcode: subcode, message } }),
    }) as unknown as Response;
  /** One row a day for ad `a1` across the window asked for. */
  const figures = (u: URL) => {
    const { since, until } = JSON.parse(u.searchParams.get("time_range") ?? "{}");
    const data = [];
    for (let d = since; d <= until; d = shiftDateKey(d, 1)) data.push({ ad_id: "a1", date_start: d, spend: "1" });
    return ok({ data });
  };
  const isCombined = (u: URL) => /quality_ranking/.test(u.searchParams.get("fields") ?? "") && /spend/.test(u.searchParams.get("fields") ?? "");
  const isRankingsOnly = (u: URL) => u.searchParams.get("fields") === ["ad_id", ...RANKING_FIELDS].join(",");

  it("recognises Meta giving up on a heavy request, and only that", () => {
    expect(isMetaTimeout(new MetaApiError("An unknown error occurred", 500, 1, 99))).toBe(true);
    expect(isMetaTimeout(new MetaApiError("Service temporarily unavailable", 503, 2, 1504044))).toBe(true);
    // Its own message, its own path: the window is halved in sync.ts.
    expect(isMetaTimeout(new MetaApiError("Please reduce the amount of data you're asking for, then retry your request", 500, 1))).toBe(false);
    expect(isMetaTimeout(new MetaApiError("Error validating access token", 400, 190))).toBe(false);
    expect(isMetaTimeout(new Error("An unknown error occurred"))).toBe(false);
  });

  it("🔴 asks a week at a time without the rankings, gets the rankings apart, and joins them on ad and day", async () => {
    // Clearview, 2 Nov 2026: the one request failed every night; the parts take 4–13 s each.
    const seen: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(String(url));
        seen.push(u);
        if (isCombined(u)) return timedOut(1, 99, "An unknown error occurred");
        if (isRankingsOnly(u)) {
          return ok({
            data: [
              {
                ad_id: "a1",
                date_start: "2026-10-31",
                quality_ranking: "ABOVE_AVERAGE",
                engagement_rate_ranking: "AVERAGE",
                conversion_rate_ranking: "BELOW_AVERAGE_10",
              },
            ],
          });
        }
        return figures(u);
      }),
    );

    const rows = await new MetaClient("tok").getDailyInsights("act_1", "2026-10-05", "2026-11-01", "ad");

    expect(rows).toHaveLength(28);
    const weeks = seen.slice(1, -1);
    expect(weeks.map((u) => JSON.parse(u.searchParams.get("time_range")!))).toEqual([
      { since: "2026-10-05", until: "2026-10-11" },
      { since: "2026-10-12", until: "2026-10-18" },
      { since: "2026-10-19", until: "2026-10-25" },
      { since: "2026-10-26", until: "2026-11-01" },
    ]);
    for (const u of weeks) {
      expect(u.searchParams.get("fields")).not.toMatch(/ranking/);
      // Everything else the nightly asks for is still asked for.
      expect(u.searchParams.get("fields")).toContain("results");
    }
    const last = seen[seen.length - 1];
    expect(isRankingsOnly(last)).toBe(true);
    expect(JSON.parse(last.searchParams.get("time_range")!)).toEqual({ since: "2026-10-05", until: "2026-11-01" });

    expect(rows.filter((r) => r.quality_ranking)).toEqual([
      expect.objectContaining({
        ad_id: "a1",
        date_start: "2026-10-31",
        spend: "1",
        quality_ranking: "ABOVE_AVERAGE",
        engagement_rate_ranking: "AVERAGE",
        conversion_rate_ranking: "BELOW_AVERAGE_10",
      }),
    ]);
  });

  it("keeps the rows when the rankings fail as well", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(String(url));
        if (isCombined(u)) return timedOut(2, 1504044, "Service temporarily unavailable");
        if (isRankingsOnly(u)) return timedOut(1, 99, "An unknown error occurred");
        return figures(u);
      }),
    );
    const rows = await new MetaClient("tok").getDailyInsights("act_1", "2026-10-26", "2026-11-01", "ad");
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.spend === "1" && r.quality_ranking === undefined)).toBe(true);
  });

  it("throws a week that still times out", async () => {
    const spy = vi.fn(async () => timedOut(1, 99, "An unknown error occurred"));
    vi.stubGlobal("fetch", spy);
    const err = await new MetaClient("tok")
      .getDailyInsights("act_1", "2026-10-26", "2026-11-01", "ad")
      .catch((e: unknown) => e);
    expect(isMetaTimeout(err)).toBe(true);
    // The whole window once, then its first week; no rankings asked for rows that never came.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("🔴 never splits campaign level, and never splits any other failure", async () => {
    const timeout = vi.fn(async () => timedOut(1, 99, "An unknown error occurred"));
    vi.stubGlobal("fetch", timeout);
    await expect(
      new MetaClient("tok").getDailyInsights("act_1", "2026-10-05", "2026-11-01", "campaign"),
    ).rejects.toBeInstanceOf(MetaApiError);
    expect(timeout).toHaveBeenCalledTimes(1);

    const badToken = vi.fn(
      async () =>
        ({
          ok: false,
          status: 400,
          headers: new Headers(),
          json: async () => ({ error: { code: 190, message: "Error validating access token" } }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", badToken);
    await expect(
      new MetaClient("tok").getDailyInsights("act_1", "2026-10-05", "2026-11-01", "ad"),
    ).rejects.toBeInstanceOf(MetaApiError);
    expect(badToken).toHaveBeenCalledTimes(1);
  });
});

describe("metaVersion", () => {
  const original = process.env.META_API_VERSION;
  afterEach(() => {
    if (original === undefined) delete process.env.META_API_VERSION;
    else process.env.META_API_VERSION = original;
  });

  it("🔴 always yields a pinned version, never an empty string", () => {
    /*
     * An expired Marketing API version does NOT error — Meta silently falls
     * back to the next oldest usable version, changing behaviour with no
     * signal. An unset env var must therefore land on the pinned default rather
     * than on an unversioned URL.
     */
    delete process.env.META_API_VERSION;
    expect(metaVersion()).toMatch(/^v\d+\.\d+$/);

    process.env.META_API_VERSION = "";
    expect(metaVersion()).toMatch(/^v\d+\.\d+$/);

    process.env.META_API_VERSION = "v26.0";
    expect(metaVersion()).toBe("v26.0");
  });
});

describe("MetaApiError.isRateLimit", () => {
  const err = (code: number) => new MetaApiError("x", 400, code);

  it("recognises the throttling codes worth retrying", () => {
    for (const code of [4, 17, 32, 613, 80000, 80004]) {
      expect(err(code).isRateLimit).toBe(true);
    }
  });

  it("🔴 does not treat a permissions or bad-request failure as throttling", () => {
    // Retrying one of these burns quota and delays the real error reaching the
    // health checklist, where it would name the actual problem.
    for (const code of [1, 10, 100, 190, 200, 803]) {
      expect(err(code).isRateLimit).toBe(false);
    }
    expect(new MetaApiError("x", 400).isRateLimit).toBe(false);
  });
});

describe("results fields", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for Ads Manager's results and the objective at every level, unless told not to", () => {
    for (const level of ["campaign", "ad"] as const) {
      const fields = insightFields(level).split(",");
      expect(fields).toContain("results");
      expect(fields).toContain("objective");
      expect(insightFields(level, { results: false }).split(",")).not.toContain("results");
    }
  });

  it("recognises only a refusal of those fields", () => {
    const refusal = (code: number, message: string) => new MetaApiError(message, 400, code);
    expect(isResultFieldRefusal(refusal(100, "(#100) Tried accessing nonexisting field (results) on node type (AdsInsights)"))).toBe(true);
    expect(isResultFieldRefusal(refusal(100, "(#100) objective is not valid for fields param."))).toBe(true);
    expect(isResultFieldRefusal(refusal(100, "(#100) Param time_range is invalid"))).toBe(false);
    expect(isResultFieldRefusal(refusal(190, "Error validating access token: results"))).toBe(false);
    expect(isResultFieldRefusal(new Error("results"))).toBe(false);
  });

  it("🔴 retries once without them, so spend never depends on the results feature", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const fields = new URL(String(url)).searchParams.get("fields") ?? "";
        seen.push(fields);
        return fields.includes("results")
          ? ({
              ok: false,
              status: 400,
              headers: new Headers(),
              json: async () => ({ error: { code: 100, message: "(#100) Tried accessing nonexisting field (results)" } }),
            } as unknown as Response)
          : ({
              ok: true,
              status: 200,
              headers: new Headers(),
              json: async () => ({ data: [{ campaign_id: "1", spend: "5", date_start: "2026-09-01" }] }),
            } as unknown as Response);
      }),
    );
    const rows = await new MetaClient("tok").getDailyInsights("act_1", "2026-09-01", "2026-09-01");
    expect(rows).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toContain("results");
  });

  it("does not retry any other failure", async () => {
    const spy = vi.fn(
      async () =>
        ({
          ok: false,
          status: 400,
          headers: new Headers(),
          json: async () => ({ error: { code: 190, message: "Error validating access token" } }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", spy);
    await expect(
      new MetaClient("tok").getDailyInsights("act_1", "2026-09-01", "2026-09-01"),
    ).rejects.toBeInstanceOf(MetaApiError);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("ad preview links", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ok = (body: unknown) =>
    ({ ok: true, status: 200, headers: new Headers(), json: async () => body }) as unknown as Response;
  const refused = (message: string) =>
    ({
      ok: false,
      status: 400,
      headers: new Headers(),
      json: async () => ({ error: { code: 100, message } }),
    }) as unknown as Response;

  it("asks for each ad's preview link, and for ARCHIVED ads only when told to", async () => {
    const seen: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(new URL(String(url)));
        return ok({ data: [{ id: "1", preview_shareable_link: "https://fb.me/x" }] });
      }),
    );
    const ads = await new MetaClient("tok").getAds("act_1");
    expect(ads[0].preview_shareable_link).toBe("https://fb.me/x");
    expect(seen[0].searchParams.get("fields")).toContain("preview_shareable_link");
    expect(seen[0].searchParams.get("effective_status")).toBeNull();

    await new MetaClient("tok").getAds("act_1", { statuses: ["ARCHIVED"] });
    expect(seen[1].searchParams.get("effective_status")).toBe('["ARCHIVED"]');
  });

  it("🔴 lists the ads anyway when Meta refuses the link — thumbnails must not depend on it", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const fields = new URL(String(url)).searchParams.get("fields") ?? "";
        seen.push(fields);
        return fields.includes("preview_shareable_link")
          ? refused("(#100) Tried accessing nonexisting field (preview_shareable_link) on node type (Ad)")
          : ok({ data: [{ id: "1" }] });
      }),
    );
    const ads = await new MetaClient("tok").getAds("act_1");
    expect(ads).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toContain("preview_shareable_link");
  });

  it("recognises only a refusal of the fields it was given", () => {
    const refusal = (code: number, message: string) => new MetaApiError(message, 400, code);
    expect(isFieldRefusal(refusal(100, "(#100) Tried accessing nonexisting field (preview_shareable_link)"), ["preview_shareable_link"])).toBe(true);
    expect(isFieldRefusal(refusal(100, "(#100) Param limit is invalid"), ["preview_shareable_link"])).toBe(false);
    expect(isFieldRefusal(refusal(190, "preview_shareable_link"), ["preview_shareable_link"])).toBe(false);
  });
});

describe("the ads listing", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ok = (body: unknown) =>
    ({ ok: true, status: 200, headers: new Headers(), json: async () => body }) as unknown as Response;
  const tooMuch = () =>
    ({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => ({
        error: { code: 1, message: "Please reduce the amount of data you're asking for, then retry your request" },
      }),
    }) as unknown as Response;
  const page = (ids: string[], after?: string) =>
    ok({
      data: ids.map((id) => ({ id })),
      ...(after ? { paging: { next: "https://graph.facebook.com/v25.0/act_1/ads?after=x", cursors: { after } } } : {}),
    });
  /** Every request's page size and cursor, in order. */
  function stub(answer: (u: URL) => Response) {
    const seen: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(String(url));
        seen.push(u);
        return answer(u);
      }),
    );
    return seen;
  }
  const pages = (seen: URL[]) => seen.map((u) => [u.searchParams.get("limit"), u.searchParams.get("after")]);

  it("🔴 asks for 100 ads a page, not 200, and follows Meta's cursor", async () => {
    // From 23 Oct 2026 Meta refused 200 ads a page with the creative attached
    // on every account with more than ~150 ads; 100 was accepted.
    const seen = stub((u) => (u.searchParams.get("after") ? page(["2"]) : page(["1"], "c1")));
    const ads = await new MetaClient("tok").getAds("act_1");
    expect(ads.map((a) => a.id)).toEqual(["1", "2"]);
    expect(pages(seen)).toEqual([
      ["100", null],
      ["100", "c1"],
    ]);
  });

  it("🔴 asks again from the same place at half the page when Meta says it is too much", async () => {
    const seen = stub((u) => {
      if (!u.searchParams.get("after")) return page(["1"], "c1");
      return Number(u.searchParams.get("limit")) > 25 ? tooMuch() : page(["2"]);
    });
    const ads = await new MetaClient("tok").getAds("act_1");
    expect(ads.map((a) => a.id)).toEqual(["1", "2"]);
    expect(pages(seen)).toEqual([
      ["100", null],
      ["100", "c1"],
      ["50", "c1"],
      ["25", "c1"],
    ]);
  });

  it("gives up when Meta refuses even 25 ads", async () => {
    const seen = stub(() => tooMuch());
    await expect(new MetaClient("tok").getAds("act_1")).rejects.toThrow(/reduce the amount of data/);
    expect(pages(seen).map(([limit]) => limit)).toEqual(["100", "50", "25"]);
  });

  it("🔴 asks for given ads by id, 50 to a request — and asks nothing for none", async () => {
    const seen = stub(() => page([]));
    const ids = Array.from({ length: 120 }, (_, i) => String(1000 + i));
    await new MetaClient("tok").getAds("act_1", { adIds: [...ids, ids[0]], statuses: ["ARCHIVED"] });
    const filters = seen.map((u) => JSON.parse(u.searchParams.get("filtering")!));
    expect(filters.map((f) => [f[0].field, f[0].operator, f[0].value.length])).toEqual([
      ["ad.id", "IN", 50],
      ["ad.id", "IN", 50],
      ["ad.id", "IN", 20],
    ]);
    expect(filters.flatMap((f) => f[0].value)).toEqual(ids);
    expect(seen.every((u) => u.searchParams.get("effective_status") === '["ARCHIVED"]')).toBe(true);

    seen.length = 0;
    expect(await new MetaClient("tok").getAds("act_1", { adIds: [] })).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("refuses an ad id that is not a number", async () => {
    const seen = stub(() => page([]));
    await expect(new MetaClient("tok").getAds("act_1", { adIds: ["1", "2&limit=9"] })).rejects.toThrow(
      /Invalid Meta ad id/,
    );
    expect(seen).toEqual([]);
  });

  it("refuses a partial list when a next page comes without a cursor", async () => {
    stub(() => ok({ data: [{ id: "1" }], paging: { next: "https://graph.facebook.com/v25.0/act_1/ads?offset=1" } }));
    await expect(new MetaClient("tok").getAds("act_1")).rejects.toThrow(/without a cursor/);
  });

  it("recognises Meta asking for a smaller request, and only that", () => {
    expect(isReduceDataError(new MetaApiError("Please reduce the amount of data you're asking for, then retry your request", 500, 1))).toBe(true);
    expect(isReduceDataError(new MetaApiError("(#17) User request limit reached", 400, 17))).toBe(false);
  });
});

describe("paging past the first page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("🔴 keeps Meta's own error on a later page — 'reduce the amount of data' must still read as that", async () => {
    // The window split (`pullAdLevel`) keys on Meta's message. A bare
    // "pagination failed" on page 3 would fail the sync instead of halving.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(String(url));
        if (!u.searchParams.has("after")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              data: [{ date_start: "2026-09-01", campaign_id: "1" }],
              paging: { next: "https://graph.facebook.com/v25.0/act_1/insights?after=c2" },
            }),
          } as unknown as Response;
        }
        return {
          ok: false,
          status: 500,
          headers: new Headers(),
          json: async () => ({
            error: { code: 1, message: "Please reduce the amount of data you're asking for, then retry your request" },
          }),
        } as unknown as Response;
      }),
    );
    const err = await new MetaClient("tok")
      .getDailyInsights("act_1", "2026-09-01", "2026-09-30", "ad")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).code).toBe(1);
    expect(isReduceDataError(err)).toBe(true);
  });
});
