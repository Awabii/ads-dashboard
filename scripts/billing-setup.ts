/**
 * Starts billing an agency per client in Stripe. Run once per agency.
 *
 * Makes, each only if it is not there already (so a second run is harmless):
 *   1. the per-client price, $7.00 a month, found again by its lookup key;
 *   2. the agency as a Stripe customer, invoiced at the email given;
 *   3. its subscription: quantity = active clients now, FIRST BILL ON THE 1st
 *      of next month at 12:00 UTC, then the 1st of every month. Nothing is
 *      charged or sent before the first bill. Each invoice is emailed with a pay
 *      link, due in 7 days.
 *
 * From then on the billing cron keeps the quantity equal to the client count
 * (`src/lib/billing.ts`).
 *
 * Run from this folder, with STRIPE_SECRET_KEY in ../ads-dashboard/.env:
 *
 *   npx tsx --tsconfig tsconfig.json --env-file=../ads-dashboard/.env \
 *     scripts/billing-setup.ts "<agency name>" <billing email> [--simulate | --yes]
 *
 *   (no flag)   shows what it would do, and changes nothing
 *   --simulate  sandbox key only: builds the same subscription on a Stripe test
 *               clock, jumps to the first bill, prints that invoice, then
 *               deletes everything it made. Emails nobody.
 *   --yes       creates it for real, in whichever mode the key is
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { agencies } from "../src/db/schema";
import {
  AGENCY_METADATA_KEY,
  PER_CLIENT_PRICE_LOOKUP_KEY,
  PER_CLIENT_UNIT_AMOUNT,
  activeClientCounts,
} from "../src/lib/billing";
import {
  stripeKeyMode,
  stripeList,
  stripeRequest,
  type StripeCustomer,
  type StripeParams,
  type StripePrice,
  type StripeSubscription,
} from "../src/lib/stripe/client";

const DAYS_UNTIL_DUE = 7;
/** Noon UTC: already the 1st in the US, and still the 1st in Pakistan. */
const BILL_HOUR_UTC = 12;
const PRODUCT_NAME = "Ads dashboard — per client";
/**
 * The simulation's customer. Never the real address: a sandbox invoice should
 * not reach the agency, and `send_invoice` refuses a customer with no email.
 */
const SIMULATION_EMAIL = "billing-simulation@example.com";

type Agency = { id: string; name: string };

interface StripeInvoice {
  id: string;
  status: string | null;
  billing_reason: string | null;
  amount_due: number;
  due_date: number | null;
  lines: {
    data: Array<{
      description: string | null;
      amount: number;
      period: { start: number; end: number };
    }>;
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const [agencyName, email] = args.filter((a) => !a.startsWith("--"));
  const create = flags.has("--yes");
  const simulate = flags.has("--simulate");
  if (!agencyName || !email?.includes("@") || (create && simulate)) {
    console.error(
      'Usage: scripts/billing-setup.ts "<agency name>" <billing email> [--simulate | --yes]',
    );
    process.exit(1);
  }

  const mode = stripeKeyMode();
  if (!mode) throw new Error("STRIPE_SECRET_KEY is missing, or is not a secret or restricted key.");
  if (simulate && mode !== "test") {
    throw new Error("--simulate needs a sandbox key (sk_test_…): it makes and deletes test objects.");
  }

  const [agency] = await db
    .select({ id: agencies.id, name: agencies.name })
    .from(agencies)
    .where(eq(agencies.name, agencyName));
  if (!agency) throw new Error(`No agency named "${agencyName}".`);
  const count = (await activeClientCounts([agency.id])).get(agency.id) ?? 0;

  console.log(`Stripe:   ${mode === "live" ? "LIVE — real invoices" : "sandbox (test money only)"}`);
  console.log(
    `Agency:   ${agency.name} — ${count} active client(s) = ${money(count * PER_CLIENT_UNIT_AMOUNT)} a month at today's count`,
  );
  console.log(`Invoices: emailed to ${email}, due ${DAYS_UNTIL_DUE} days after each bill`);

  const price = await perClientPrice(create || simulate);

  if (simulate) {
    await simulateFirstBill(agency, price!, count);
    return;
  }

  /*
   * 🔴 One subscription per agency, whoever it was made for.
   *
   * Checked across every customer, not just the one for this email: a second
   * run with a corrected address would otherwise open a second subscription
   * beside the first, and the agency would be billed twice on the 1st.
   */
  const existing = (await stripeList<StripeSubscription>("/subscriptions")).find(
    (s) => s.metadata?.[AGENCY_METADATA_KEY] === agency.id,
  );
  if (existing) {
    console.log("Subscription: already exists — nothing to do.");
    describeSubscription(existing);
    return;
  }

  const customer = await agencyCustomer(agency, email, create);
  if (!create || !customer || !price) {
    console.log(
      `Subscription: would create — first bill ${utc(nextFirstOfMonth())}, ${count} × $7.00, then the 1st of every month`,
    );
    console.log("\nNothing was changed. Add --yes to create it.");
    return;
  }

  const sub = await stripeRequest<StripeSubscription>(
    "POST",
    "/subscriptions",
    subscriptionParams(customer.id, price.id, count, { [AGENCY_METADATA_KEY]: agency.id }),
    { idempotencyKey: `gg-billing-subscription-${agency.id}-${customer.id}` },
  );
  console.log("Subscription: created.");
  describeSubscription(sub);
}

/** The $7 price, made on first use. One that has the key but another amount is refused. */
async function perClientPrice(make: boolean): Promise<StripePrice | null> {
  const [found] = await stripeList<StripePrice>("/prices", {
    lookup_keys: [PER_CLIENT_PRICE_LOOKUP_KEY],
  });
  if (found) {
    const right =
      found.unit_amount === PER_CLIENT_UNIT_AMOUNT &&
      found.currency === "usd" &&
      found.recurring?.interval === "month" &&
      found.recurring.interval_count === 1;
    if (!right) {
      throw new Error(
        `Price ${found.id} carries the per-client lookup key but is not $7.00 a month. Fix or archive it in Stripe first.`,
      );
    }
    console.log(`Price:    found ${found.id} ($7.00 per client per month)`);
    return found;
  }
  if (!make) {
    console.log("Price:    would create $7.00 per client per month");
    return null;
  }
  const price = await stripeRequest<StripePrice>(
    "POST",
    "/prices",
    {
      currency: "usd",
      unit_amount: PER_CLIENT_UNIT_AMOUNT,
      recurring: { interval: "month" },
      lookup_key: PER_CLIENT_PRICE_LOOKUP_KEY,
      nickname: "$7 per client per month",
      product_data: { name: PRODUCT_NAME },
    },
    { idempotencyKey: `gg-billing-price-${PER_CLIENT_PRICE_LOOKUP_KEY}` },
  );
  console.log(`Price:    created ${price.id}`);
  return price;
}

/** The agency's customer: the one already tagged with its id, or a new one. */
async function agencyCustomer(
  agency: Agency,
  email: string,
  make: boolean,
): Promise<StripeCustomer | null> {
  const found = (await stripeList<StripeCustomer>("/customers", { email })).find(
    (c) => c.metadata?.[AGENCY_METADATA_KEY] === agency.id,
  );
  if (found) {
    console.log(`Customer: found ${found.id}`);
    return found;
  }
  if (!make) {
    console.log(`Customer: would create "${agency.name}" <${email}>`);
    return null;
  }
  const customer = await stripeRequest<StripeCustomer>(
    "POST",
    "/customers",
    { name: agency.name, email, metadata: { [AGENCY_METADATA_KEY]: agency.id } },
    { idempotencyKey: `gg-billing-customer-${agency.id}-${email}` },
  );
  console.log(`Customer: created ${customer.id}`);
  return customer;
}

/**
 * The subscription, identical for the real run and the simulation.
 *
 * `billing_cycle_anchor_config` puts the first bill on the 1st, and
 * `proration_behavior: none` makes the days until then free: Stripe creates no
 * invoice at all before the anchor, rather than one for the part-month.
 */
function subscriptionParams(
  customerId: string,
  priceId: string,
  quantity: number,
  metadata: Record<string, string>,
): StripeParams {
  return {
    customer: customerId,
    items: [{ price: priceId, quantity }],
    billing_cycle_anchor_config: { day_of_month: 1, hour: BILL_HOUR_UTC, minute: 0, second: 0 },
    proration_behavior: "none",
    collection_method: "send_invoice",
    days_until_due: DAYS_UNTIL_DUE,
    metadata,
  };
}

/**
 * The same subscription on a Stripe test clock, run forward to its first bill.
 *
 * Tagged `gg_simulation`, NOT `gg_agency_id`, so the billing cron would never
 * adopt it, and deleted at the end either way — deleting a test clock deletes
 * its customer and subscription with it.
 */
async function simulateFirstBill(agency: Agency, price: StripePrice, count: number) {
  const clock = await stripeRequest<{ id: string }>("POST", "/test_helpers/test_clocks", {
    frozen_time: Math.floor(Date.now() / 1000),
    name: "billing-setup --simulate",
  });
  try {
    const customer = await stripeRequest<StripeCustomer>("POST", "/customers", {
      name: `${agency.name} (simulation)`,
      email: SIMULATION_EMAIL,
      test_clock: clock.id,
    });
    const sub = await stripeRequest<StripeSubscription>(
      "POST",
      "/subscriptions",
      subscriptionParams(customer.id, price.id, count, { gg_simulation: agency.id }),
    );
    describeSubscription(sub);

    const before = await stripeList<StripeInvoice>("/invoices", { customer: customer.id });
    console.log(
      before.length === 0
        ? "\nBefore the first bill: no invoice, nothing charged ✓"
        : `\nBefore the first bill: ${before.length} invoice(s) — NOT EXPECTED:`,
    );
    before.forEach(printInvoice);

    // Two hours past the anchor: Stripe holds a new invoice as a draft for about an hour first.
    await advanceClock(clock.id, sub.billing_cycle_anchor + 2 * 3600);
    const after = await stripeList<StripeInvoice>("/invoices", { customer: customer.id });
    console.log(`\nAfter jumping to ${utc(sub.billing_cycle_anchor)}:`);
    after.forEach(printInvoice);
  } finally {
    await stripeRequest("DELETE", `/test_helpers/test_clocks/${clock.id}`);
    console.log("\nSimulation deleted (its test clock, customer and subscription).");
  }
}

async function advanceClock(id: string, frozenTime: number) {
  await stripeRequest("POST", `/test_helpers/test_clocks/${id}/advance`, { frozen_time: frozenTime });
  for (let i = 0; i < 60; i++) {
    const clock = await stripeRequest<{ status: string }>("GET", `/test_helpers/test_clocks/${id}`);
    if (clock.status === "ready") return;
    if (clock.status === "internal_failure") throw new Error("Stripe's test clock failed to advance.");
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Stripe's test clock was still advancing after two minutes.");
}

function describeSubscription(sub: StripeSubscription) {
  const item = sub.items.data.find((i) => i.price?.lookup_key === PER_CLIENT_PRICE_LOOKUP_KEY);
  const qty = item?.quantity ?? 0;
  console.log(`  ${sub.id} (${sub.status}), invoices due in ${sub.days_until_due ?? "?"} days`);
  console.log(
    `  First bill: ${utc(sub.billing_cycle_anchor)} — ${qty} × $7.00 = ${money(qty * PER_CLIENT_UNIT_AMOUNT)} at today's count`,
  );
  console.log("  Then the 1st of every month, at the client count the cron last set.");
}

function printInvoice(inv: StripeInvoice) {
  console.log(
    `  ${inv.id}: ${inv.status}, ${money(inv.amount_due)}, ${inv.billing_reason}, due ${inv.due_date ? utc(inv.due_date) : "-"}`,
  );
  for (const line of inv.lines.data) {
    console.log(
      `    ${line.description} — ${utc(line.period.start)} to ${utc(line.period.end)}: ${money(line.amount)}`,
    );
  }
}

/** Display only: where `billing_cycle_anchor_config` will land, for a dry run. */
function nextFirstOfMonth(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, BILL_HOUR_UTC) / 1000;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const utc = (sec: number) => new Date(sec * 1000).toUTCString().replace("GMT", "UTC");

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
