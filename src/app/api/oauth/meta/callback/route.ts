import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { getClientUnscoped } from "@/lib/clients";
import { record, requestContext } from "@/lib/audit";
import { safeFailureMessage } from "@/lib/api-failure";
import { exchangeMetaCode } from "@/lib/meta/oauth";
import { stashMetaConnection } from "@/lib/meta/connect";
import { META_STATE_COOKIE } from "../authorize/route";
import { SETUP_SECTION } from "@/lib/setup-sections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Facebook's redirect target after consent.
 *
 * Staff-guarded, like the Google callback: the only route here starts at our own
 * authorize endpoint, which is staff-only, so leaving it open would widen the
 * surface for nothing.
 *
 * The signed `state` is still verified in full. The signature stops a tampered
 * client id; the cookie stops someone else's completed consent being replayed
 * into this browser. Neither is redundant.
 *
 * No ad account is attached here — the token is stashed and the operator picks.
 * Authorising with an account that can see forty ad accounts must not silently
 * attach forty ad accounts to one client.
 */
export async function GET(req: NextRequest) {
  if (!isAgencyOperator(await getSessionUser())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const error = url.searchParams.get("error");
  if (error) {
    const denied = error === "access_denied";
    return redirectToResult(req, {
      ok: false,
      message: denied
        ? "Facebook sign-in was cancelled. Nothing has been connected."
        : `Facebook returned an error: ${url.searchParams.get("error_description") ?? error}`,
    });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const cookie = req.cookies.get(META_STATE_COOKIE)?.value ?? "";

  if (!code || !state) {
    return redirectToResult(req, {
      ok: false,
      message: "Facebook did not return an authorization code.",
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
  let expiresAt: Date | null;
  try {
    const token = await exchangeMetaCode(code);
    expiresAt = token.expiresAt;
    stashId = await stashMetaConnection(clientId, token.accessToken, token.expiresAt);
  } catch (err) {
    console.error("[meta-oauth] exchange failed:", err);
    /*
     * Redacted with no superadmin exemption, unlike the JSON routes: this
     * message travels as a URL query parameter, and a URL gets pasted into a
     * support thread, kept in browser history and handed to whatever the next
     * page's referrer is. The full error is on the line above, server-side.
     */
    return redirectToResult(req, {
      ok: false,
      message: safeFailureMessage(err, "meta", "Could not complete sign-in."),
    });
  }

  await record({
    action: "meta.oauth_connected",
    targetType: "client",
    targetId: clientId,
    clientId,
    ...requestContext(req),
    // The token itself is never logged. Its lifetime is, because "why did this
    // stop working in October" is a question the audit log should answer.
    metadata: { stashId, tokenExpiresAt: expiresAt?.toISOString() ?? null },
  });

  /*
   * Back to the setup page the flow started from, carrying the stash so the
   * account picker can open immediately.
   *
   * 🔴 NOT to `/oauth/result`, which is where the Google callback sends people
   * — and which reads `status === "success"` while that callback sends
   * `status=ok`, so the Google self-serve flow lands on a failure screen after
   * a successful sign-in. Returning to the page the operator started on is also
   * simply the better ending: the next action is choosing accounts, and that UI
   * is there.
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
  back.searchParams.set("metaStash", stashId);
  // Back at the Meta section, where the picker opens, not the top of the page.
  back.hash = SETUP_SECTION.meta;

  const res = NextResponse.redirect(back);
  res.cookies.delete(META_STATE_COOKIE);
  return res;
}

/** Validate the signed state and its cookie echo, returning the bound client id. */
function verifyState(state: string, cookie: string): string | null {
  if (!cookie || cookie.length !== state.length) return null;
  if (!timingSafeEqual(Buffer.from(state), Buffer.from(cookie))) return null;

  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [clientId, nonce, sig] = parts;

  const secret = process.env.META_APP_SECRET;
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
 * while `/oauth/result` reads `status === "success"` — so a completed sign-in
 * rendered the failure screen. Removing the branch removes the trap: there is
 * no longer a way to route a success through here and reintroduce the mismatch.
 * `status=error` below is correct precisely because the page treats anything
 * that is not `"success"` as a failure.
 */
function redirectToResult(
  req: NextRequest,
  result: { ok: false; message: string },
): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/oauth/result";
  url.search = "";
  url.searchParams.set("provider", "meta");
  url.searchParams.set("status", "error");
  url.searchParams.set("message", result.message);
  return NextResponse.redirect(url);
}
