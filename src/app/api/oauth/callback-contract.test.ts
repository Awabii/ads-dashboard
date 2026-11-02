import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * 🔴 An OAuth callback must hand off to somewhere that can actually finish the job.
 *
 * The Google flow was dead for exactly this reason and nothing caught it. The
 * callback exchanged the code, stashed the refresh token, wrote its audit row —
 * and then redirected to `/oauth/result?status=ok`, while that page reads
 * `status === "success"`. So a successful sign-in rendered the failure screen.
 * Even had the strings matched, the page does nothing with the stash, so the
 * flow ended one step before an account could be attached. The route was
 * documented in its own source as "the self-serve front door" and was
 * unreachable in practice.
 *
 * Two invariants, both silent when broken:
 *   1. A successful connect lands on the setup page, not on the result page.
 *   2. The query parameter the callback writes is the one the page reads.
 */

const APP = join(__dirname, "..", "..");

const read = (rel: string) => readFileSync(join(APP, rel), "utf8");

const RESULT_PAGE = read("oauth/result/page.tsx");

/** provider → [callback route, the param it writes, where the page reads it] */
const FLOWS = [
  {
    name: "meta",
    callback: "api/oauth/meta/callback/route.ts",
    param: "metaStash",
  },
  {
    name: "google",
    callback: "api/oauth/google/callback/route.ts",
    param: "googleStash",
  },
  {
    name: "tiktok",
    callback: "api/oauth/tiktok/callback/route.ts",
    param: "tiktokStash",
  },
] as const;

const SETUP_PAGE = read("c/[slug]/setup/page.tsx");

const WIZARD = readFileSync(join(APP, "..", "components", "SetupWizard.tsx"), "utf8");

describe("OAuth callback → setup handoff", () => {
  it.each(FLOWS)("$name success returns to the setup page", ({ callback, param }) => {
    const src = read(callback);
    expect(src).toMatch(/back\.pathname = `\/c\/\$\{client\.slug\}\/setup`/);
    expect(src).toContain(`back.searchParams.set("${param}"`);
  });

  it.each(FLOWS)("🔴 $name comes back to its own section, not the top of the page", ({ name, callback }) => {
    // A fresh load opens at the top, two or three sections above the picker the
    // operator came back for. The anchor the callback names must exist.
    expect(read(callback)).toContain(`back.hash = SETUP_SECTION.${name};`);
    expect(WIZARD).toContain(`anchor={SETUP_SECTION.${name}}`);
  });

  it.each(FLOWS)("$name writes a param the setup page reads", ({ param }) => {
    // The handoff is a contract between two files with nothing linking them.
    // A rename on either side leaves a flow that completes and does nothing.
    expect(
      SETUP_PAGE.includes(`sp.${param}`),
      `setup/page.tsx never reads sp.${param} — the ${param} handoff is broken`,
    ).toBe(true);
    expect(SETUP_PAGE).toContain(`${param}?: string`);
  });

  it.each(FLOWS)("$name has no success branch left on the error redirect", ({ callback }) => {
    /*
     * The dead `ok: true` branch is what carried the wrong `status=ok`. Keeping
     * it around would let someone route a success back through the helper and
     * silently reintroduce the failure screen.
     */
    const src = read(callback);
    expect(src).not.toMatch(/ok: true/);
    expect(src).not.toMatch(/searchParams\.set\("status", "ok"\)/);
  });

  it("🔴 no callback claims success with a status the result page rejects", () => {
    /*
     * The result page treats ANYTHING that is not exactly "success" as a
     * failure, so this is the whole contract. GHL sends "success" and was
     * always correct; Meta and Google sent "ok" and were not.
     */
    expect(RESULT_PAGE).toContain('sp.status === "success"');

    const callbacks = [
      "api/oauth/callback/route.ts", // GoHighLevel
      ...FLOWS.map((f) => f.callback),
    ];

    for (const rel of callbacks) {
      const src = read(rel);
      const statuses = [...src.matchAll(/set\("status",\s*"([^"]+)"\)|status:\s*"([^"]+)"/g)]
        .map((m) => m[1] ?? m[2])
        .filter((s) => s !== "error");

      for (const s of statuses) {
        expect(
          s,
          `${rel} sends status="${s}" for a non-error case, but ` +
            `oauth/result only accepts "success". Either send "success" or ` +
            `redirect somewhere that handles the outcome.`,
        ).toBe("success");
      }
    }
  });
});

describe("the GoHighLevel callback", () => {
  const GHL = read("api/oauth/callback/route.ts").replace(/\/\*[\s\S]*?\*\//g, "");

  it("🔴 binds only the sub-account pickInstall names, and moves none another client holds", () => {
    expect(GHL).toContain("pickInstall(clientId, subs)");
    expect(GHL).toMatch(/if \(pick\?\.kind === "elsewhere"\) \{[\s\S]*?return redirectWithError\(/);
    // Nothing else picks: a lone sub-account is named only when no client is being connected.
    expect(GHL).not.toContain("installFor(");
    expect(GHL).toContain('pick?.kind === "client" ? pick.installation : !clientId && subs.length === 1');
  });

  it("🔴 passes no client — not an empty string — for an install from GHL's marketplace", () => {
    expect(GHL).toContain("exchangeCode(code, clientId || null)");
  });
});
