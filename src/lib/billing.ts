import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { agencies, clients } from "@/db/schema";
import {
  StripeApiError,
  stripeList,
  stripeRequest,
  type StripeSubscription,
} from "@/lib/stripe/client";

/**
 * Billing an agency per client: $7 a month for each ACTIVE client.
 *
 * Stripe holds the subscription and sends the invoice; this app holds the
 * count. A billed agency has one subscription tagged `metadata.gg_agency_id`
 * with one item on the per-client price, and `syncBillingQuantities` keeps that
 * item's quantity equal to the agency's active clients. Paused and archived
 * clients are free.
 *
 * 🔴 Quantity changes never prorate.
 *
 * The bill on the 1st is the count on the 1st × the price, and a client added
 * on the 2nd is first charged on the next 1st — the rule agreed with the
 * agency, and one an invoice states in a single line ("42 × $7.00"). Prorating
 * would charge part-months on top, an amount nobody agreed to and nobody can
 * check against the dashboard.
 *
 * The subscription itself is made once, by `scripts/billing-setup.ts`.
 */

/** Finds the per-client price in any Stripe account, sandbox or live. */
export const PER_CLIENT_PRICE_LOOKUP_KEY = "gg_dashboard_per_client_monthly_usd";

/** $7.00, in cents. A price found with any other amount is refused, not used. */
export const PER_CLIENT_UNIT_AMOUNT = 700;

/** The subscription's link back to its agency. */
export const AGENCY_METADATA_KEY = "gg_agency_id";

/** Statuses that still invoice. Others are left alone. */
const BILLING_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);

/** Active clients per agency. An agency with none is absent, which reads as 0. */
export async function activeClientCounts(agencyIds: string[]): Promise<Map<string, number>> {
  if (agencyIds.length === 0) return new Map();
  const rows = await db
    .select({ agencyId: clients.agencyId, n: sql<number>`count(*)::int` })
    .from(clients)
    .where(and(inArray(clients.agencyId, agencyIds), eq(clients.status, "active")))
    .groupBy(clients.agencyId);
  return new Map(rows.map((r) => [r.agencyId, Number(r.n)]));
}

export type BillingSyncResult = {
  subscription: string;
  status: "updated" | "unchanged" | "failed";
  from?: number;
  to?: number;
  reason?: string;
};

/**
 * Sets every billed agency's subscription to its active-client count.
 *
 * Only subscriptions carrying `gg_agency_id` are touched: the Stripe account
 * is the agency's own and may bill other things, which this must never edit.
 * Safe at any cadence — it changes nothing when the count already matches,
 * and a change never creates a charge (see the note above).
 *
 * A failure on one subscription is reported and the rest still run. A failure
 * to list at all throws, which the cron turns into a failed run.
 */
export async function syncBillingQuantities(): Promise<BillingSyncResult[]> {
  const subs = (await stripeList<StripeSubscription>("/subscriptions")).filter(
    (s) => s.metadata?.[AGENCY_METADATA_KEY] && BILLING_STATUSES.has(s.status),
  );
  if (subs.length === 0) return [];

  const agencyIds = [...new Set(subs.map((s) => s.metadata[AGENCY_METADATA_KEY]))].filter(isUuid);
  const known = new Set(
    agencyIds.length === 0
      ? []
      : (
          await db.select({ id: agencies.id }).from(agencies).where(inArray(agencies.id, agencyIds))
        ).map((a) => a.id),
  );
  const counts = await activeClientCounts([...known]);

  const results: BillingSyncResult[] = [];
  for (const sub of subs) {
    const agencyId = sub.metadata[AGENCY_METADATA_KEY];
    /*
     * 🔴 An agency this app does not know is NOT billed for zero clients.
     *
     * A typo'd id, or a subscription copied from another environment, would
     * otherwise drop to quantity 0 and quietly stop billing. Reported instead,
     * so somebody looks.
     */
    if (!known.has(agencyId)) {
      results.push({ subscription: sub.id, status: "failed", reason: "unknown agency" });
      continue;
    }
    const item = sub.items.data.find((i) => i.price?.lookup_key === PER_CLIENT_PRICE_LOOKUP_KEY);
    if (!item) {
      results.push({ subscription: sub.id, status: "failed", reason: "no per-client item" });
      continue;
    }

    const want = counts.get(agencyId) ?? 0;
    const have = item.quantity ?? 0;
    if (have === want) {
      results.push({ subscription: sub.id, status: "unchanged", to: want });
      continue;
    }

    try {
      // No idempotency key: setting a quantity is idempotent by itself, and a
      // key would replay a stale answer — see `stripeRequest`.
      await stripeRequest("POST", `/subscriptions/${sub.id}`, {
        items: [{ id: item.id, quantity: want }],
        proration_behavior: "none",
      });
      results.push({ subscription: sub.id, status: "updated", from: have, to: want });
    } catch (err) {
      console.error(`[billing] could not set ${sub.id} to ${want}:`, err);
      results.push({
        subscription: sub.id,
        status: "failed",
        reason: err instanceof StripeApiError ? (err.code ?? err.type ?? "stripe error") : "error",
      });
    }
  }
  return results;
}

/** Postgres rejects a malformed uuid in `IN (…)`, which would fail the whole run. */
function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
