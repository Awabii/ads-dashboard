import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  STRIPE_API_VERSION,
  StripeApiError,
  formEncode,
  stripeKeyMode,
  stripeList,
  stripeRequest,
} from "./client";

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_abc");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("formEncode", () => {
  it("encodes nested objects and arrays the way Stripe reads them", () => {
    const body = formEncode({
      customer: "cus_1",
      items: [{ price: "price_1", quantity: 42 }],
      billing_cycle_anchor_config: { day_of_month: 1 },
      metadata: { gg_agency_id: "a-1" },
      livemode: false,
    });
    expect(decodeURIComponent(body).split("&")).toEqual([
      "customer=cus_1",
      "items[0][price]=price_1",
      "items[0][quantity]=42",
      "billing_cycle_anchor_config[day_of_month]=1",
      "metadata[gg_agency_id]=a-1",
      "livemode=false",
    ]);
  });

  it("🔴 leaves out undefined and null instead of sending an empty string", () => {
    // An empty string is how Stripe is told to CLEAR a field.
    expect(formEncode({ a: undefined, b: null, c: "x" })).toBe("c=x");
  });
});

describe("stripeKeyMode", () => {
  it("tells a sandbox key from a live one", () => {
    expect(stripeKeyMode("sk_test_x")).toBe("test");
    expect(stripeKeyMode("rk_test_x")).toBe("test");
    expect(stripeKeyMode("rk_live_x")).toBe("live");
    expect(stripeKeyMode("sk_live_x")).toBe("live");
  });

  it("refuses a missing or publishable key", () => {
    expect(stripeKeyMode("")).toBeNull();
    expect(stripeKeyMode("pk_live_x")).toBeNull();
  });
});

describe("stripeRequest", () => {
  it("POSTs a form body with the key, the pinned version and an idempotency key", async () => {
    fetchMock.mockResolvedValue(ok({ id: "sub_1" }));
    await stripeRequest("POST", "/subscriptions", { customer: "cus_1" }, { idempotencyKey: "k1" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.stripe.com/v1/subscriptions");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("customer=cus_1");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer sk_test_abc",
      "Stripe-Version": STRIPE_API_VERSION,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": "k1",
    });
  });

  it("puts GET parameters in the query string, with no body", async () => {
    fetchMock.mockResolvedValue(ok({ data: [] }));
    await stripeRequest("GET", "/customers", { email: "rj@example.com" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.stripe.com/v1/customers?email=rj%40example.com");
    expect(init.body).toBeUndefined();
    expect(init.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("turns a Stripe error into a StripeApiError carrying its type and code", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such price" } }),
        { status: 404 },
      ),
    );
    const err = (await stripeRequest("GET", "/prices/price_x").catch((e) => e)) as StripeApiError;
    expect(err).toBeInstanceOf(StripeApiError);
    expect(err).toMatchObject({ status: 404, type: "invalid_request_error", code: "resource_missing" });
    expect(err.message).toBe("No such price");
  });

  it("refuses to run without a key", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    await expect(stripeRequest("GET", "/prices")).rejects.toThrow(/STRIPE_SECRET_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("stripeList", () => {
  it("follows has_more with starting_after until the last page", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ data: [{ id: "a" }, { id: "b" }], has_more: true }))
      .mockResolvedValueOnce(ok({ data: [{ id: "c" }], has_more: false }));

    const all = await stripeList<{ id: string }>("/subscriptions");
    expect(all.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.stripe.com/v1/subscriptions?limit=100");
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.stripe.com/v1/subscriptions?limit=100&starting_after=b",
    );
  });
});
