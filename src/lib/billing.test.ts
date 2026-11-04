import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./metrics/__testdb__/harness";

/**
 * The client count each billed agency's Stripe subscription is kept at.
 *
 * Against a real Postgres for the count (active only, per agency), with
 * Stripe's API stubbed at `fetch` — the sync's whole job is which calls it
 * makes, and which it must never make.
 */

let harness: { db: TestDb; close: () => Promise<void> };

vi.mock("@/db", () => ({
  get db() {
    return harness.db;
  },
  schema: {},
}));

let billing: typeof import("./billing");

const AGENCY_A = "aaaaaaaa-0000-4000-8000-000000000001";
const AGENCY_B = "aaaaaaaa-0000-4000-8000-000000000002";
/** An agency with no clients at all. */
const AGENCY_C = "aaaaaaaa-0000-4000-8000-000000000003";
/** In no agencies row. */
const GHOST = "aaaaaaaa-0000-4000-8000-0000000000ff";

const run = (q: string) => harness.db.execute(sql.raw(q));

beforeAll(async () => {
  harness = await createTestDb();
  billing = await import("./billing");
  for (const [id, slug] of [
    [AGENCY_A, "a"],
    [AGENCY_B, "b"],
    [AGENCY_C, "c"],
  ]) {
    await run(`INSERT INTO agencies (id, name, slug) VALUES ('${id}', 'Agency ${slug}', 'agency-${slug}')`);
  }
  // A: two active, one paused, one archived. B: one active.
  const seed: Array<[string, string]> = [
    [AGENCY_A, "active"],
    [AGENCY_A, "active"],
    [AGENCY_A, "paused"],
    [AGENCY_A, "archived"],
    [AGENCY_B, "active"],
  ];
  for (const [i, [agency, status]] of seed.entries()) {
    await run(
      `INSERT INTO clients (name, slug, agency_id, status) VALUES ('c${i}', 'c${i}', '${agency}', '${status}')`,
    );
  }
});

afterAll(async () => {
  await harness?.close();
});

/* ── Stripe, stubbed ─────────────────────────────────────────────────── */

const KEY = "gg_dashboard_per_client_monthly_usd";

function sub(id: string, agency: string | null, quantity: number, lookupKey = KEY, status = "active") {
  return {
    id,
    status,
    customer: "cus_x",
    metadata: agency ? { gg_agency_id: agency } : {},
    billing_cycle_anchor: 0,
    collection_method: "send_invoice",
    days_until_due: 7,
    items: {
      data: [
        {
          id: `si_${id}`,
          quantity,
          price: {
            id: "price_1",
            lookup_key: lookupKey,
            unit_amount: 700,
            currency: "usd",
            recurring: { interval: "month", interval_count: 1 },
            active: true,
          },
        },
      ],
    },
  };
}

let subscriptions: ReturnType<typeof sub>[] = [];
/** Subscription ids whose update Stripe refuses. */
let refuse = new Set<string>();
let fetchMock: ReturnType<typeof vi.fn>;

/** Every update the sync sent, as `[subscription id, form body]`. */
const updates = () =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([url, init]) => [String(url).split("/").pop(), decodeURIComponent(init.body)]);

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_abc");
  subscriptions = [];
  refuse = new Set();
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "GET" && url.startsWith("https://api.stripe.com/v1/subscriptions?")) {
      return Response.json({ data: subscriptions, has_more: false });
    }
    const id = url.split("/").pop()!;
    if (init.method === "POST" && refuse.has(id)) {
      return Response.json(
        { error: { type: "invalid_request_error", code: "resource_missing", message: "No such subscription" } },
        { status: 404 },
      );
    }
    if (init.method === "POST") return Response.json({ id });
    throw new Error(`unexpected Stripe call: ${init.method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/* ── Tests ───────────────────────────────────────────────────────────── */

describe("activeClientCounts", () => {
  it("counts only active clients, per agency", async () => {
    const counts = await billing.activeClientCounts([AGENCY_A, AGENCY_B, AGENCY_C]);
    expect(Object.fromEntries(counts)).toEqual({ [AGENCY_A]: 2, [AGENCY_B]: 1 });
  });
});

describe("syncBillingQuantities", () => {
  it("🔴 sets each subscription to its agency's active clients, and never prorates", async () => {
    subscriptions = [sub("sub_a", AGENCY_A, 1), sub("sub_b", AGENCY_B, 1), sub("sub_c", AGENCY_C, 3)];

    expect(await billing.syncBillingQuantities()).toEqual([
      { subscription: "sub_a", status: "updated", from: 1, to: 2 },
      { subscription: "sub_b", status: "unchanged", to: 1 },
      // An agency whose clients were all archived is billed for none.
      { subscription: "sub_c", status: "updated", from: 3, to: 0 },
    ]);
    expect(updates()).toEqual([
      ["sub_a", "items[0][id]=si_sub_a&items[0][quantity]=2&proration_behavior=none"],
      ["sub_c", "items[0][id]=si_sub_c&items[0][quantity]=0&proration_behavior=none"],
    ]);
  });

  it("🔴 never touches a subscription that is not the dashboard's", async () => {
    // The Stripe account is the agency's own and may bill other things.
    subscriptions = [
      sub("sub_other", null, 5),
      sub("sub_cancelled", AGENCY_A, 1, KEY, "canceled"),
      sub("sub_incomplete", AGENCY_A, 1, KEY, "incomplete"),
    ];
    expect(await billing.syncBillingQuantities()).toEqual([]);
    expect(updates()).toEqual([]);
  });

  it("🔴 reports an agency it does not know, rather than billing it for zero clients", async () => {
    subscriptions = [sub("sub_ghost", GHOST, 4), sub("sub_typo", "not-a-uuid", 4)];
    expect(await billing.syncBillingQuantities()).toEqual([
      { subscription: "sub_ghost", status: "failed", reason: "unknown agency" },
      { subscription: "sub_typo", status: "failed", reason: "unknown agency" },
    ]);
    expect(updates()).toEqual([]);
  });

  it("reports a subscription with no per-client item, and leaves it alone", async () => {
    subscriptions = [sub("sub_wrong", AGENCY_A, 1, "some_other_price")];
    expect(await billing.syncBillingQuantities()).toEqual([
      { subscription: "sub_wrong", status: "failed", reason: "no per-client item" },
    ]);
    expect(updates()).toEqual([]);
  });

  it("carries on past a subscription Stripe refuses to update", async () => {
    subscriptions = [sub("sub_a", AGENCY_A, 1), sub("sub_c", AGENCY_C, 3)];
    refuse.add("sub_a");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await billing.syncBillingQuantities()).toEqual([
      { subscription: "sub_a", status: "failed", reason: "resource_missing" },
      { subscription: "sub_c", status: "updated", from: 3, to: 0 },
    ]);
  });
});
