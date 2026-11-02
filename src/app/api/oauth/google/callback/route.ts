import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { record, requestContext } from "@/lib/audit";
import { safeFailureMessage } from "@/lib/api-failure";
import { exchangeGoogleCode } from "@/lib/google/oauth";
import { stashGoogleConnection } from "@/lib/google/connect";
import { getClientUnscoped } from "@/lib/clients";
import { GOOGLE_STATE_COOKIE } from "../authorize/route";
import { SETUP_SECTION } from "@/lib/setup-sections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Google's redirect target after consent.
 *
 * Unlike the GHL callback — which must stay open, because a marketplace install
 * can be initiated from GHL's side with no session cookie — this one is
 * **staff-guarded**. There is no path to it that does not begin at our own
 * authorize route, which is itself staff-only, so leaving it open would widen
 * the surface for nothing.
 *
 * The signed `state` is still verified in full: it binds the tokens to the
 * client id the flow started with, and the cookie comparison is the CSRF check.
 * Neither is redundant. The signature stops a tampered client id; the cookie
 * stops someone else's completed consent being replayed into this browser.
 */
export async function GET(req: NextRequest) {
  if (!isAgencyOperator(await getSessionUser())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const error = url.searchParams.get("error");
  if (error) {
    // The user pressed Cancel, or Google refused. Not an app failure — say so
    // plainly rather than showing a stack.
    return redirectToResult(req, {
      ok: false,
      message:
        error === "access_denied"
          ? "Google sign-in was cancelled. Nothing has been connected."
          : `Google returned an error: ${error}`,
    });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const cookie = req.cookies.get(GOOGLE_STATE_COOKIE)?.value ?? "";

  if (!code || !state) {
    return redirectToResult(req, {
      ok: false,
      message: "Google did not return an authorization code.",
    });
  }

  const clientId = verifyState(state, cookie);
  if (!clientId) {
    return redirectToResult(req, {
      ok: false,
      message:
        "That sign-in could not be verified. Start the connection again from the client's setup page.",
    });
  }

  let stashId: string;
  try {
    const { refreshToken } = await exchangeGoogleCode(code);
    /*
     * The tokens are held, encrypted, against the client — but NO ad account is
     * attached yet. Which of the accessible accounts belong to this client is a
     * decision, and one the operator has to make: authorizing with an account
     * that can see forty customers must not silently attach forty customers.
     */
    stashId = await stashGoogleConnection(clientId, refreshToken);
  } catch (err) {
    console.error("[google-oauth] exchange failed:", err);
    return redirectToResult(req, {
      ok: false,
      // Redacted with no superadmin exemption — see the note in the Meta
      // callback: this rides in a URL. The full error is logged above.
      message: safeFailureMessage(err, "google", "Could not complete sign-in."),
    });
  }

  await record({
    action: "google.oauth_connected",
    targetType: "client",
    targetId: clientId,
    clientId,
    ...requestContext(req),
    metadata: { stashId },
  });

  /*
   * 🔴 Back to the setup page, NOT to `/oauth/result`.
   *
   * Two bugs were fixed by this one line. `/oauth/result` reads
   * `status === "success"` while this callback sent `status=ok`, so a
   * successful Google sign-in rendered the failure screen — the token was
   * stashed and the audit row written, and the operator was told it had not
   * worked. And even had the strings matched, that page does nothing with the
   * stash, so the flow dead-ended one step before attaching an account.
   *
   * Returning to the page the operator started from is also simply the right
   * ending: the next action is choosing accounts, and that UI lives there.
   * Mirrors the Meta callback.
   */
  /*
   * Unscoped on purpose, and named so. The authorization for this lookup is
   * the HMAC-signed `state` verified above — the client id was minted into
   * it by the authorize route, which DID check the caller's session, so it
   * is not caller input by the time it arrives here.
   */
  const client = await getClientUnscoped(clientId, "oauth_state");
  if (!client) {
    return redirectToResult(req, {
      ok: false,
      message: "That client no longer exists.",
    });
  }

  const back = req.nextUrl.clone();
  back.pathname = `/c/${client.slug}/setup`;
  back.search = "";
  back.searchParams.set("googleStash", stashId);
  // Back at the Google section, where the picker opens, not the top of the page.
  back.hash = SETUP_SECTION.google;

  const res = NextResponse.redirect(back);
  res.cookies.delete(GOOGLE_STATE_COOKIE);
  return res;
}

/**
 * Validate the signed state and its cookie echo, returning the bound client id.
 *
 * Constant-time on the signature. The cookie is compared whole, which also
 * covers the nonce.
 */
function verifyState(state: string, cookie: string): string | null {
  if (!cookie || cookie.length !== state.length) return null;
  if (!timingSafeEqual(Buffer.from(state), Buffer.from(cookie))) return null;

  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [clientId, nonce, sig] = parts;

  const secret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!secret) return null;
  const expected = createHmac("sha256", secret)
    .update(`${clientId}.${nonce}`)
    .digest("hex")
    .slice(0, 32);

  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return clientId || null;
}

/**
 * The failure ending only. Success returns to the setup page, above.
 *
 * 🔴 Deliberately has no success branch. It used to, and it set `status=ok`
 * while `/oauth/result` reads `status === "success"` — so a completed Google
 * sign-in rendered the failure screen while the token sat correctly stashed.
 * Removing the branch removes the trap.
 */
function redirectToResult(
  req: NextRequest,
  result: { ok: false; message: string },
): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/oauth/result";
  url.search = "";
  url.searchParams.set("provider", "google");
  url.searchParams.set("status", "error");
  url.searchParams.set("message", result.message);
  return NextResponse.redirect(url);
}
