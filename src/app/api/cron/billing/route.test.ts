import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import type { BillingSyncResult } from "@/lib/billing";

const sync = vi.fn<() => Promise<BillingSyncResult[]>>();
vi.mock("@/lib/billing", () => ({ syncBillingQuantities: () => sync() }));

const { GET } = await import("./route");

const call = (bearer?: string) =>
  GET(
    new NextRequest("https://dash.example.com/api/cron/billing", {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    }),
  );

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.stubEnv("STRIPE_SECRET_KEY", "rk_live_x");
  sync.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the billing cron", () => {
  it("requires the cron secret", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("wrong")).status).toBe(401);
    expect(sync).not.toHaveBeenCalled();
  });

  it("does nothing, and says so, until a Stripe key is set", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const res = await call("s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, skipped: "billing not configured" });
    expect(sync).not.toHaveBeenCalled();
  });

  it("answers 200 when every subscription is right", async () => {
    sync.mockResolvedValue([{ subscription: "sub_a", status: "updated", from: 41, to: 42 }]);
    const res = await call("s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deferred: 0 });
  });

  it("🔴 fails the call when any subscription could not be set — a wrong count is a wrong bill", async () => {
    sync.mockResolvedValue([
      { subscription: "sub_a", status: "unchanged", to: 42 },
      { subscription: "sub_b", status: "failed", reason: "unknown agency" },
    ]);
    const res = await call("s3cret");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false });
  });
});
