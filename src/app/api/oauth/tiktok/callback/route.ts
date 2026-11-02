import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { getClientUnscoped } from "@/lib/clients";
import { record, requestContext } from "@/lib/audit";
import { safeFailureMessage } from "@/lib/api-failure";
import { exchangeTiktokCode } from "@/lib/tiktok/oauth";
import { stashTiktokConnection } from "@/lib/tiktok/connect";
import { TIKTOK_STATE_COOKIE } from "../authorize/route";
import { SETUP_SECTION } from "@/lib/setup-sections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * TikTok's redirect target after authorization.
 *
 * Staff-guarded, like the Meta and Google callbacks: the only route here starts
 * at our own authorize endpoint, which is staff-only, so leaving it open would
 * widen the surface for nothing.
 *
 * The signed `state` is still verified in full. The signature stops a tampered
 * client id; the cookie stops someone else's completed authorization being
 * replayed into this browser. Neither is redundant.
 *
 * No advertiser is attached here — the token is stashed and the operator picks.
 * One TikTok grant can cover every advertiser an agency manages, and attaching
 * all of them because someone connected one client would put another tenant's
 * spend on this dashboard.
 */
export async function GET(req: NextRequest) {
  if (!isAgencyOperator(await getSessionUser())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;

  /*
   * 🔴 `auth_code`, NOT `code`.
   *
   * TikTok's callback carries both, and its own documentation contradicts
   * itself about which is which — the prose says one thing and the worked
   * example shows the other. Only `auth_code` is accepted by
   * `/oauth2/access_token/`. Reading `code` yields a plausible-looking string
   * that exchanges for nothing, and the resulting error message does not
   * mention the parameter name, so the mistake is expensive to find.
   *
   * Valid one hour, single use.
   */
  const authCode = url.searchParams.get("auth_code");
  const state = url.searchParams.get("state") ?? "";
  const cookie = req.cookies.get(TIKTOK_STATE_COOKIE)?.value ?? "";

  if (!authCode) {
    /*
     * Covers both a refusal and a mid-flow abandon. TikTok does not document an
     * `error` parameter the way Meta does, so there is nothing more specific to
     * report — and guessing at a reason we cannot know would be worse than
     * saying plainly that nothing was connected.
     */
    return redirectToResult(req, {
      message:
        "TikTok did not return an authorization code. Nothing has been connected.",
    });
  }

  const clientId = verifyState(state, cookie);
  if (!clientId) {
    return redirectToResult(req, {
      message:
        "That authorization could not be verified. Start the connection again from the client's setup page.",
    });
  }

  let stashId: string;
  let advertiserCount: number;
  try {
    const token = await exchangeTiktokCode(authCode);
    advertiserCount = token.advertiserIds.length;
    stashId = await stashTiktokConnection(
      clientId,
      token.accessToken,
      token.advertiserIds,
    );
  } catch (err) {
    console.error("[tiktok-oauth] exchange failed:", err);
    return redirectToResult(req, {
      // Redacted with no superadmin exemption — see the note in the Meta
      // callback: this rides in a URL. The full error is logged above.
      message: safeFailureMessage(
        err,
        "tiktok",
        "Could not complete authorization.",
      ),
    });
  }

  await record({
    action: "tiktok.oauth_connected",
    targetType: "client",
    targetId: clientId,
    clientId,
    ...requestContext(req),
    /*
     * The token itself is never logged. The advertiser count is, because "why
     * did only three of our eleven accounts show up" is a question the audit log
     * should be able to answer without re-running the flow.
     *
     * No `tokenExpiresAt` here, unlike Meta: TikTok tokens do not expire and
     * there is no refresh token. Recording a fabricated expiry would put a date
     * in the log that means nothing.
     */
    metadata: { stashId, advertiserCount },
  });

  // Back to the setup page the flow started from, carrying the stash so the
  // advertiser picker can open immediately. Mirrors Meta and Google.
  /*
   * Unscoped on purpose, and named so. The authorization for this lookup is
   * the HMAC-signed `state` verified above — the client id was minted into
   * it by the authorize route, which DID check the caller's session, so it
   * is not caller input by the time it arrives here.
   */
  const client = await getClientUnscoped(clientId, "oauth_state");
  if (!client) {
    return redirectToResult(req, { message: "That client no longer exists." });
  }

  const back = req.nextUrl.clone();
  back.pathname = `/c/${client.slug}/setup`;
  back.search = "";
  back.searchParams.set("tiktokStash", stashId);
  // Back at the TikTok section, where the picker opens, not the top of the page.
  back.hash = SETUP_SECTION.tiktok;

  const res = NextResponse.redirect(back);
  res.cookies.delete(TIKTOK_STATE_COOKIE);
  return res;
}

/** Validate the signed state and its cookie echo, returning the bound client id. */
function verifyState(state: string, cookie: string): string | null {
  if (!cookie || cookie.length !== state.length) return null;
  if (!timingSafeEqual(Buffer.from(state), Buffer.from(cookie))) return null;

  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [clientId, nonce, sig] = parts;

  const secret = process.env.TIKTOK_APP_SECRET;
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
 * 🔴 Deliberately has no success branch, and never will. Meta and Google both
 * used to have one, and it set `status=ok` while `/oauth/result` reads
 * `status === "success"` — so a completed sign-in rendered the failure screen
 * while the token sat correctly stashed. `status=error` below is correct
 * precisely because the page treats anything that is not `"success"` as a
 * failure.
 */
function redirectToResult(req: NextRequest, result: { message: string }): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/oauth/result";
  url.search = "";
  url.searchParams.set("provider", "tiktok");
  url.searchParams.set("status", "error");
  url.searchParams.set("message", result.message);
  return NextResponse.redirect(url);
}
