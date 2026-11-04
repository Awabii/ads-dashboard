/**
 * Stripe's REST API, for billing agencies per client (see `@/lib/billing`).
 *
 * Hand-rolled, like the Meta, Google and TikTok clients, rather than the
 * `stripe` package: billing touches a handful of endpoints, and what the SDK
 * would add over `fetch` is the form encoding and a pinned version header —
 * both below.
 *
 * The key is `STRIPE_SECRET_KEY`. In live mode it is a RESTRICTED key (`rk_live_`)
 * with Write on Customers, Products, Prices and Subscriptions and nothing else,
 * so a leak can change a subscription but cannot refund, pay out, or read a card.
 * A sandbox key (`sk_test_`) is for the setup script's dry runs only.
 */

/**
 * 🔴 Pinned, like Meta's `v25.0`.
 *
 * Unpinned, every request runs at the ACCOUNT's default version — whatever it
 * was when that Stripe account was opened, which for an older account predates
 * fields this code reads. Changing it is a deliberate edit, re-checked with the
 * setup script's `--simulate` run in a sandbox.
 */
export const STRIPE_API_VERSION = "2026-09-30.endive";

const BASE = "https://api.stripe.com/v1";

/** Stripe answers in seconds; a sync waiting longer than this has a problem. */
const TIMEOUT_MS = 20_000;

export type StripeValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | StripeValue[]
  | { [key: string]: StripeValue };

export type StripeParams = { [key: string]: StripeValue };

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | undefined,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

/**
 * Stripe's form encoding: `items[0][price]=…`, `metadata[key]=…`.
 *
 * `undefined` and `null` are left out rather than sent as empty strings — an
 * empty string is how Stripe is told to UNSET a field.
 */
export function formEncode(params: StripeParams): string {
  const out = new URLSearchParams();
  const walk = (name: string, value: StripeValue) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${name}[${i}]`, v));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(name ? `${name}[${k}]` : k, v);
    } else {
      out.append(name, String(value));
    }
  };
  walk("", params);
  return out.toString();
}

/** Sandbox or live, from the key's prefix. `null` for no key or a publishable one. */
export function stripeKeyMode(
  key: string | undefined = process.env.STRIPE_SECRET_KEY,
): "test" | "live" | null {
  if (!key) return null;
  if (/^(sk|rk)_test_/.test(key)) return "test";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  return null;
}

/**
 * One API call. GET and DELETE carry their parameters in the query string, POST
 * in a form body.
 *
 * `idempotencyKey` is for CREATES only, so a retried create returns the first
 * result instead of a second customer or subscription. Never pass one on an
 * update: Stripe replays a key's first response for 24 hours, so a count that
 * went 42 → 43 → 42 → 43 in a day would have its last change silently dropped.
 */
export async function stripeRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: StripeParams = {},
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");

  const encoded = formEncode(params);
  const isPost = method === "POST";
  const url = !isPost && encoded ? `${BASE}${path}?${encoded}` : `${BASE}${path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Stripe-Version": STRIPE_API_VERSION,
  };
  if (isPost) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  const res = await fetch(url, {
    method,
    headers,
    body: isPost ? encoded : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => null)) as
    | { error?: { type?: string; code?: string; message?: string } }
    | null;
  if (!res.ok) {
    // Stripe's message never contains the key (it masks it), so it is safe to keep.
    const e = json?.error ?? {};
    throw new StripeApiError(res.status, e.type, e.code, e.message ?? `Stripe HTTP ${res.status}`);
  }
  return json as T;
}

/** Every page of a list endpoint. Capped, so a runaway cursor cannot loop forever. */
export async function stripeList<T extends { id: string }>(
  path: string,
  params: StripeParams = {},
): Promise<T[]> {
  const all: T[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await stripeRequest<{ data: T[]; has_more: boolean }>("GET", path, {
      limit: 100,
      ...params,
      starting_after: startingAfter,
    });
    all.push(...res.data);
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return all;
}

/* The few fields billing reads. Stripe returns far more. */

export interface StripePrice {
  id: string;
  lookup_key: string | null;
  unit_amount: number | null;
  currency: string;
  recurring: { interval: string; interval_count: number } | null;
  active: boolean;
}

export interface StripeSubscriptionItem {
  id: string;
  quantity?: number;
  price: StripePrice;
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  metadata: Record<string, string>;
  billing_cycle_anchor: number;
  collection_method: string;
  days_until_due: number | null;
  items: { data: StripeSubscriptionItem[] };
}

export interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  metadata: Record<string, string>;
}
