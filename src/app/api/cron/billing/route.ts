import { NextRequest, NextResponse } from "next/server";
import { safeEqual } from "@/lib/crypto";
import { syncBillingQuantities } from "@/lib/billing";

/**
 * Keeps each billed agency's Stripe subscription at its active-client count.
 *
 * Called by the reconcile workflow every 3 hours. Safe at any cadence: it
 * changes a quantity only when the count moved, and a change never creates a
 * charge (proration is off — see `@/lib/billing`). The invoice itself is
 * Stripe's, on the 1st, at whatever quantity this last set.
 *
 * 🔴 Any subscription it could not update fails the whole call (502).
 *
 * A wrong quantity is a wrong bill on the 1st, so it must not sit behind a
 * green tick: the workflow's `curl -f` turns the 502 into a failed run, which
 * emails the repository owner. Which subscription, and why, is in the
 * deployment's function logs — never in the public Actions log.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(bearer, secret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ ok: true, skipped: "billing not configured", deferred: 0, results: [] });
  }

  const results = await syncBillingQuantities();
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    console.error("[billing] subscriptions not updated:", failed);
  }
  return NextResponse.json(
    { ok: failed.length === 0, deferred: 0, results },
    { status: failed.length > 0 ? 502 : 200 },
  );
}
