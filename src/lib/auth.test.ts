import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Negative-space authorization test.
 *
 * Rather than asserting that specific handlers are guarded — which only ever
 * covers the routes someone remembered to write a case for — this walks every
 * route file on disk and fails for any exported handler that names no guard.
 * A new endpoint is therefore denied by default at review time.
 *
 * This exists because nine handlers shipped with no authorization of their own,
 * relying entirely on the blanket `/api/*` deny in `src/proxy.ts`. That deny is
 * real, but it is one carve-out away from being removed, and it is enforced from
 * the session token's baked-in role claim rather than the database.
 */

const API_ROOT = join(process.cwd(), "src", "app", "api");

/**
 * Routes that must remain reachable without a staff session, and what secures
 * each one instead. Adding an entry here is the deliberate act of declaring a
 * route public — it should be hard to do by accident and obvious in review.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  "webhooks/crm/[token]/route.ts":
    "GoHighLevel cannot present a session; secured by the unguessable per-client webhook token in the path plus signature verification",
  "webhooks/crm/route.ts":
    "tokenless webhook fallback; resolves the tenant by locationId and persists the raw payload before parsing",
  "cron/meta-sync/route.ts": "guarded by the CRON_SECRET bearer token",
  "cron/google-sync/route.ts": "guarded by the CRON_SECRET bearer token",
  "cron/tiktok-sync/route.ts": "guarded by the CRON_SECRET bearer token",
  "cron/pacing/route.ts": "guarded by the CRON_SECRET bearer token",
  "cron/reports/route.ts": "guarded by the CRON_SECRET bearer token",
  "cron/billing/route.ts": "guarded by the CRON_SECRET bearer token",
  "auth/route.ts": "this is the endpoint that issues a session",
  "auth/forgot/route.ts":
    "requesting a reset link cannot require the session you have lost; rate-limited, and the response is identical whether or not the address has an account so it cannot be used as a membership oracle",
  "auth/reset/route.ts":
    "completing a reset cannot require the session you have lost; the HMAC-signed token in the body IS the credential, it covers the user's current password hash so it expires the instant it is used, and it is rate-limited",
  "auth/signup/route.ts":
    "self-serve sign-up cannot require a session; rate-limited to 3/min, writes inside one transaction so a half-made agency cannot exist, and issues NO session — the account it creates cannot be signed into until the address is confirmed",
  "auth/invite/route.ts":
    "accepting an invite cannot require a session — the invitee has no password yet; the HMAC-signed token in the body IS the credential, its signature covers the login's current password hash so it expires the instant a password is set, the write is a compare-and-set on that hash so two racing submits cannot both win, it issues NO session, and it is rate-limited",
  "auth/verify/route.ts":
    "confirming an address cannot require the session it unlocks; the HMAC-signed token in the body IS the credential, its signature covers email_verified_at so it expires the instant it is used, and it is rate-limited",
  "logout/route.ts": "clearing your own cookie requires no privilege",
  "oauth/callback/route.ts":
    "browser redirect target from GoHighLevel, which cannot carry our session cookie on a marketplace-initiated install; validates an HMAC-signed state parameter instead",
};

/**
 * Identifiers that count as naming a guard. Matched textually inside a handler
 * body — this is a smoke alarm, not a proof, and it is calibrated to catch the
 * realistic failure (someone forgets entirely) rather than a determined bypass.
 */
/* ------------------------------------------------------------------ *
 * Guards, by the tier they establish
 * ------------------------------------------------------------------ *
 *
 * 🔴 A LIST would be wrong here, and the reason is the whole point of the
 * rewrite. Adding `agencyGuard` to a flat allowlist of acceptable identifiers
 * makes it satisfy every route — including one that should be reachable only
 * by the platform tier. The weaker guard would silently pass, which is exactly
 * the failure this file exists to prevent, arriving through the file itself.
 *
 * So guards are grouped by what they PROVE, routes declare what they REQUIRE,
 * and a guard satisfies a route only if it proves at least as much.
 */

/** Ordered weakest → strongest. A guard satisfies its own tier and every one below. */
const TIERS = ["client", "agency", "superadmin"] as const;
type Tier = (typeof TIERS)[number];

const GUARDS_BY_TIER: Record<Tier, string[]> = {
  /*
   * Scoped to one client rather than to a role, and a legitimate guard — not a
   * weaker one. `clientAccessGuard` re-reads role and status from the database
   * on every call and checks the URL's slug against the session's granted
   * slugs, so a client-role user reaching their OWN branding asset is
   * authorized while any other slug is a 403.
   */
  client: ["clientAccessGuard"],
  agency: [
    "agencyGuard",
    "isAgencyOperator",
    /*
     * Stronger than a bare role check, and the reason it belongs here rather
     * than beside one: `requireClient` performs the role check AND the
     * tenant-scoped read in one call, so a route using it cannot have done the
     * first without the second. That was the actual bug — every
     * `/api/clients/[id]/*` route paired a correct guard with an unscoped
     * `getClientById(id)`, which in a single-tenant world was the same fact and
     * in a multi-tenant one is an IDOR on a guessed uuid.
     */
    "requireClient",
    /*
     * The `users/[id]` equivalent: proves the agency tier AND that the target
     * user belongs to the caller's agency, in one call. Both handlers there
     * previously did a role check and then an unscoped `getUserById(id)`, which
     * would reset another agency's admin password on a guessed uuid.
     */
    "requireUser",
  ],
  superadmin: [
    "superadminGuard",
    "isSuperadmin",
    /*
     * `staff` is the pre-tenancy role: it means "sees every row in the
     * database", so it proves MORE than the agency tier, not less, and it
     * satisfies anything. It leaves this table when it leaves the codebase.
     */
    "staffGuard",
    "staffOnly",
    "requireStaff",
    "isStaff",
  ],
};

/** Guards acceptable for a route at `tier` — its own, and everything stronger. */
function satisfying(tier: Tier): string[] {
  const from = TIERS.indexOf(tier);
  return TIERS.slice(from).flatMap((t) => GUARDS_BY_TIER[t]);
}

/**
 * Routes that need MORE than the agency tier.
 *
 * Empty, and asserted to be readable as such rather than left implicit: no API
 * route is platform-only today. `/audit` is the one superadmin surface and it
 * is a page, not a route. When the first one appears — cross-agency admin,
 * impersonation, billing — it goes here, and the test below then refuses an
 * `agencyGuard` on it.
 */
const SUPERADMIN_ROUTES: string[] = [];

/**
 * Routes a client-role user may legitimately reach for their OWN client.
 *
 * Listed by tier rather than in PUBLIC_ROUTES, because they are emphatically
 * not public and recording them as such would make this file lie about the
 * thing it exists to check.
 */
const CLIENT_TIER_ROUTES: string[] = [
  // A client sees their own logo on every page; without this the agency sees
  // branding the client — the only person it exists for — cannot even load.
  "c/[slug]/branding/route.ts",
  "c/[slug]/branding/logo/route.ts",
  // Which sections a client has hidden on their own dashboard is theirs to set.
  "c/[slug]/layout/route.ts",
  // Creative preview images, proxied from Meta. The creative grid is on the
  // client's own dashboard, so an agency-tier guard here would render it as a
  // wall of broken cards for exactly the person it is built for.
  "c/[slug]/creative/[key]/thumb/route.ts",
  /*
   * Their own numbers as a file. Client-tier by design — but listed here
   * DELIBERATELY rather than left to the matcher, which would have passed it
   * anyway for the wrong reason: the handler mentions `isAgencyOperator` inside
   * the gate that refuses `personal` datasets to clients, and this test matches
   * guard names as substrings anywhere in the body. That incidental mention
   * would have classified a client-tier route as agency-tier and hidden the
   * change entirely.
   *
   * The route's baseline guard really is `clientAccessGuard`; the agency check
   * inside it is per-dataset, not per-route. Saying so here keeps the
   * classification true if the lead-list gate is ever refactored away.
   */
  "c/[slug]/export/route.ts",
  /*
   * Their own widget board, which the agency and the client build together.
   * The handler reads the STORED board and refuses a client's save or reset
   * while the agency has locked it — the role check lives there, after this
   * tenant gate. `board/data` is one widget's numbers for the editor and for
   * tiles still loading, and `board/pdf` is the same board as a document:
   * both reads of the client's own figures.
   */
  "c/[slug]/board/route.ts",
  "c/[slug]/board/data/route.ts",
  "c/[slug]/board/pdf/route.ts",
];

function requiredTier(rel: string): Tier {
  if (SUPERADMIN_ROUTES.includes(rel)) return "superadmin";
  if (CLIENT_TIER_ROUTES.includes(rel)) return "client";
  // Agency is the default because almost everything here operates one book.
  return "agency";
}

const HANDLER_RE = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g;

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, acc);
    else if (entry === "route.ts") acc.push(full);
  }
  return acc;
}

/** Repo-relative-to-`api` path with forward slashes, so keys are portable. */
function apiPath(full: string): string {
  return full.slice(API_ROOT.length + 1).split(sep).join("/");
}

/** Each exported handler paired with its body — from its `export` to the next. */
function handlers(src: string): Array<{ method: string; body: string }> {
  const found = [...src.matchAll(HANDLER_RE)];
  return found.map((m, i) => ({
    method: m[1],
    body: src.slice(m.index, found[i + 1]?.index ?? src.length),
  }));
}

describe("API route authorization", () => {
  const files = routeFiles(API_ROOT);

  it("finds route files to check", () => {
    // Guards the guard: a broken walker would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(10);
  });

  it("every non-public handler names a guard strong enough for its tier", () => {
    const unguarded: string[] = [];

    for (const full of files) {
      const rel = apiPath(full);
      if (rel in PUBLIC_ROUTES) continue;

      const tier = requiredTier(rel);
      const accepted = satisfying(tier);
      const src = readFileSync(full, "utf8");
      for (const { method, body } of handlers(src)) {
        if (!accepted.some((g) => body.includes(g))) {
          unguarded.push(`${method} ${rel} (needs ${tier})`);
        }
      }
    }

    expect(
      unguarded,
      `These handlers have no authorization strong enough for their tier. Add \`const denied = await agencyGuard(); if (denied) return denied;\` — or \`requireClient(id)\` where the route takes a client id — or, if the route is genuinely public, add it to PUBLIC_ROUTES with the reason it is safe:\n  ${unguarded.join("\n  ")}`,
    ).toEqual([]);
  });

  it("🔴 every client-tier route CALLS clientAccessGuard, not merely names a guard", () => {
    /*
     * The tier check above matches guard names as substrings anywhere in a
     * handler. For a client-tier route that is too weak: the export route
     * mentions `isAgencyOperator(session)` inside its per-dataset gate, which
     * satisfies the agency tier all by itself — so deleting the route's actual
     * guard left this whole file green. Here the call itself is required,
     * with comments stripped so prose cannot stand in for code.
     */
    const missing: string[] = [];
    for (const rel of CLIENT_TIER_ROUTES) {
      const src = readFileSync(join(API_ROOT, ...rel.split("/")), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const { method, body } of handlers(src)) {
        if (!/await\s+clientAccessGuard\(/.test(body)) missing.push(`${method} ${rel}`);
      }
    }
    expect(missing, `Client-tier handlers without an awaited clientAccessGuard(...) call:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("every public-route exemption still exists on disk", () => {
    // Otherwise renaming a route silently drops it out of coverage: the stale
    // key matches nothing and the new path is checked by nobody.
    const stale = Object.keys(PUBLIC_ROUTES).filter(
      (rel) => !existsSync(join(API_ROOT, ...rel.split("/"))),
    );
    expect(stale, `Stale PUBLIC_ROUTES entries: ${stale.join(", ")}`).toEqual([]);
  });

  it("declares a reason for each exemption", () => {
    for (const [rel, reason] of Object.entries(PUBLIC_ROUTES)) {
      expect(reason.length, `${rel} needs a real justification`).toBeGreaterThan(20);
    }
  });
});

/**
 * The same negative-space discipline, one level up.
 *
 * `PUBLIC_ROUTES` above covers API handlers. It says nothing about PAGES, and
 * pages are where the dashboard actually lives — so the list of path prefixes
 * that skip the session check entirely deserves its own lock. Adding a prefix is
 * a one-line edit that silently exposes an entire subtree; this makes it a
 * two-line edit where the second line is a written justification in a test.
 */
const PUBLIC_PREFIX_REASONS: Record<string, string> = {
  "/api/webhooks/":
    "GoHighLevel cannot present a session; the unguessable per-client token in the path is the credential",
  "/api/cron/": "guarded by the CRON_SECRET bearer token instead of a session",
  "/api/auth": "the endpoint that issues a session cannot require one",
  "/api/logout": "clearing your own cookie requires no privilege",
  "/login": "the login page itself",
  "/forgot":
    "requesting a reset link — someone who cannot sign in cannot present a session; the page holds no data and its confirmation is identical whether or not the address has an account, so it reveals no membership",
  "/reset":
    "choosing a new password from an emailed link; the page renders only a form, and the HMAC-signed token is verified server-side on submit. The signature covers the user's current password hash, so a link stops verifying the instant the password changes — single-use without a tokens table",
  "/signup":
    "creating an account cannot require one; rate-limited to 3/min, and the account it creates cannot hold a session until the address is confirmed",
  "/invite":
    "choosing a password for a login someone else made; the invitee has none yet, so cannot present a session. The page renders only a form, and the HMAC-signed token is verified server-side on submit. The signature covers the login's current password hash, so a link stops verifying the instant a password is set",
  "/verify":
    "confirming an address cannot require the session that confirmation unlocks; the page renders only a button, and the HMAC-signed token is verified server-side on submit. The signature covers email_verified_at, so a link stops verifying the instant it is used",
  "/r/":
    "shared reports — the recipient is a client's board member or accountant with no login; the expiring, revocable token in the URL is the credential, verified against a stored hash before anything renders, and the report carries no lead-level data",
  "/about":
    "the application home page Google's OAuth verification requires to be reachable without signing in; contains no client data",
  "/legal/":
    "privacy policy and terms, likewise required to be publicly reachable by Google's OAuth verification; contain no client data",
  "/render/":
    "the report as fetched by the hosted PDF renderer, which has no session; the 90-second HMAC-signed token in the path covers the client and the range, and the page 404s on any failure",
  "/_next/": "framework build assets",
  /*
   * Two entries, not one prefix. `/favicon` was covering both by accident of
   * `startsWith`, and `src/app/icon.svg` builds as its own route that no entry
   * matched at all — so every logged-out page rendered without an icon,
   * including the ones a Google OAuth reviewer is asked to open.
   */
  "/icon.svg": "the app icon, needed by pages served without a session",
  "/favicon.ico": "static icon",
};

/* ------------------------------------------------------------------ *
 * Tenant scoping, per handler
 * ------------------------------------------------------------------ */

describe("client-scoped API routes", () => {
  /**
   * Every handler under `/api/clients/[id]/` must go through `requireClient`.
   *
   * 🔴 The guard test above is not enough, and here is the case that proved it.
   * `PATCH /api/clients/[id]` had a real, correct staff check and then wrote
   * `UPDATE clients WHERE id = $1` — rotating GHL tokens and flipping status on
   * ANY client in ANY agency, from a guessed uuid. It passed the guard test
   * because it WAS guarded. It survived the sweep that fixed its 29 siblings
   * because that sweep searched for the client read it was scoping, and this
   * route had no read at all: a handler with nothing to scope looks, to a
   * search, like a handler with nothing wrong.
   *
   * So the rule is positional, not textual. The `[id]` in the path IS a client
   * id, and every handler sitting under one has to prove it may use it.
   */
  const SCOPED_ROOT = join(API_ROOT, "clients", "[id]");

  function scopedRoutes(dir: string, acc: string[] = []): string[] {
    if (!existsSync(dir)) return acc;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) scopedRoutes(full, acc);
      else if (entry === "route.ts") acc.push(full);
    }
    return acc;
  }

  const files = scopedRoutes(SCOPED_ROOT);

  it("finds the routes it is checking", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("🔴 every handler under /api/clients/[id] resolves its client through requireClient", () => {
    const unscoped: string[] = [];
    for (const full of files) {
      const src = readFileSync(full, "utf8");
      const rel = apiPath(full);
      for (const { method, body } of handlers(src)) {
        if (!body.includes("requireClient")) unscoped.push(`${method} ${rel}`);
      }
    }
    expect(
      unscoped,
      `These take a client id in the URL and never establish that the caller ` +
        `owns it. Replace the guard-then-read pair with:
` +
        `  const got = await requireClient(id);
` +
        `  if ("denied" in got) return got.denied;
` +
        `  const { client } = got;
` +
        `and use \`client.id\` downstream:
  ${unscoped.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("proxy public prefixes", () => {
  const src = readFileSync(join(process.cwd(), "src", "proxy.ts"), "utf8");
  const block = src.slice(
    src.indexOf("const PUBLIC_PREFIXES"),
    src.indexOf("]", src.indexOf("const PUBLIC_PREFIXES")),
  );
  const declared = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  it("parses the list it is checking", () => {
    expect(declared.length).toBeGreaterThan(4);
  });

  it("every unauthenticated prefix has a written justification", () => {
    const undocumented = declared.filter((p) => !(p in PUBLIC_PREFIX_REASONS));
    expect(
      undocumented,
      `These path prefixes skip authentication for the WHOLE subtree beneath them. Add each to PUBLIC_PREFIX_REASONS with why it is safe:\n  ${undocumented.join("\n  ")}`,
    ).toEqual([]);
  });

  it("has no stale justifications for prefixes that were removed", () => {
    const stale = Object.keys(PUBLIC_PREFIX_REASONS).filter(
      (p) => !declared.includes(p),
    );
    expect(stale).toEqual([]);
  });

  it("does not expose the dashboard or admin subtrees", () => {
    // The blunt check: no prefix may make client dashboards, setup, the audit
    // log, the user admin, or the whole API tree reachable without a session.
    const forbidden = ["/c/", "/api/", "/api/clients", "/audit", "/users", "/"];
    for (const p of declared) {
      expect(forbidden, `"${p}" would expose an authenticated subtree`).not.toContain(p);
    }
  });
});
