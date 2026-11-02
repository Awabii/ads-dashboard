import Link from "next/link";
import type { ReactNode } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pipelineStages } from "@/db/schema";
import { getClientForSession } from "@/lib/clients";
import { getSessionUser } from "@/lib/auth";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AppShell } from "@/components/AppShell";
import { setupHref } from "@/lib/setup-sections";

export const dynamic = "force-dynamic";

/**
 * Post-OAuth landing page.
 *
 * The install callback redirects here so the operator always sees a clear
 * success/failure state with next steps — never a bare redirect or a blank
 * screen, which is exactly how a failed install used to present.
 */
export default async function OAuthResultPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    slug?: string;
    location?: string;
    message?: string;
    provider?: string;
  }>;
}) {
  const sp = await searchParams;
  const ok = sp.status === "success";
  const slug = sp.slug || null;
  /*
   * 🔴 GoHighLevel is the DEFAULT, not one option among four.
   *
   * Its callback sets no `provider` at all — this page was written when it was
   * the only flow that landed here. The ad-platform callbacks each set one, and
   * they must, because the "What to try" list below is platform-specific advice
   * and the previous version showed GoHighLevel's to everyone. A failed
   * Facebook connect told the operator to check they were signed into their GHL
   * agency account, which is not merely unhelpful — it sends them to fix
   * something that was never broken.
   */
  const provider = providerOf(sp.provider);
  const location = sp.location || null;
  const message =
    sp.message || "The connection didn’t complete. No changes were saved.";

  let clientName: string | null = null;
  let stageCount = 0;
  let unmapped = 0;
  if (ok && slug) {
    /*
     * 🔴 This page had NO permission check of any kind.
     *
     * `?slug=` is raw caller input and it went straight into a client lookup,
     * then rendered that client's name and its pipeline stage count. Nothing
     * required a session at all — the page sits outside the `/api` tree the
     * proxy guards, so anyone who could guess a slug (they are derived from
     * business names) could confirm a client existed and learn how far its
     * onboarding had got. It was reachable by URL alone.
     *
     * Scoped now, and `null` covers both "no such client" and "not yours": the
     * page falls back to its generic copy rather than announcing which of the
     * two it was.
     */
    const client = await getClientForSession(await getSessionUser(), slug);
    if (client) {
      clientName = client.name;
      const stages = await db
        .select({ canonical: pipelineStages.canonicalStage })
        .from(pipelineStages)
        .where(eq(pipelineStages.clientId, client.id));
      stageCount = stages.length;
      unmapped = stages.filter((s) => !s.canonical).length;
    }
  }

  const accent = ok ? "var(--status-good)" : "var(--status-critical)";
  /*
   * Installed in GHL but bound to no client here: started from GHL's own
   * marketplace (no client to bind to), or several sub-accounts ticked at
   * once. Saying "This client is now wired" would be false — the install
   * waits until it is connected from a client's page.
   */
  const unlinked = ok && clientName === null;

  return (
    <AppShell>
      {/* See the glass block in globals.css. `.glass-bar` owns the bottom
          hairline, so there is no `border-b` here. */}
      <header className="glass-bar sticky top-0 z-20">
        <div className="mx-auto flex w-full max-w-[900px] items-center justify-end px-4 py-3.5 sm:px-6">
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[520px] flex-1 flex-col items-center px-4 pt-16 pb-16 sm:pt-24">
        <div
          className="flex h-16 w-16 items-center justify-center rounded-full"
          style={{
            background: `color-mix(in srgb, ${accent} 14%, transparent)`,
            border: `1px solid color-mix(in srgb, ${accent} 45%, transparent)`,
          }}
        >
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
          >
            {ok ? (
              <path
                d="M5 12.5l4.2 4.2L19 7"
                stroke={accent}
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : (
              <>
                <path
                  d="M12 7v6"
                  stroke={accent}
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
                <circle cx="12" cy="17" r="1.4" fill={accent} />
              </>
            )}
          </svg>
        </div>

        <h1
          className="mt-6 text-center text-[24px] leading-tight font-semibold tracking-[-0.02em]"
          style={{ color: "var(--text-primary)" }}
        >
          {unlinked ? "Installed in GoHighLevel" : ok ? "GoHighLevel connected" : "Connection didn’t finish"}
        </h1>

        {ok ? (
          <div className="mt-2 text-center">
            <p style={{ color: "var(--text-secondary)" }}>
              {unlinked
                ? "The app is installed. One step left: link it to its client here."
                : `${clientName} is now wired to GoHighLevel. New leads and stage changes will stream in from here.`}
            </p>
            {location && (
              <p
                className="mt-1 text-sm"
                style={{ color: "var(--text-muted)" }}
              >
                Sub-account: <strong>{location}</strong>
              </p>
            )}
          </div>
        ) : (
          <p
            className="mt-2 max-w-[420px] text-center"
            style={{ color: "var(--text-secondary)" }}
          >
            {message}
          </p>
        )}

        {/* Detail card */}
        <div
          className="card mt-8 w-full p-5 sm:p-6"
          style={{ borderColor: "var(--border)" }}
        >
          {unlinked ? (
            <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
              <p className="mb-2 font-medium" style={{ color: "var(--text-primary)" }}>
                To link it
              </p>
              <ol className="flex list-decimal flex-col gap-1.5 pl-4">
                <li>Open the client’s <strong>Connections</strong> page here.</li>
                <li>
                  Click <strong>Connect GoHighLevel</strong>.
                </li>
                <li>Tick the same sub-account, alone, and continue.</li>
              </ol>
            </div>
          ) : ok ? (
            <ul className="flex flex-col gap-3 text-sm">
              <Row label="Pipeline stages imported" value={`${stageCount}`} />
              {unmapped > 0 && (
                <Row
                  label="Stages still needing a mapping"
                  value={`${unmapped}`}
                  warn
                />
              )}
              <Row label="Live webhook" value="Receiving events" good />
            </ul>
          ) : (
            <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
              <p
                className="mb-2 font-medium"
                style={{ color: "var(--text-primary)" }}
              >
                What to try
              </p>
              <ul className="flex list-disc flex-col gap-1.5 pl-4">
                {ADVICE[provider].map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="mt-6 flex w-full flex-col gap-2 sm:flex-row">
          {ok && slug ? (
            <>
              <Link
                href={setupHref(slug, unmapped > 0 ? "stages" : provider)}
                className="btn-accent flex-1"
              >
                {unmapped > 0 ? "Map stages & finish setup" : "Finish setup"}
              </Link>
              <Link
                href={`/c/${slug}`}
                className="flex-1 rounded-[var(--radius)] border px-4 py-2.5 text-center text-[13px] font-medium"
                style={{
                  borderColor: "var(--border-strong)",
                  color: "var(--text-secondary)",
                }}
              >
                Go to dashboard
              </Link>
            </>
          ) : ok ? (
            <Link
              href="/"
              className="btn-accent flex-1"
            >
              Back to clients
            </Link>
          ) : (
            <>
              <Link
                href={slug ? setupHref(slug, provider) : "/"}
                className="btn-accent flex-1"
              >
                Back to setup
              </Link>
              <Link
                href="/"
                className="flex-1 rounded-[var(--radius)] border px-4 py-2.5 text-center text-[13px] font-medium"
                style={{
                  borderColor: "var(--border-strong)",
                  color: "var(--text-secondary)",
                }}
              >
                All clients
              </Link>
            </>
          )}
        </div>
      </main>
    </AppShell>
  );
}

type Provider = "ghl" | "meta" | "google" | "tiktok";

/** Absent or unrecognised → GoHighLevel, which is the flow that sets nothing. */
function providerOf(raw: string | undefined): Provider {
  return raw === "meta" || raw === "google" || raw === "tiktok" ? raw : "ghl";
}

/**
 * Platform-specific recovery steps.
 *
 * Each list names the failure that actually happens on that platform, in the
 * order it is likely. Generic advice ("check your connection and try again") is
 * deliberately absent — it is what this page showed for everything before, and
 * it is indistinguishable from having nothing to say.
 */
const ADVICE: Record<Provider, ReactNode[]> = {
  ghl: [
    <>
      Make sure you’re logged into your GoHighLevel agency account in this
      browser, then start the install again.
    </>,
    <>
      Start it from the client’s <strong>Connections</strong> page here —{" "}
      <strong>Connect GoHighLevel</strong> — so the install is linked to that
      client.
    </>,
    <>
      If the app is still in draft, add the sub-account as a test location in
      the GHL app settings, then retry.
    </>,
  ],
  meta: [
    <>
      Sign into Facebook with an account that has access to the ad account, then
      start again.
    </>,
    <>
      The account needs a role on the <strong>ad account</strong> in Business
      Manager. Being an admin of the Page is not enough.
    </>,
    <>
      Until Meta App Review completes, only people with a role on our Meta app
      can finish this — everyone else is refused at the consent screen.
    </>,
  ],
  google: [
    <>
      Sign in with a Google account that can open the Google Ads account itself,
      then start again.
    </>,
    <>
      Access to the Analytics property or the Business Profile is not the same
      grant — it has to be Google Ads.
    </>,
    <>
      If the account sits under a manager (MCC), you still sign in as yourself;
      the manager’s child accounts appear in the next step.
    </>,
  ],
  tiktok: [
    <>
      TikTok emails a verification code partway through authorization. Check
      that inbox and finish within 48 hours, then start again.
    </>,
    <>
      Authorize with a TikTok account that has access to the advertiser in
      Business Center.
    </>,
    <>
      If this keeps failing immediately, the app’s registered{" "}
      <strong>Advertiser redirect URL</strong> no longer matches this
      installation’s address — that is a setting on the TikTok app, not
      something a retry can fix.
    </>,
  ],
};

function Row({
  label,
  value,
  good,
  warn,
}: {
  label: string;
  value: string;
  good?: boolean;
  warn?: boolean;
}) {
  const color = good
    ? "var(--status-good)"
    : warn
      ? "var(--status-warning)"
      : "var(--text-primary)";
  return (
    <li className="flex items-center justify-between">
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className="font-semibold tabular-nums" style={{ color }}>
        {value}
      </span>
    </li>
  );
}
