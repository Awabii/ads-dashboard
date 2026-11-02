"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { SETUP_SECTION } from "@/lib/setup-sections";
import {
  CONFIRM_ATTACH_ABOVE,
  MAX_ATTACH_PER_SIGN_IN,
  accountsByManager,
  coverage,
  deselectAll,
  selectAll,
} from "@/lib/connect-picker";
import {
  CANONICAL_STAGES,
  REQUIRED_CANONICAL_STAGES,
  STAGE_LABELS,
  suggestCanonicalStage,
  type CanonicalStage,
} from "@/lib/stages";

/**
 * Connection wizard.
 *
 * Every step VERIFIES against the live API before it will advance, and echoes
 * back what the API returned — the GHL business name, the Meta account name and
 * currency. A mistyped ad account id or a token generated against the wrong
 * sub-account is then caught in the moment, instead of surfacing weeks later as
 * an inexplicably empty dashboard.
 *
 * The final step is the important one: it does not declare success when the
 * webhook URL has been *displayed*, it polls until a real event arrives.
 * Configured and working are different things.
 */

/**
 * A failed response, rendered as one line.
 *
 * Since `api-failure.ts` these routes return `{ error, hint }` rather than a
 * raw upstream string, and the hint carries the half that changes what somebody
 * does next — "nothing needs reconnecting, this clears on its own" versus
 * "re-authorise the account". Reading only `error` would swap a specific
 * upstream error for a vaguer one of ours and drop the compensation, which is a
 * strictly worse wizard.
 */
function failureText(
  body: { error?: string; hint?: string } | null | undefined,
  fallback: string,
): string {
  const head = body?.error ?? fallback;
  if (!body?.hint) return head;
  // Our redacted messages are written without a full stop; a passed-through
  // message of ours may have one. Joining blindly gives "valid.. Reconnect".
  return `${head.replace(/\.$/, "")}. ${body.hint}`;
}

/* ------------------------------------------------------------------ */
/*  Shared by the Facebook, Google and TikTok account pickers           */
/* ------------------------------------------------------------------ */

/** What a successful attach reports back to the step that hosts the picker. */
interface AttachSummary {
  attached: number;
  /** Per-account failures and warnings, already worded for the operator. */
  notes: string[];
}

/**
 * A response that could not be read is NOT a failure we can report as one.
 *
 * Attaching verifies every account with the platform inside one request, so a
 * long one can be cut off after some accounts were stored. Saying "failed" here
 * invites a second click on a sign-in the first one may already have used.
 */
const NO_CLEAR_ANSWER =
  "No clear answer from the server, so some accounts may already be attached. " +
  "Reload the page and check the list above before trying again.";

/** True when the operator confirms, or when the attach is small enough not to ask. */
function confirmLargeAttach(count: number, noun: string): boolean {
  if (count <= CONFIRM_ATTACH_ABOVE) return true;
  return confirm(
    `Attach ${count} ${noun} to this client?\n\n` +
      "Their spend is added together on this client's dashboard. " +
      `Continue only if all ${count} really are this client's.`,
  );
}

/**
 * "Select all", scoped to what is SHOWN — so it works with the filter: type a
 * name, then select every match. Offered only up to what one sign-in can
 * attach, because a selection the attach route will refuse is a dead end.
 */
function SelectionBar({
  shownIds,
  picked,
  onChange,
  busy,
  filtered,
  noun,
}: {
  /** Selectable ids in the current (possibly filtered) view. */
  shownIds: readonly string[];
  picked: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  busy: boolean;
  filtered: boolean;
  noun: string;
}) {
  const n = shownIds.length;
  if (n < 2 && picked.size === 0) return null;
  const all = coverage(picked, shownIds) === "all";
  const scope = filtered ? " shown" : "";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {n >= 2 &&
        (n > MAX_ATTACH_PER_SIGN_IN ? (
          <span style={{ color: "var(--text-muted)" }}>
            {n} {filtered ? "match" : noun}. Filter to {MAX_ATTACH_PER_SIGN_IN} or
            fewer to select them all at once.
          </span>
        ) : (
          <button
            type="button"
            disabled={busy || all}
            onClick={() => onChange(selectAll(picked, shownIds))}
            className="font-medium hover:underline disabled:opacity-60 disabled:hover:no-underline"
            style={{ color: "var(--text-secondary)" }}
          >
            {all ? `All ${n}${scope} selected` : `Select all ${n}${scope}`}
          </button>
        ))}
      {picked.size > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onChange(new Set())}
          className="hover:underline disabled:opacity-60"
          style={{ color: "var(--text-muted)" }}
        >
          Clear selection ({picked.size})
        </button>
      )}
    </div>
  );
}

/** Said beside the Attach button, which stays disabled while this shows. */
function AttachCapNote({ count, noun }: { count: number; noun: string }) {
  if (count <= MAX_ATTACH_PER_SIGN_IN) return null;
  return (
    <p className="mt-2 text-[12px]" style={{ color: "var(--status-warning)" }}>
      {count} selected. Up to {MAX_ATTACH_PER_SIGN_IN} {noun} can be attached per
      sign-in, so untick some; sign in again afterwards to add the rest.
    </p>
  );
}

/**
 * Shown in the picker's place once an attach succeeded.
 *
 * 🔴 The picker must not stay on screen afterwards. The sign-in it holds is
 * used up by a successful attach, so a picker left showing its ticked boxes
 * invited a second click, which then reported the sign-in as "expired" — on an
 * attach that had in fact worked.
 */
function AttachedNotice({
  summary,
  one,
  many,
}: {
  summary: AttachSummary;
  one: string;
  many: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The picker it replaces can be hundreds of rows tall: bring the result into
  // view and give it focus, so neither eyes nor a screen reader lose the place.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={ref} role="status" tabIndex={-1} className="mb-4 outline-none">
      <Result ok>
        Attached {summary.attached} {summary.attached === 1 ? one : many}. On
        this client&rsquo;s first connection to the platform, the last 90 days
        import within a few minutes; otherwise their figures fill in with the
        next nightly update.
      </Result>
      {summary.notes.map((n) => (
        <p
          key={n}
          className="mt-1.5 text-[12px]"
          style={{ color: "var(--status-warning)" }}
        >
          ⚠ {n}
        </p>
      ))}
    </div>
  );
}

interface StageRow {
  id: string;
  name: string | null;
  pipelineName: string | null;
  canonicalStage: CanonicalStage | null;
  discoveredFromWebhook: boolean;
}

interface Props {
  clientId: string;
  slug: string;
  webhookUrl: string;
  /** True when GHL_CLIENT_ID/SECRET are set, enabling the one-click install. */
  oauthAvailable: boolean;
  installation: {
    locationName: string | null;
    locationId: string;
    installedAt: string;
    uninstalledAt: string | null;
  } | null;
  initial: {
    ghlLocationId: string;
    ghlLocationName: string | null;
    ghlAuthMethod: "pit" | "oauth";
    hasGhlToken: boolean;
    clientTimezone: string;
    firstWebhookAt: string | null;
  };
  metaAccounts: MetaAccountRow[];
  /** META_APP_ID + META_APP_SECRET are set, so "Continue with Facebook" works. */
  metaConnectConfigured: boolean;
  /** Set when the browser has just come back from Facebook's consent screen. */
  metaStash: string | null;
  googleAccounts: GoogleAccountRow[];
  /** True when the agency Google Ads env vars are all set. */
  googleConfigured: boolean;
  /** Set when the browser has just come back from Google's consent screen. */
  googleStash: string | null;
  tiktokAccounts: TiktokAccountRow[];
  /** TIKTOK_APP_ID + TIKTOK_APP_SECRET are set, so "Continue with TikTok" works. */
  tiktokConfigured: boolean;
  /** Set when the browser has just come back from TikTok's authorization screen. */
  tiktokStash: string | null;
  stages: StageRow[];
}

export interface MetaAccountRow {
  id: string;
  adAccountId: string;
  accountName: string | null;
  currency: string | null;
  timezone: string | null;
  isPrimary: boolean;
  status: "active" | "paused" | "removed";
}

export interface GoogleAccountRow {
  id: string;
  customerId: string;
  accountName: string | null;
  currency: string | null;
  timezone: string | null;
  isPrimary: boolean;
  status: "active" | "paused" | "removed";
}

/**
 * No `isPrimary`, unlike its two siblings — `tiktok_ad_accounts` has no such
 * column. Meta's primary account defines the client's display currency and
 * bucketing timezone; TikTok deliberately never overwrites those, so there is
 * nothing for a primary to mean here.
 */
export interface TiktokAccountRow {
  id: string;
  advertiserId: string;
  advertiserName: string | null;
  currency: string | null;
  timezone: string | null;
  status: "active" | "paused" | "removed";
}

export function SetupWizard({
  clientId,
  slug,
  webhookUrl,
  oauthAvailable,
  installation,
  initial,
  metaAccounts,
  metaConnectConfigured,
  metaStash,
  googleAccounts,
  googleConfigured,
  googleStash,
  tiktokAccounts,
  tiktokConfigured,
  tiktokStash,
  stages: initialStages,
}: Props) {
  const router = useRouter();
  const usingOauth = initial.ghlAuthMethod === "oauth" || oauthAvailable;

  /*
   * A sign-in comes back as a fresh page load addressed to its platform's
   * section (`#meta`, `#google-ads`, `#tiktok`). The browser jumps there while
   * the page loads; this lands it there again once the page is interactive, in
   * case anything above it changed height in between.
   */
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, []);

  /*
   * After a successful attach, take the used-up sign-in out of the address.
   * Left there, the page re-rendered the picker on every refresh and a reload
   * met a stash the server had already dropped.
   */
  const clearStash = (key: "metaStash" | "googleStash" | "tiktokStash") => {
    const url = new URL(window.location.href);
    // A late callback after the operator moved on must not touch that page.
    if (!url.searchParams.has(key)) return;
    url.searchParams.delete(key);
    // Synchronous, so Back or a quick reload can never land on the used
    // sign-in; Next's router follows native history updates. The refresh then
    // re-renders with fresh data and keeps this component's state.
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-5">
      {usingOauth ? (
        <InstallStep
          clientId={clientId}
          installation={installation}
          oauthAvailable={oauthAvailable}
          connectedLocationName={initial.ghlLocationName}
          webhookAlive={Boolean(initial.firstWebhookAt)}
        />
      ) : (
        <GhlStep
          clientId={clientId}
          initial={initial}
          onDone={() => router.refresh()}
        />
      )}
      <StageStep
        clientId={clientId}
        stages={initialStages}
        onDone={() => router.refresh()}
      />
      <MetaAccountsStep
        clientId={clientId}
        accounts={metaAccounts}
        connectConfigured={metaConnectConfigured}
        stash={metaStash}
        onDone={() => router.refresh()}
        onConnected={() => clearStash("metaStash")}
      />
      <GoogleAccountsStep
        clientId={clientId}
        accounts={googleAccounts}
        configured={googleConfigured}
        stash={googleStash}
        onDone={() => router.refresh()}
        onConnected={() => clearStash("googleStash")}
      />
      <TiktokAccountsStep
        clientId={clientId}
        accounts={tiktokAccounts}
        connectConfigured={tiktokConfigured}
        stash={tiktokStash}
        onDone={() => router.refresh()}
        onConnected={() => clearStash("tiktokStash")}
      />
      {!usingOauth && (
        <WebhookStep
          clientId={clientId}
          webhookUrl={webhookUrl}
          firstWebhookAt={initial.firstWebhookAt}
        />
      )}
      {/* On the OAuth path WebhookStep (step 6) isn't rendered, so backfill takes
          its number — otherwise the wizard reads 1,2,3,4,5,7 with a missing "6". */}
      <BackfillStep
        clientId={clientId}
        slug={slug}
        step={usingOauth ? 6 : 7}
        hasTiktok={tiktokAccounts.some((a) => a.status !== "removed")}
        hasGoogle={googleAccounts.some((a) => a.status !== "removed")}
      />
    </div>
  );
}

/**
 * One-click install via the marketplace app.
 *
 * This replaces both the token-entry step AND the webhook-installation step:
 * app-level webhooks are configured once in the app's own settings, so an
 * installed sub-account starts streaming `OpportunityStageUpdate` events with
 * no per-client workflow building at all. That is the entire reason for
 * preferring OAuth over a Private Integration Token, which has no webhook
 * capability.
 */
function InstallStep({
  clientId,
  installation,
  oauthAvailable,
  connectedLocationName,
  webhookAlive,
}: {
  clientId: string;
  installation: Props["installation"];
  oauthAvailable: boolean;
  connectedLocationName: string | null;
  webhookAlive: boolean;
}) {
  const active = installation && !installation.uninstalledAt;
  // Connected the original way — bound to a location and already streaming
  // events — but with no captured OAuth install row. Events are flowing, so the
  // step is genuinely done; the marketplace install is then only an optional
  // upgrade, not a "you are not connected" prompt.
  const connectedViaWebhook =
    !active && webhookAlive && Boolean(connectedLocationName);

  return (
    <Card
      step={1}
      anchor={SETUP_SECTION.ghl}
      title="Connect GoHighLevel"
      description="Installs the marketplace app on the client's sub-account. No workflow building required — stage changes stream automatically."
      done={Boolean(active) || connectedViaWebhook}
    >
      {!oauthAvailable ? (
        <p className="text-xs" style={{ color: "var(--status-warning)" }}>
          OAuth is not configured on this deployment. Set{" "}
          <code>GHL_CLIENT_ID</code> and <code>GHL_CLIENT_SECRET</code>, or use
          a Private Integration Token instead.
        </p>
      ) : active ? (
        <>
          <Result ok>
            Installed on{" "}
            {installation!.locationName ?? installation!.locationId}
          </Result>
          <a
            href={`/api/oauth/authorize?clientId=${clientId}`}
            className="mt-3 inline-block rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium"
            style={{
              borderColor: "var(--border-strong)",
              color: "var(--text-secondary)",
            }}
          >
            Reconnect
          </a>
        </>
      ) : connectedViaWebhook ? (
        <>
          <Result ok>
            Connected to {connectedLocationName} — receiving events
          </Result>
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
            Events are already streaming from this sub-account. Re-installing
            through the marketplace app is optional — it captures an OAuth token
            for one-click reconnects.
          </p>
          <a
            href={`/api/oauth/authorize?clientId=${clientId}`}
            className="mt-3 inline-block rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium"
            style={{
              borderColor: "var(--border-strong)",
              color: "var(--text-secondary)",
            }}
          >
            Install via marketplace app
          </a>
        </>
      ) : (
        <>
          {installation?.uninstalledAt && (
            <p
              className="mb-3 text-xs"
              style={{ color: "var(--status-critical)" }}
            >
              The app was uninstalled on{" "}
              {new Date(installation.uninstalledAt).toLocaleDateString(
                "en-US",
                {
                  timeZone: "UTC",
                },
              )}
              . Stage changes are not being recorded.
            </p>
          )}
          <a
            href={`/api/oauth/authorize?clientId=${clientId}`}
            className="btn-accent"
          >
            Install on a sub-account
          </a>
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
            You&rsquo;ll be sent to GoHighLevel to pick the sub-account, then
            returned here. Pipeline stages import automatically.
          </p>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

interface DiscoveredMetaAccount {
  adAccountId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  active: boolean;
}

/**
 * Pick which of the authorising Facebook user's ad accounts belong to a client.
 *
 * 🔴 Selection is a separate step from consent, and it is not a formality: a
 * media buyer's login can reach every account the agency runs, so attaching
 * everything the token can see would put another client's spend on this
 * dashboard. Nothing is pre-ticked for the same reason.
 *
 * Inactive accounts are shown and disabled rather than hidden — an operator
 * hunting for an account they know exists needs to see it greyed out with a
 * reason, or they conclude the sign-in failed and go round again.
 */
/**
 * A stash that cannot be read, and the way out of it.
 *
 * 🔴 Without the link, this screen is a dead end. The step renders the connect
 * button only while there is NO stash in the URL — reasonably, since a stash
 * means "you are mid-flow, here is the picker". But when the stash cannot be
 * read, the picker has nothing to show, so the operator gets a red sentence,
 * no button, and no indication that reloading the page without the query
 * parameter is what unsticks it. Every one of the three platforms had its own
 * copy of that dead end.
 *
 * The message itself comes from the server, which knows whether this was an
 * expiry or a stash minted for a different client — two situations that need
 * different actions and must not be flattened into one string here.
 */
function StashDeadEnd({
  error,
  authorizeHref,
  label,
}: {
  error: string;
  authorizeHref: string;
  label: string;
}) {
  return (
    <div className="mb-4 flex flex-col items-start gap-2.5">
      <p className="text-[12.5px]" style={{ color: "var(--status-critical)" }}>
        {error}
      </p>
      <a
        href={authorizeHref}
        className="inline-flex items-center rounded-[var(--radius-sm)] border px-3.5 py-2 text-[13px] font-semibold transition-opacity hover:opacity-90"
        style={{
          background: "var(--surface-2)",
          color: "var(--text-primary)",
          borderColor: "var(--border)",
        }}
      >
        {label}
      </a>
    </div>
  );
}

function MetaAccountPicker({
  clientId,
  stash,
  onDone,
  onAttached,
}: {
  clientId: string;
  stash: string;
  onDone: () => void;
  onAttached: (summary: AttachSummary) => void;
}) {
  const [accounts, setAccounts] = useState<DiscoveredMetaAccount[] | null>(
    null,
  );
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/clients/${clientId}/meta-connect?stash=${encodeURIComponent(stash)}`,
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(failureText(body, "Could not read that Facebook sign-in."));
          return;
        }
        setAccounts(body.accounts ?? []);
        setExpiresAt(body.tokenExpiresAt ?? null);
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, stash]);

  async function attach() {
    if (!confirmLargeAttach(picked.size, "ad accounts")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/meta-connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stash, adAccountIds: [...picked] }),
      });
      const body = await res.json().catch(() => null);
      if (!body) {
        setError(NO_CLEAR_ANSWER);
        onDone();
        return;
      }
      if (!res.ok) {
        setError(failureText(body, "Could not attach those accounts."));
        return;
      }
      const failures: string[] = (body.failed ?? []).map(
        (f: { adAccountId: string; error: string }) =>
          `act_${f.adAccountId}: ${f.error}`,
      );
      const attached = Array.isArray(body.attached) ? body.attached.length : 0;
      if (attached > 0) {
        onAttached({ attached, notes: failures });
        return;
      }
      setError(failures.join(" · ") || "Nothing was attached.");
      onDone();
    } catch {
      // The request may have reached the server and attached before the
      // connection dropped, so this is an unknown outcome, not a failure.
      setError(NO_CLEAR_ANSWER);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  if (error && !accounts) {
    return (
      <StashDeadEnd
        error={error}
        authorizeHref={`/api/oauth/meta/authorize?clientId=${encodeURIComponent(clientId)}`}
        label="Sign in with Facebook again"
      />
    );
  }
  if (!accounts) {
    return (
      <p className="mb-4 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
        Reading the ad accounts on that Facebook login…
      </p>
    );
  }
  if (accounts.length === 0) {
    return (
      <p className="mb-4 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
        That Facebook account cannot reach any ad accounts. Sign in with the
        account that manages these ads, or add the ad account ID below.
      </p>
    );
  }

  const metaQuery = filter.trim().toLowerCase();
  // Inactive accounts cannot be ticked, so "select all" leaves them out too.
  const metaShownIds = accounts
    .filter(
      (a) =>
        a.active &&
        (!metaQuery ||
          [a.name, a.adAccountId]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(metaQuery))),
    )
    .map((a) => a.adAccountId);

  return (
    <div
      className="mb-4 rounded-[var(--radius)] border p-3"
      style={{
        borderColor: "var(--border-strong)",
        background: "var(--surface-2)",
      }}
    >
      <p
        className="text-[13px] font-medium"
        style={{ color: "var(--text-primary)" }}
      >
        Which of these belong to this client?
      </p>
      <p
        className="mt-0.5 text-[11.5px]"
        style={{ color: "var(--text-muted)" }}
      >
        {accounts.length} ad account{accounts.length === 1 ? "" : "s"} on this
        Facebook login.
      </p>

      {/*
        A search box only once the list stops being scannable. An agency login
        with partner access to thirty client accounts cannot be picked from by
        eye, and ticking the wrong row here puts another client's spend on this
        dashboard.

        Grouping by Business Manager would be the better answer, but that field
        needs `business_management` — see `meta/client.ts:listAdAccounts`.
      */}
      {accounts.length > 8 && (
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by account name or ID…"
          className="mt-2 w-full rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[13px]"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--surface-1)",
            color: "var(--text-primary)",
          }}
        />
      )}

      <SelectionBar
        shownIds={metaShownIds}
        picked={picked}
        onChange={setPicked}
        busy={busy}
        filtered={metaQuery !== ""}
        noun="ad accounts"
      />

      {(() => {
        const q = filter.trim().toLowerCase();
        const shown = q
          ? accounts.filter((a) =>
              [a.name, a.adAccountId]
                .filter(Boolean)
                .some((v) => String(v).toLowerCase().includes(q)),
            )
          : accounts;

        if (shown.length === 0) {
          return (
            <p
              className="mt-2 text-[12.5px]"
              style={{ color: "var(--text-muted)" }}
            >
              No ad account on this login matches “{filter.trim()}”.
            </p>
          );
        }

        return (
          <ul className="mt-1 flex flex-col">
            {shown.map((a) => (
              <li
                key={a.adAccountId}
                className="flex items-start gap-2.5 py-1.5"
              >
                <input
                  id={`fb-${a.adAccountId}`}
                  type="checkbox"
                  className="mt-1"
                  disabled={!a.active || busy}
                  checked={picked.has(a.adAccountId)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(a.adAccountId);
                    else next.delete(a.adAccountId);
                    setPicked(next);
                  }}
                />
                <label
                  htmlFor={`fb-${a.adAccountId}`}
                  className="min-w-0 flex-1 cursor-pointer"
                  style={{ opacity: a.active ? 1 : 0.55 }}
                >
                  <span
                    className="block text-[13px] font-medium"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {a.name ?? `act_${a.adAccountId}`}
                    {!a.active && (
                      <span
                        className="ml-1.5 text-[11px] font-normal"
                        style={{ color: "var(--text-muted)" }}
                      >
                        · not active on Facebook
                      </span>
                    )}
                  </span>
                  <span
                    className="block text-[11px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    act_{a.adAccountId} · {a.currency ?? "?"} ·{" "}
                    {a.timezone ?? "?"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        );
      })()}

      {/*
        Counted across the whole list, not the filtered view — a selection made
        before typing a filter is still going to be attached, and hiding it
        behind a search term is how the wrong account gets connected.
      */}
      {picked.size > 0 && filter.trim() !== "" && (
        <p
          className="mt-2 text-[11.5px]"
          style={{ color: "var(--text-muted)" }}
        >
          {picked.size} selected in total, including accounts hidden by the
          filter.
        </p>
      )}

      {/*
        🔴 Stated at the moment of connecting, not left to be discovered.
        A Facebook user token lasts ~60 days; the system user token behind the
        manual path does not expire at all. Someone choosing between the two
        deserves to know which one lapses.
      */}
      {expiresAt && (
        <p
          className="mt-2 text-[11.5px]"
          style={{ color: "var(--text-muted)" }}
        >
          This Facebook sign-in expires on{" "}
          {new Date(expiresAt).toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
          . You will be warned two weeks before it does.
        </p>
      )}

      {error && (
        <p
          className="mt-2 text-[12px]"
          style={{ color: "var(--status-critical)" }}
        >
          {error}
        </p>
      )}

      <AttachCapNote count={picked.size} noun="ad accounts" />

      <button
        onClick={attach}
        disabled={busy || picked.size === 0 || picked.size > MAX_ATTACH_PER_SIGN_IN}
        className="accent-fill mt-3 rounded-[var(--radius-sm)] px-3 py-2 text-[13px] font-medium disabled:opacity-60"
      >
        {busy
          ? "Attaching…"
          : picked.size
            ? `Attach ${picked.size} ${picked.size === 1 ? "account" : "accounts"}`
            : "Attach accounts"}
      </button>
    </div>
  );
}

function Card({
  step,
  title,
  description,
  done,
  anchor,
  children,
}: {
  step: number;
  title: string;
  description?: string;
  done?: boolean;
  /** The section's id, so a sign-in can come back to it (`SETUP_SECTION`). */
  anchor?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={anchor} className="card scroll-mt-6 p-5">
      <div className="mb-3 flex items-start gap-3">
        <span
          className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
          style={{
            background: done ? "var(--status-good)" : "var(--surface-2)",
            color: done ? "var(--status-ink)" : "var(--text-secondary)",
          }}
          aria-hidden="true"
        >
          {done ? "✓" : step}
        </span>
        <div className="min-w-0 flex-1">
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--section-ink, var(--text-primary))" }}
          >
            {title}
          </h2>
          {description && (
            <p
              className="mt-0.5 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              {description}
            </p>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

const inputStyle = {
  borderColor: "var(--border-strong)",
  background: "var(--surface-1)",
  color: "var(--text-primary)",
} as const;

function Field({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span
        className="text-[11px] font-medium tracking-wider uppercase"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </span>
      <input
        {...props}
        className="mt-1 w-full rounded-[var(--radius-sm)] border px-3 py-2 text-[13px]"
        style={inputStyle}
      />
    </label>
  );
}

function Result({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <p
      className="mt-3 flex items-start gap-2 text-xs"
      style={{ color: ok ? "var(--delta-good)" : "var(--status-critical)" }}
    >
      <span aria-hidden="true">{ok ? "✓" : "✕"}</span>
      <span>{children}</span>
    </p>
  );
}

/* ------------------------------------------------------------------ */

function GhlStep({
  clientId,
  initial,
  onDone,
}: {
  clientId: string;
  initial: Props["initial"];
  onDone: () => void;
}) {
  const [locationId, setLocationId] = useState(initial.ghlLocationId);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(
    initial.ghlLocationName
      ? { ok: true, msg: `Connected to ${initial.ghlLocationName}` }
      : null,
  );

  async function verify() {
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "ghl",
          locationId,
          token: token || undefined,
        }),
      });
      const body = await res.json();
      setResult(
        res.ok
          ? { ok: true, msg: `Connected to ${body.locationName ?? locationId}` }
          : { ok: false, msg: failureText(body, "Verification failed") },
      );
      if (res.ok) {
        setToken("");
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      step={1}
      anchor={SETUP_SECTION.ghl}
      title="Connect GoHighLevel"
      description="A Private Integration Token for this sub-account, plus its location ID."
      done={Boolean(initial.ghlLocationName)}
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Location ID"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          placeholder="ve9EPM428h8vShlRW1KT"
        />
        <Field
          label={
            initial.hasGhlToken
              ? "Private Integration Token (leave blank to keep existing)"
              : "Private Integration Token"
          }
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="pit-..."
        />
        <button
          onClick={verify}
          disabled={busy || !locationId}
          className="self-start btn-accent disabled:opacity-50"
        >
          {busy ? "Verifying…" : "Verify & save"}
        </button>
      </div>
      {result && <Result ok={result.ok}>{result.msg}</Result>}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function groupStagesByPipeline(rows: StageRow[]) {
  const map = new Map<string, StageRow[]>();
  for (const r of rows) {
    const key = r.pipelineName?.trim() || "Ungrouped";
    const arr = map.get(key);
    if (arr) arr.push(r);
    else map.set(key, [r]);
  }
  return Array.from(map, ([pipeline, stages]) => ({ pipeline, stages }));
}

function StageStep({
  clientId,
  stages,
  onDone,
}: {
  clientId: string;
  stages: StageRow[];
  onDone: () => void;
}) {
  const [rows, setRows] = useState(stages);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; msg: string } | null>(null);

  /*
   * Reset local edits when the server sends a new stage list (after a
   * re-import, or a router.refresh()). This is React's documented
   * adjust-state-during-render pattern — an effect would render once with the
   * stale list and then correct itself, briefly showing the old mapping.
   */
  const [seenStages, setSeenStages] = useState(stages);
  if (stages !== seenStages) {
    setSeenStages(stages);
    setRows(stages);
  }

  const mapped = new Set(rows.map((r) => r.canonicalStage).filter(Boolean));
  // Gate on the REQUIRED stages only. `disqualified` is offered in the dropdown
  // below but never blocks setup — a pipeline with no junk stage is a normal
  // pipeline, and demanding one would strand every client who does not run that
  // way at a step they cannot complete.
  const missing = REQUIRED_CANONICAL_STAGES.filter((s) => !mapped.has(s));
  const groups = groupStagesByPipeline(rows);
  const totalMapped = rows.filter((r) => r.canonicalStage).length;

  async function importStages() {
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/stages?refresh=1`);
      const body = await res.json();
      if (res.ok) {
        setRows(body.stages);
        setMsg({ ok: true, msg: `Imported ${body.stages.length} stages` });
        onDone();
      } else {
        setMsg({ ok: false, msg: failureText(body, "Import failed") });
      }
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/stages`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mappings: rows.map((r) => ({
            stageId: r.id,
            canonicalStage: r.canonicalStage,
          })),
        }),
      });
      const body = await res.json();
      setMsg(
        res.ok
          ? {
              ok: true,
              msg: `Saved.${
                body.reclassifiedTransitions
                  ? ` ${body.reclassifiedTransitions} existing transitions reclassified.`
                  : ""
              }`,
            }
          : { ok: false, msg: failureText(body, "Save failed") },
      );
      if (res.ok) onDone();
    } finally {
      setBusy(false);
    }
  }

  // Which pipeline sections are open. Default: only partially-mapped pipelines
  // (the ones needing a decision). Fully-mapped and untouched pipelines collapse,
  // turning a wall of 47 rows into a scannable list of 7.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const g of groupStagesByPipeline(stages)) {
      const m = g.stages.filter((x) => x.canonicalStage).length;
      if (m > 0 && m < g.stages.length) s.add(g.pipeline);
    }
    return s;
  });
  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const setCanonical = (id: string, canonical: CanonicalStage | null) =>
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, canonicalStage: canonical } : r)),
    );

  const pipelineOf = (r: StageRow) => r.pipelineName?.trim() || "Ungrouped";

  // Fill every still-unmapped stage in scope with its name-based suggestion.
  // Never overwrites an existing mapping — it is a first pass, not an authority.
  const autoMap = (pipeline?: string) =>
    setRows((prev) =>
      prev.map((r) => {
        if (r.canonicalStage) return r;
        if (pipeline && pipelineOf(r) !== pipeline) return r;
        const s = suggestCanonicalStage(r.name);
        return s ? { ...r, canonicalStage: s } : r;
      }),
    );

  // Mark a whole pipeline unused in one click — the pipeline-level control most
  // sub-accounts need, since they carry several pipelines unrelated to the ad
  // funnel that would otherwise be 12 "not used" dropdowns each.
  const ignorePipeline = (pipeline: string) => {
    setRows((prev) =>
      prev.map((r) =>
        pipelineOf(r) === pipeline ? { ...r, canonicalStage: null } : r,
      ),
    );
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(pipeline);
      return next;
    });
  };

  const autoMappable = rows.filter(
    (r) => !r.canonicalStage && suggestCanonicalStage(r.name),
  ).length;

  return (
    <Card
      step={2}
      anchor={SETUP_SECTION.stages}
      title="Map pipeline stages"
      description="Your GHL stage names, mapped onto the seven canonical funnel stages."
      done={rows.length > 0 && missing.length === 0}
    >
      <button
        onClick={importStages}
        disabled={busy}
        className="rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
        style={{
          borderColor: "var(--border-strong)",
          color: "var(--text-secondary)",
        }}
      >
        {busy
          ? "Working…"
          : rows.length
            ? "Re-import from GHL"
            : "Import from GHL"}
      </button>

      {rows.length > 0 && (
        <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              {rows.length} stages across {groups.length} pipeline
              {groups.length === 1 ? "" : "s"} · {totalMapped} mapped
            </p>
            {autoMappable > 0 && (
              <button
                onClick={() => autoMap()}
                className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-[12px] font-medium"
                style={{
                  borderColor: "var(--border-strong)",
                  color: "var(--text-secondary)",
                }}
              >
                ✨ Auto-map {autoMappable} by name
              </button>
            )}
          </div>

          <div className="mt-3 flex flex-col gap-2.5">
            {groups.map((group) => {
              const gMapped = group.stages.filter(
                (s) => s.canonicalStage,
              ).length;
              const total = group.stages.length;
              const full = gMapped === total;
              const none = gMapped === 0;
              const open = expanded.has(group.pipeline);
              const gAutoMappable = group.stages.filter(
                (s) => !s.canonicalStage && suggestCanonicalStage(s.name),
              ).length;
              return (
                <div
                  key={group.pipeline}
                  className="rounded-[var(--radius)] border"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button
                      onClick={() => toggle(group.pipeline)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span
                        className="text-[10px] transition-transform"
                        style={{
                          color: "var(--text-muted)",
                          transform: open ? "rotate(90deg)" : "none",
                        }}
                        aria-hidden="true"
                      >
                        ▶
                      </span>
                      <span
                        className="truncate text-[12px] font-semibold uppercase tracking-wide"
                        style={{ color: "var(--text-secondary)" }}
                        title={group.pipeline}
                      >
                        {group.pipeline}
                      </span>
                      <StageBadge
                        full={full}
                        none={none}
                        mapped={gMapped}
                        total={total}
                      />
                    </button>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {gAutoMappable > 0 && (
                        <button
                          onClick={() => autoMap(group.pipeline)}
                          className="tint-badge rounded-[var(--radius-xs)] px-2 py-1 text-[11px] font-medium"
                          style={{ "--tint": "var(--accent)" } as CSSProperties}
                        >
                          Auto-map
                        </button>
                      )}
                      {!none && (
                        <button
                          onClick={() => ignorePipeline(group.pipeline)}
                          className="rounded-[var(--radius-xs)] px-2 py-1 text-[11px] font-medium"
                          style={{
                            color: "var(--text-muted)",
                            background: "var(--surface-2)",
                          }}
                        >
                          Ignore
                        </button>
                      )}
                    </div>
                  </div>

                  {open && (
                    <div
                      className="flex flex-col gap-1 border-t px-3 py-2"
                      style={{ borderColor: "var(--border)" }}
                    >
                      {group.stages.map((row) => (
                        <div
                          key={row.id}
                          className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5"
                          style={{
                            background: row.canonicalStage
                              ? "transparent"
                              : "color-mix(in srgb, var(--status-warning) 7%, transparent)",
                          }}
                        >
                          <div className="min-w-0 flex-1">
                            <div
                              className="truncate text-[13px]"
                              style={{ color: "var(--text-primary)" }}
                            >
                              {row.name ?? (
                                <em style={{ color: "var(--text-muted)" }}>
                                  Unnamed stage
                                </em>
                              )}
                              {row.discoveredFromWebhook && (
                                <span
                                  className="ml-2 rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[10px] font-medium"
                                  style={{
                                    background:
                                      "color-mix(in srgb, var(--status-warning) 22%, transparent)",
                                    color: "var(--text-secondary)",
                                  }}
                                >
                                  seen in webhook
                                </span>
                              )}
                            </div>
                          </div>
                          <select
                            value={row.canonicalStage ?? ""}
                            onChange={(e) =>
                              setCanonical(
                                row.id,
                                (e.target.value ||
                                  null) as CanonicalStage | null,
                              )
                            }
                            className="min-w-[150px] rounded-[var(--radius-sm)] border px-2 py-1.5 text-[13px]"
                            style={inputStyle}
                          >
                            <option value="">— not used —</option>
                            {CANONICAL_STAGES.map((s) => (
                              <option key={s} value={s}>
                                {STAGE_LABELS[s]}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {missing.length > 0 && (
            <p
              className="mt-3 text-xs"
              style={{ color: "var(--status-warning)" }}
            >
              Unmapped: {missing.map((s) => STAGE_LABELS[s]).join(", ")} — these
              will read as zero in the funnel.
            </p>
          )}

          <button
            onClick={save}
            disabled={busy}
            className="mt-3 btn-accent disabled:opacity-50"
          >
            Save mapping
          </button>
        </>
      )}

      {msg && <Result ok={msg.ok}>{msg.msg}</Result>}
    </Card>
  );
}

/** Per-pipeline status pill: fully mapped ✓ / partial N∕T / not used. */
function StageBadge({
  full,
  none,
  mapped,
  total,
}: {
  full: boolean;
  none: boolean;
  mapped: number;
  total: number;
}) {
  const { text, color } = full
    ? { text: "✓ mapped", color: "var(--status-good)" }
    : none
      ? { text: "not used", color: "var(--text-muted)" }
      : { text: `${mapped}/${total}`, color: "var(--status-warning)" };
  return (
    <span
      className="tint-badge shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums"
      style={{ "--tint": color } as CSSProperties}
    >
      {text}
    </span>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Meta ad accounts — add as many as the client runs.
 *
 * A client can hold several accounts (e.g. one per location); the dashboard
 * sums spend and metrics across all of them. Each is verified against the Meta
 * API before it is stored, echoing back the real name/currency/timezone so a
 * mistyped id is caught immediately. The first account added sets the client's
 * display currency and bucketing timezone; a later account that disagrees on
 * either is flagged, because mixed currencies cannot be summed.
 */
function MetaAccountsStep({
  clientId,
  accounts,
  onDone,
  onConnected,
  connectConfigured,
  stash,
}: {
  clientId: string;
  accounts: MetaAccountRow[];
  onDone: () => void;
  /** After a successful attach: drops the used-up sign-in from the URL. */
  onConnected: () => void;
  /** META_APP_ID + META_APP_SECRET are set, so the consent flow can run. */
  connectConfigured: boolean;
  /** Present when we have just returned from Facebook — opens the picker. */
  stash: string | null;
}) {
  const [attachedSummary, setAttachedSummary] = useState<AttachSummary | null>(
    null,
  );
  const openStash = attachedSummary ? null : stash;
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{
    ok: boolean;
    text: string;
    warn?: string;
  } | null>(null);

  const live = accounts.filter((a) => a.status !== "removed");

  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/meta-accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adAccountId: accountId,
          token: token || undefined,
        }),
      });
      const body = await res.json();
      if (res.ok) {
        const warnings: string[] = [];
        if (body.currencyMismatch) {
          warnings.push(
            `Currency ${body.currencyMismatch.thisAccount} differs from the primary account's ${body.currencyMismatch.primary} — spend across different currencies cannot be summed correctly.`,
          );
        }
        if (body.timezoneMismatch) {
          warnings.push(
            `Timezone ${body.timezoneMismatch.thisAccount} differs from the primary ${body.timezoneMismatch.primary} — daily buckets may not line up.`,
          );
        }
        setMsg({
          ok: true,
          text: `Added ${body.account.accountName ?? body.account.adAccountId} · ${body.account.currency ?? "?"} · ${body.account.timezone ?? "?"}`,
          warn: warnings.join(" "),
        });
        setAccountId("");
        setToken("");
        setShowToken(false);
        onDone();
      } else {
        setMsg({ ok: false, text: failureText(body, "Failed to add account") });
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this ad account? Metrics already pulled are kept."))
      return;
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/meta-accounts/${id}`, {
        method: "DELETE",
      });
      if (res.ok) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      step={3}
      anchor={SETUP_SECTION.meta}
      title="Connect Meta ad accounts"
      description="Add every ad account this client runs. Spend and metrics are summed across all of them."
      done={live.length > 0}
    >
      {live.length > 0 && (
        <ul className="mb-4 flex flex-col gap-2">
          {live.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border p-2.5"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className="truncate text-[13px] font-medium"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {a.accountName ?? a.adAccountId}
                  </span>
                  {a.isPrimary && (
                    <span
                      className="rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[10px] font-medium"
                      style={{
                        background: "var(--surface-2)",
                        color: "var(--text-muted)",
                      }}
                    >
                      primary
                    </span>
                  )}
                </div>
                <div
                  className="text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  act_{a.adAccountId} · {a.currency ?? "?"} ·{" "}
                  {a.timezone ?? "?"}
                </div>
              </div>
              <button
                onClick={() => remove(a.id)}
                disabled={busy}
                className="shrink-0 text-xs hover:underline disabled:opacity-50"
                style={{ color: "var(--status-critical)" }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {/*
        The self-serve path, first, because it is the one that should be taken.
        The ad-account-ID form below stays as the fallback: it is the only route
        that works before Meta App Review passes for anyone without a role on
        the app, and the only one that uses the never-expiring system user token.
      */}
      {attachedSummary && (
        <AttachedNotice summary={attachedSummary} one="ad account" many="ad accounts" />
      )}

      {connectConfigured && !openStash && (
        <div className="mb-4">
          {/*
            #166FE5, not Meta's headline #1877F2: white on the brand blue is
            4.23:1, under the 4.5 floor. #166FE5 is Meta's own hover step, so
            the button still reads as theirs, and measures 4.73:1.

            And the hover fades the FILL, not the element. `opacity-90` on a
            white-on-blue button lightens the ink and the ground together, which
            took the fixed blue back down to 4.02:1 — a button that passes at
            rest and fails under the cursor. Darkening the fill moves contrast
            the right way (5.60:1). Meta's own spec does the same thing.
          */}
          <a
            href={`/api/oauth/meta/authorize?clientId=${encodeURIComponent(clientId)}`}
            className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] bg-[#166FE5] px-3.5 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-[#0C63D4]"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z" />
            </svg>
            Continue with Facebook
          </a>
          <p
            className="mt-1.5 text-[11.5px]"
            style={{ color: "var(--text-muted)" }}
          >
            Sign in with the Facebook account that holds these ads, then pick
            which ad accounts belong to this client.
          </p>
        </div>
      )}

      {openStash && (
        <MetaAccountPicker
          clientId={clientId}
          stash={openStash}
          onDone={onDone}
          onAttached={(summary) => {
            setAttachedSummary(summary);
            onConnected();
          }}
        />
      )}

      <div className="flex flex-col gap-3">
        <Field
          label={live.length ? "Add another ad account ID" : "Ad account ID"}
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          placeholder="1234567890 (or act_1234567890)"
        />
        {showToken ? (
          <Field
            label="Access token override (different Business Manager)"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Leave blank to use the system user token"
          />
        ) : (
          <button
            onClick={() => setShowToken(true)}
            className="self-start text-xs hover:underline"
            style={{ color: "var(--text-muted)" }}
          >
            + Add a token override (only if this account is in another Business
            Manager)
          </button>
        )}
        <button
          onClick={add}
          disabled={busy || !accountId}
          className="self-start btn-accent disabled:opacity-50"
        >
          {busy ? "Verifying…" : "Verify & add"}
        </button>
      </div>

      {msg && (
        <>
          <Result ok={msg.ok}>{msg.text}</Result>
          {msg.warn && (
            <p
              className="mt-2 text-xs"
              style={{ color: "var(--status-warning)" }}
            >
              ⚠ {msg.warn}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Google Ads accounts — the direct sibling of the Meta step.
 *
 * Unlike Meta (one system-user token in env), Google authorizes every account
 * through the agency MCC, so the only per-client input is the Customer ID. It is
 * verified against the Google Ads API before storing, echoing back the real
 * name/currency/timezone so a wrong id or an account that was never linked to
 * our MCC is caught in the moment rather than surfacing as silently missing
 * spend. When the agency Google env vars aren't set, the step explains that and
 * stays inert — Google is optional, a client can run Meta only.
 */
interface DiscoveredGoogleAccount {
  customerId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  isManager: boolean;
  level: number;
  /** The manager this account is reached through; `""` when reached directly. */
  loginCustomerId?: string;
}

/**
 * A manager row's checkbox: ticks every account reached through that manager.
 *
 * Mixed when only some of them are picked, so a manager whose accounts were
 * partly chosen by hand reads as exactly that rather than as unticked.
 */
function ManagerCheckbox({
  id,
  ids,
  picked,
  onChange,
  busy,
}: {
  id: string;
  ids: readonly string[];
  picked: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const cov = coverage(picked, ids);
  // Like "Select all", never offer a selection the attach route will refuse;
  // unticking a box that is already (partly) ticked always stays possible.
  const tooMany = ids.length > MAX_ATTACH_PER_SIGN_IN && cov === "none";
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = cov === "some";
  }, [cov]);
  return (
    <input
      ref={ref}
      id={id}
      type="checkbox"
      className="mt-1"
      disabled={busy || ids.length === 0 || tooMany}
      checked={cov === "all"}
      onChange={(e) =>
        onChange(e.target.checked ? selectAll(picked, ids) : deselectAll(picked, ids))
      }
    />
  );
}

/**
 * Pick which of the authorizing Google account's customers belong to a client.
 *
 * Two differences from the Meta picker, both forced by how Google Ads is shaped:
 *
 * 🔴 **Manager (MCC) accounts are never attached themselves.** A manager holds
 * no campaigns of its own, so attaching one produces an account that reports
 * zero spend forever — which on the dashboard is indistinguishable from a paused
 * account. Its checkbox instead selects every account reached through it, and
 * each account names the manager it sits under, because the rows are sorted by
 * name and the tree is otherwise invisible.
 *
 * The tree is flattened with indentation rather than collapsed, because a media
 * buyer identifies a client's account by where it sits under the manager at
 * least as often as by its own name.
 */
function GoogleAccountPicker({
  clientId,
  stash,
  onDone,
  onAttached,
}: {
  clientId: string;
  stash: string;
  onDone: () => void;
  onAttached: (summary: AttachSummary) => void;
}) {
  const [accounts, setAccounts] = useState<DiscoveredGoogleAccount[] | null>(
    null,
  );
  const [partial, setPartial] = useState(false);
  const [partialReason, setPartialReason] = useState<{
    error?: string;
    hint?: string;
    diagnostic?: string;
  } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/clients/${clientId}/google-connect?stash=${encodeURIComponent(stash)}`,
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(failureText(body, "Could not read that Google sign-in."));
          return;
        }
        setAccounts(body.accounts ?? []);
        setPartial(Boolean(body.partial));
        setPartialReason(body.partialReason ?? null);
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, stash]);

  async function attach() {
    if (!confirmLargeAttach(picked.size, "Google Ads accounts")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/google-connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stash, customerIds: [...picked] }),
      });
      const body = await res.json().catch(() => null);
      if (!body) {
        setError(NO_CLEAR_ANSWER);
        onDone();
        return;
      }
      if (!res.ok) {
        setError(failureText(body, "Could not attach those accounts."));
        return;
      }
      const failures: string[] = (body.failed ?? []).map(
        (f: { customerId: string; error: string }) => `${f.customerId}: ${f.error}`,
      );
      const attached = Array.isArray(body.attached) ? body.attached.length : 0;
      if (attached > 0) {
        onAttached({ attached, notes: failures });
        return;
      }
      setError(failures.join(" · ") || "Nothing was attached.");
      onDone();
    } catch {
      // The request may have reached the server and attached before the
      // connection dropped, so this is an unknown outcome, not a failure.
      setError(NO_CLEAR_ANSWER);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  if (error && !accounts) {
    return (
      <StashDeadEnd
        error={error}
        authorizeHref={`/api/oauth/google/authorize?clientId=${encodeURIComponent(clientId)}`}
        label="Sign in with Google again"
      />
    );
  }
  if (!accounts) {
    return (
      <p className="mb-4 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
        Reading the accounts on that Google login…
      </p>
    );
  }
  if (accounts.length === 0) {
    return (
      <p className="mb-4 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
        That Google account cannot reach any Ads accounts. Sign in with the
        account that manages these ads, or add the Customer ID below.
      </p>
    );
  }

  const q = filter.trim().toLowerCase();
  const shown = q
    ? accounts.filter((a) =>
        [a.name, a.customerId]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      )
    : accounts;
  const selectable = accounts.filter((a) => !a.isManager).length;
  const byManager = accountsByManager(accounts);
  const managerName = new Map(
    accounts
      .filter((a) => a.isManager)
      .map((a) => [a.customerId, a.name ?? a.customerId] as const),
  );
  const shownIds = shown.filter((a) => !a.isManager).map((a) => a.customerId);

  return (
    <div
      className="mb-4 rounded-[var(--radius)] border p-3"
      style={{
        borderColor: "var(--border-strong)",
        background: "var(--surface-2)",
      }}
    >
      <p
        className="text-[13px] font-medium"
        style={{ color: "var(--text-primary)" }}
      >
        Which of these belong to this client?
      </p>
      <p
        className="mt-0.5 text-[11.5px]"
        style={{ color: "var(--text-muted)" }}
      >
        {selectable} account{selectable === 1 ? "" : "s"} you can attach
        {accounts.length !== selectable &&
          `, plus ${accounts.length - selectable} manager account${
            accounts.length - selectable === 1 ? "" : "s"
          } shown for context`}
        .
      </p>

      {/*
        Surfaced rather than swallowed. Discovery walks each manager separately
        and skips branches it cannot read, so a short list looks identical to a
        complete one — which is how someone concludes an account "isn't there"
        and goes hunting in the wrong place.
      */}
      {partial && (
        <p
          className="mt-2 text-[11.5px]"
          style={{ color: "var(--status-warning)" }}
        >
          Some parts of this account tree could not be read, so this list may be
          incomplete. If an account you expect is missing, add its Customer ID
          below.
          {/*
            🔴 And WHY. Without this the sentence above cannot distinguish one
            suspended manager — ignorable — from every account being refused,
            which is a connection that will never sync. The two look identical
            and the only next move is to guess, which is how an afternoon goes.
          */}
          {partialReason?.error && (
            <>
              {" "}
              <span style={{ color: "var(--text-secondary)" }}>
                {partialReason.error}
                {partialReason.hint ? ` ${partialReason.hint}` : ""}
              </span>
            </>
          )}
        </p>
      )}
      {/* Superadmin only, and deliberately verbatim: the redacted sentence
          above is what a tenant may read, and this is what actually names the
          cause when it has to be diagnosed. */}
      {partialReason?.diagnostic && (
        <p
          className="mt-1 font-mono text-[10.5px] break-words"
          style={{ color: "var(--text-muted)" }}
        >
          {partialReason.diagnostic}
        </p>
      )}

      {accounts.length > 8 && (
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name or Customer ID…"
          className="mt-2 w-full rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[13px]"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--surface-1)",
            color: "var(--text-primary)",
          }}
        />
      )}

      <SelectionBar
        shownIds={shownIds}
        picked={picked}
        onChange={setPicked}
        busy={busy}
        filtered={q !== ""}
        noun="accounts"
      />

      {shown.length === 0 ? (
        <p
          className="mt-2 text-[12.5px]"
          style={{ color: "var(--text-muted)" }}
        >
          No account on this login matches “{filter.trim()}”.
        </p>
      ) : (
        <ul className="mt-1 flex flex-col">
          {shown.map((a) => (
            <li
              key={a.customerId}
              className="flex items-start gap-2.5 py-1.5"
              // Indent by depth so a client's account reads as sitting under
              // the manager the operator recognises.
              style={{ paddingLeft: `${Math.min(a.level, 4) * 14}px` }}
            >
              {a.isManager ? (
                <ManagerCheckbox
                  id={`g-${a.customerId}`}
                  ids={byManager.get(a.customerId) ?? []}
                  picked={picked}
                  onChange={setPicked}
                  busy={busy}
                />
              ) : (
                <input
                  id={`g-${a.customerId}`}
                  type="checkbox"
                  className="mt-1"
                  disabled={busy}
                  checked={picked.has(a.customerId)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(a.customerId);
                    else next.delete(a.customerId);
                    setPicked(next);
                  }}
                />
              )}
              <label
                htmlFor={`g-${a.customerId}`}
                className="min-w-0 flex-1 cursor-pointer"
                style={{
                  opacity:
                    a.isManager && !(byManager.get(a.customerId)?.length ?? 0)
                      ? 0.55
                      : 1,
                }}
              >
                <span
                  className="block text-[13px] font-medium"
                  style={{ color: "var(--text-primary)" }}
                >
                  {a.name ?? a.customerId}
                  {a.isManager && (
                    <span
                      className="ml-1.5 text-[11px] font-normal"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {(() => {
                        const n = byManager.get(a.customerId)?.length ?? 0;
                        if (n > MAX_ATTACH_PER_SIGN_IN)
                          return `· manager account — ${n} accounts, more than the ${MAX_ATTACH_PER_SIGN_IN} that can be attached at once; tick them individually or filter and use Select all`;
                        if (n > 0)
                          return `· manager account — tick to select its ${n} account${n === 1 ? "" : "s"}`;
                        // A sub-manager: its accounts are reached through the
                        // manager above it, so they are grouped there.
                        const parent =
                          a.loginCustomerId && a.loginCustomerId !== a.customerId
                            ? managerName.get(a.loginCustomerId)
                            : undefined;
                        return parent
                          ? `· manager account — its accounts are selected under ${parent}`
                          : "· manager account — holds no campaigns";
                      })()}
                    </span>
                  )}
                </span>
                <span
                  className="block text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {a.customerId} · {a.currency ?? "?"} · {a.timezone ?? "?"}
                  {!a.isManager &&
                    a.loginCustomerId &&
                    managerName.has(a.loginCustomerId) &&
                    ` · via ${managerName.get(a.loginCustomerId)}`}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {picked.size > 0 && filter.trim() !== "" && (
        <p
          className="mt-2 text-[11.5px]"
          style={{ color: "var(--text-muted)" }}
        >
          {picked.size} selected in total, including accounts hidden by the
          filter.
        </p>
      )}

      <AttachCapNote count={picked.size} noun="accounts" />

      {error && (
        <p
          className="mt-2 text-[12px]"
          style={{ color: "var(--status-critical)" }}
        >
          {error}
        </p>
      )}

      <button
        onClick={attach}
        disabled={busy || picked.size === 0 || picked.size > MAX_ATTACH_PER_SIGN_IN}
        className="mt-3 btn-accent disabled:opacity-60"
      >
        {busy
          ? "Attaching…"
          : picked.size
            ? `Attach ${picked.size} ${picked.size === 1 ? "account" : "accounts"}`
            : "Attach accounts"}
      </button>
    </div>
  );
}

function GoogleAccountsStep({
  clientId,
  accounts,
  configured,
  stash,
  onDone,
  onConnected,
}: {
  clientId: string;
  accounts: GoogleAccountRow[];
  configured: boolean;
  stash: string | null;
  onDone: () => void;
  /** After a successful attach: drops the used-up sign-in from the URL. */
  onConnected: () => void;
}) {
  const [attachedSummary, setAttachedSummary] = useState<AttachSummary | null>(
    null,
  );
  const openStash = attachedSummary ? null : stash;
  const [customerId, setCustomerId] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{
    ok: boolean;
    text: string;
    warn?: string;
  } | null>(null);

  const live = accounts.filter((a) => a.status !== "removed");

  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/google-accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, refreshToken: token || undefined }),
      });
      const body = await res.json();
      if (res.ok) {
        const warnings: string[] = [];
        if (body.currencyMismatch) {
          warnings.push(
            `Currency ${body.currencyMismatch.thisAccount} differs from the primary account's ${body.currencyMismatch.primary} — spend across different currencies cannot be summed correctly.`,
          );
        }
        if (body.timezoneMismatch) {
          warnings.push(
            `Timezone ${body.timezoneMismatch.thisAccount} differs from the primary ${body.timezoneMismatch.primary} — daily buckets may not line up.`,
          );
        }
        setMsg({
          ok: true,
          text: `Added ${body.account.accountName ?? body.account.customerId} · ${body.account.currency ?? "?"} · ${body.account.timezone ?? "?"}`,
          warn: warnings.join(" "),
        });
        setCustomerId("");
        setToken("");
        setShowToken(false);
        onDone();
      } else {
        setMsg({ ok: false, text: failureText(body, "Failed to add account") });
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (
      !confirm(
        "Remove this Google Ads account? Metrics already pulled are kept.",
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/clients/${clientId}/google-accounts/${id}`,
        {
          method: "DELETE",
        },
      );
      if (res.ok) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      step={4}
      anchor={SETUP_SECTION.google}
      title="Connect Google Ads (optional)"
      description="Add the client's Customer ID. Spend, impressions and clicks are summed in alongside Meta."
      done={live.length > 0}
    >
      {!configured && live.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--status-warning)" }}>
          Google Ads isn&rsquo;t configured on this deployment yet. Add the
          Google OAuth client (<code>GOOGLE_ADS_CLIENT_ID</code> and
          <code>GOOGLE_ADS_CLIENT_SECRET</code>) to the environment (see{" "}
          <code>SETUP.md</code> §2b), then reload. A client can run Meta-only
          until then.
        </p>
      ) : (
        <>
          {live.length > 0 && (
            <ul className="mb-4 flex flex-col gap-2">
              {live.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border p-2.5"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="truncate text-[13px] font-medium"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {a.accountName ?? a.customerId}
                      </span>
                      {a.isPrimary && (
                        <span
                          className="rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[10px] font-medium"
                          style={{
                            background: "var(--surface-2)",
                            color: "var(--text-muted)",
                          }}
                        >
                          primary
                        </span>
                      )}
                    </div>
                    <div
                      className="text-[11px]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {a.customerId} · {a.currency ?? "?"} · {a.timezone ?? "?"}
                    </div>
                  </div>
                  <button
                    onClick={() => remove(a.id)}
                    disabled={busy}
                    className="shrink-0 text-xs hover:underline disabled:opacity-50"
                    style={{ color: "var(--status-critical)" }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/*
            The self-serve path, first, because it is the one that should be
            taken. This route already existed and worked — it was simply linked
            from nowhere, so the only visible option was pasting a raw refresh
            token, which is the agency-MCC path and the worst first-run moment
            in the product. Mirrors the Meta step above.
          */}
          {attachedSummary && (
            <AttachedNotice summary={attachedSummary} one="account" many="accounts" />
          )}

          {!openStash && (
            <div className="mb-4">
              <a
                href={`/api/oauth/google/authorize?clientId=${encodeURIComponent(clientId)}`}
                className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] border px-3.5 py-2.5 text-[13.5px] font-semibold transition-opacity hover:opacity-90"
                style={{
                  background: "#ffffff",
                  color: "#1f1f1f",
                  borderColor: "#dadce0",
                }}
              >
                <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden="true">
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                </svg>
                Continue with Google
              </a>
              <p
                className="mt-1.5 text-[11.5px]"
                style={{ color: "var(--text-muted)" }}
              >
                Sign in with the Google account that manages these ads, then
                pick which accounts belong to this client.
              </p>
              {/*
                The Google Ads Developer Policy requires the data-access
                disclosure to sit in the normal flow at the point of connecting
                — not behind a menu or only in the privacy policy. Keep it next
                to the button, and keep it in step with /legal/privacy.
              */}
              <p
                className="mt-1 text-[11.5px] leading-relaxed"
                style={{ color: "var(--text-muted)" }}
              >
                What we access: read-only. We list the Google Ads accounts this
                sign-in can reach so you can choose, then read daily campaign
                names, impressions, clicks, cost and conversions for the ones
                you pick, to report them next to this client&rsquo;s pipeline.
                We never change campaigns, budgets or bids. Disconnect here any
                time; see our{" "}
                <a
                  href="/legal/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  privacy policy
                </a>
                .
              </p>
            </div>
          )}

          {openStash && (
            <GoogleAccountPicker
              clientId={clientId}
              stash={openStash}
              onDone={onDone}
              onAttached={(summary) => {
                setAttachedSummary(summary);
                onConnected();
              }}
            />
          )}

          <div className="flex flex-col gap-3">
            <Field
              label={live.length ? "Add another Customer ID" : "Customer ID"}
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="123-456-7890"
            />
            {showToken ? (
              <Field
                label="Refresh token override (account not under the agency MCC)"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Leave blank to use the agency MCC token"
              />
            ) : (
              <button
                onClick={() => setShowToken(true)}
                className="self-start text-xs hover:underline"
                style={{ color: "var(--text-muted)" }}
              >
                + Add a token override (only if this account is not linked to
                our MCC)
              </button>
            )}
            <button
              onClick={add}
              disabled={busy || !customerId}
              className="self-start btn-accent disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Verify & add"}
            </button>
          </div>

          {msg && (
            <>
              <Result ok={msg.ok}>{msg.text}</Result>
              {msg.warn && (
                <p
                  className="mt-2 text-xs"
                  style={{ color: "var(--status-warning)" }}
                >
                  ⚠ {msg.warn}
                </p>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

interface DiscoveredTiktokAdvertiser {
  advertiserId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
}

/**
 * Pick which of the authorizing TikTok grant's advertisers belong to a client.
 *
 * 🔴 Selection is separate from authorization for the same reason as Meta and
 * Google, and here the risk is at its most literal: TikTok's token exchange
 * hands back an `advertiser_ids` **array**. One approval can cover every
 * advertiser an agency manages, so attaching what the grant can see would put
 * another client's spend on this dashboard. Nothing is pre-ticked.
 *
 * Simpler than the Google picker in one respect — TikTok has no manager
 * hierarchy, so there is no shown-but-disabled row. Every advertiser listed
 * holds campaigns.
 */
function TiktokAccountPicker({
  clientId,
  stash,
  onDone,
  onAttached,
}: {
  clientId: string;
  stash: string;
  onDone: () => void;
  onAttached: (summary: AttachSummary) => void;
}) {
  const [advertisers, setAdvertisers] = useState<
    DiscoveredTiktokAdvertiser[] | null
  >(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  /*
   * 🔴 Currency and timezone are unknown, not absent.
   *
   * Each row renders `{currency ?? "?"} · {timezone ?? "?"}`, so a failed
   * `/advertiser/info/` call turns the whole column into `?` and looks
   * identical to TikTok simply not reporting one — which, for an ad account,
   * does not happen. This product sums spend across accounts and currencies
   * cannot be summed, so picking blind here is how a EUR advertiser lands in a
   * USD total. The attach step still catches it, but by then the choice is
   * made and the warning is a surprise instead of information.
   */
  const [detailUnavailable, setDetailUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/clients/${clientId}/tiktok-connect?stash=${encodeURIComponent(stash)}`,
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(
            failureText(body, "Could not read that TikTok authorization."),
          );
          return;
        }
        setAdvertisers(body.advertisers ?? []);
        setDetailUnavailable(Boolean(body.detailUnavailable));
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, stash]);

  async function attach() {
    if (!confirmLargeAttach(picked.size, "advertisers")) return;
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const res = await fetch(`/api/clients/${clientId}/tiktok-connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stash, advertiserIds: [...picked] }),
      });
      const body = await res.json().catch(() => null);
      if (!body) {
        setError(NO_CLEAR_ANSWER);
        onDone();
        return;
      }
      if (!res.ok) {
        setError(failureText(body, "Could not attach those advertisers."));
        return;
      }
      const failures: string[] = (body.failed ?? []).map(
        (f: { advertiserId: string; error: string }) =>
          `${f.advertiserId}: ${f.error}`,
      );
      /*
       * Mixed currencies cannot be summed and mismatched timezones make "a day"
       * mean two things across platforms. Neither blocks the attach — the
       * operator may know exactly why — but neither may be silent, so both
       * travel with the summary that replaces this picker.
       */
      const warned: string[] = (body.warnings ?? []).map(
        (w: { advertiserId: string; message: string }) =>
          `${w.advertiserId}: ${w.message}`,
      );
      const attached = Array.isArray(body.attached) ? body.attached.length : 0;
      if (attached > 0) {
        onAttached({ attached, notes: [...failures, ...warned] });
        return;
      }
      setError(failures.join(" · ") || "Nothing was attached.");
      setWarnings(warned);
      onDone();
    } catch {
      // The request may have reached the server and attached before the
      // connection dropped, so this is an unknown outcome, not a failure.
      setError(NO_CLEAR_ANSWER);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  if (error && !advertisers) {
    return (
      <StashDeadEnd
        error={error}
        authorizeHref={`/api/oauth/tiktok/authorize?clientId=${encodeURIComponent(clientId)}`}
        label="Authorize TikTok again"
      />
    );
  }
  if (!advertisers) {
    return (
      <p className="mb-4 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
        Reading the advertisers on that TikTok authorization…
      </p>
    );
  }
  if (advertisers.length === 0) {
    return (
      <p className="mb-4 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
        That TikTok authorization cannot reach any advertiser accounts.
        Authorize again with an account that has access to them in Business
        Center.
      </p>
    );
  }

  const q = filter.trim().toLowerCase();
  const shown = q
    ? advertisers.filter((a) =>
        [a.name, a.advertiserId]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      )
    : advertisers;

  return (
    <div
      className="mb-4 rounded-[var(--radius)] border p-3"
      style={{
        borderColor: "var(--border-strong)",
        background: "var(--surface-2)",
      }}
    >
      <p
        className="text-[13px] font-medium"
        style={{ color: "var(--text-primary)" }}
      >
        Which of these belong to this client?
      </p>
      <p
        className="mt-0.5 text-[11.5px]"
        style={{ color: "var(--text-muted)" }}
      >
        {advertisers.length} advertiser{advertisers.length === 1 ? "" : "s"} on
        this TikTok authorization.
      </p>

      {detailUnavailable && (
        <p
          role="status"
          className="mt-1.5 text-[11.5px]"
          style={{ color: "var(--status-warning)" }}
        >
          Currency and timezone could not be read for these advertisers, so both
          show as “?” below — TikTok answered the list but not the detail. You
          can still pick, and each account is re-checked on attach; if a currency
          differs from this client&rsquo;s, you will be told then.
        </p>
      )}

      {advertisers.length > 8 && (
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by advertiser name or ID…"
          className="mt-2 w-full rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[13px]"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--surface-1)",
            color: "var(--text-primary)",
          }}
        />
      )}

      <SelectionBar
        shownIds={shown.map((a) => a.advertiserId)}
        picked={picked}
        onChange={setPicked}
        busy={busy}
        filtered={q !== ""}
        noun="advertisers"
      />

      {shown.length === 0 ? (
        <p
          className="mt-2 text-[12.5px]"
          style={{ color: "var(--text-muted)" }}
        >
          No advertiser on this authorization matches “{filter.trim()}”.
        </p>
      ) : (
        <ul className="mt-1 flex flex-col">
          {shown.map((a) => (
            <li
              key={a.advertiserId}
              className="flex items-start gap-2.5 py-1.5"
            >
              <input
                id={`tt-${a.advertiserId}`}
                type="checkbox"
                className="mt-1"
                disabled={busy}
                checked={picked.has(a.advertiserId)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(a.advertiserId);
                  else next.delete(a.advertiserId);
                  setPicked(next);
                }}
              />
              <label
                htmlFor={`tt-${a.advertiserId}`}
                className="min-w-0 flex-1 cursor-pointer"
              >
                <span
                  className="block text-[13px] font-medium"
                  style={{ color: "var(--text-primary)" }}
                >
                  {a.name ?? a.advertiserId}
                </span>
                <span
                  className="block text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {a.advertiserId} · {a.currency ?? "?"} · {a.timezone ?? "?"}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {picked.size > 0 && filter.trim() !== "" && (
        <p
          className="mt-2 text-[11.5px]"
          style={{ color: "var(--text-muted)" }}
        >
          {picked.size} selected in total, including advertisers hidden by the
          filter.
        </p>
      )}

      {/*
        🔴 The opposite of the Facebook picker's expiry line, and stated for the
        same reason: someone comparing platforms deserves to know which
        connection lapses. TikTok access tokens do not expire and there is no
        refresh token — a real "never", not an unknown we are hiding.
      */}
      <p className="mt-2 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
        This authorization does not expire. It ends only if the TikTok account
        that granted it loses access to the advertiser.
      </p>

      {error && (
        <p
          className="mt-2 text-[12px]"
          style={{ color: "var(--status-critical)" }}
        >
          {error}
        </p>
      )}
      {warnings.map((w) => (
        <p
          key={w}
          className="mt-2 text-[12px]"
          style={{ color: "var(--status-warning)" }}
        >
          ⚠ {w}
        </p>
      ))}

      <AttachCapNote count={picked.size} noun="advertisers" />

      <button
        onClick={attach}
        disabled={busy || picked.size === 0 || picked.size > MAX_ATTACH_PER_SIGN_IN}
        className="accent-fill mt-3 rounded-[var(--radius-sm)] px-3 py-2 text-[13px] font-medium disabled:opacity-60"
      >
        {busy
          ? "Attaching…"
          : picked.size
            ? `Attach ${picked.size} ${picked.size === 1 ? "advertiser" : "advertisers"}`
            : "Attach advertisers"}
      </button>
    </div>
  );
}

/**
 * TikTok advertisers — the third platform, and the only one with no manual
 * fallback.
 *
 * Meta has the system-user token and Google has the agency MCC refresh token,
 * so both keep an id-entry form for the case where consent is unavailable.
 * TikTok has no shared-credential equivalent: a token exists only as the output
 * of an authorization. So when the app is not configured this step says so and
 * stays inert rather than offering a form that could never work.
 */
function TiktokAccountsStep({
  clientId,
  accounts,
  onDone,
  onConnected,
  connectConfigured,
  stash,
}: {
  clientId: string;
  accounts: TiktokAccountRow[];
  onDone: () => void;
  /** After a successful attach: drops the used-up sign-in from the URL. */
  onConnected: () => void;
  /** TIKTOK_APP_ID + TIKTOK_APP_SECRET are set, so the flow can run. */
  connectConfigured: boolean;
  /** Present when we have just returned from TikTok — opens the picker. */
  stash: string | null;
}) {
  const [attachedSummary, setAttachedSummary] = useState<AttachSummary | null>(
    null,
  );
  const openStash = attachedSummary ? null : stash;
  const [busy, setBusy] = useState(false);
  const live = accounts.filter((a) => a.status !== "removed");

  async function remove(id: string) {
    if (!confirm("Remove this advertiser? Metrics already pulled are kept."))
      return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/clients/${clientId}/tiktok-accounts/${id}`,
        {
          method: "DELETE",
        },
      );
      if (res.ok) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      step={5}
      anchor={SETUP_SECTION.tiktok}
      title="Connect TikTok advertisers"
      description="Optional. Adds TikTok spend alongside Meta and Google so the blended totals are complete."
      done={live.length > 0}
    >
      {live.length > 0 && (
        <ul className="mb-4 flex flex-col gap-2">
          {live.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border p-2.5"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="min-w-0 flex-1">
                <span
                  className="block truncate text-[13px] font-medium"
                  style={{ color: "var(--text-primary)" }}
                >
                  {a.advertiserName ?? a.advertiserId}
                </span>
                <span
                  className="text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {a.advertiserId} · {a.currency ?? "?"} · {a.timezone ?? "?"}
                </span>
              </div>
              <button
                onClick={() => remove(a.id)}
                disabled={busy}
                className="shrink-0 text-xs hover:underline disabled:opacity-50"
                style={{ color: "var(--status-critical)" }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {attachedSummary && (
        <AttachedNotice summary={attachedSummary} one="advertiser" many="advertisers" />
      )}

      {!connectConfigured ? (
        <p className="text-[12.5px]" style={{ color: "var(--text-muted)" }}>
          TikTok isn’t configured on this installation. Set{" "}
          <code>TIKTOK_APP_ID</code> and <code>TIKTOK_APP_SECRET</code> from the
          app at business-api.tiktok.com. Everything else works without it — a
          client can run Meta and Google only.
        </p>
      ) : (
        !openStash && (
          <div>
            <a
              href={`/api/oauth/tiktok/authorize?clientId=${encodeURIComponent(clientId)}`}
              className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] px-3.5 py-2.5 text-[13.5px] font-semibold text-white transition-opacity hover:opacity-90"
              style={{ background: "#000000" }}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 0 1-2.59 2.5 2.59 2.59 0 0 1 0-5.18c.27 0 .52.04.76.12v-3.2a5.72 5.72 0 0 0-.76-.05A5.79 5.79 0 0 0 4.07 15.4a5.79 5.79 0 0 0 11.58 0V9.01a7.35 7.35 0 0 0 4.29 1.37V7.29a4.29 4.29 0 0 1-3.34-1.47z" />
              </svg>
              Continue with TikTok
            </a>

            {/*
              🔴 Said BEFORE the click, not discovered mid-flow.

              TikTok emails the advertiser a verification code partway through
              authorization and will not proceed without it. Someone who does
              not expect that reads the pause as a broken flow and abandons —
              which is the single most likely way this connection fails for a
              reason that is not a fault.
            */}
            <p
              className="mt-2 text-[11.5px]"
              style={{ color: "var(--status-warning)" }}
            >
              TikTok will email a verification code partway through and won’t
              continue until it’s entered. Have that inbox open before you
              start.
            </p>
            <p
              className="mt-1 text-[11.5px]"
              style={{ color: "var(--text-muted)" }}
            >
              Then pick which advertisers belong to this client. The
              authorization does not expire.
            </p>
          </div>
        )
      )}

      {openStash && (
        <TiktokAccountPicker
          clientId={clientId}
          stash={openStash}
          onDone={onDone}
          onAttached={(summary) => {
            setAttachedSummary(summary);
            onConnected();
          }}
        />
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Waits for a real event rather than trusting that the URL was pasted.
 * Polls the health endpoint until `firstWebhookAt` is populated.
 */
function WebhookStep({
  clientId,
  webhookUrl,
  firstWebhookAt,
}: {
  clientId: string;
  webhookUrl: string;
  firstWebhookAt: string | null;
}) {
  const [received, setReceived] = useState(Boolean(firstWebhookAt));
  const [listening, setListening] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!listening || received) return;
    timer.current = setInterval(async () => {
      const res = await fetch(`/api/clients/${clientId}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const body = await res.json();
        if (body.client?.firstWebhookAt) {
          setReceived(true);
          setListening(false);
        }
      }
    }, 3000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [listening, received, clientId]);

  return (
    <Card
      step={6}
      title="Install the GHL webhook"
      description="In GHL: Automation → Workflows → new workflow → trigger 'Pipeline Stage Changed' → action 'Webhook'."
      done={received}
    >
      <div
        className="flex items-center gap-2 rounded-[var(--radius-sm)] border p-2"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--surface-2)",
        }}
      >
        <code
          className="min-w-0 flex-1 truncate text-[12px]"
          style={{ color: "var(--text-primary)" }}
        >
          {webhookUrl}
        </code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(webhookUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          className="shrink-0 rounded-[var(--radius-xs)] border px-2 py-1 text-[12px]"
          style={{
            borderColor: "var(--border-strong)",
            color: "var(--text-secondary)",
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {received ? (
        <Result ok>
          Webhook events are arriving — funnel history is recording.
        </Result>
      ) : (
        <>
          <button
            onClick={() => setListening(true)}
            disabled={listening}
            className="mt-3 btn-accent disabled:opacity-60"
          >
            {listening ? "Waiting for first event…" : "Test connection"}
          </button>
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
            Move any opportunity between stages in GHL. This will turn green the
            moment a real event lands — until then, no pipeline history is being
            recorded, and it cannot be backfilled later.
          </p>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

/** "90 days" / "12 months" / "36 months", for button and result copy. */
/** "2026-09" → "Sep 2026". */
function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function windowLabel(days: number): string {
  return days >= 365 ? `${Math.round(days / 30.44 / 12) * 12} months` : `${days} days`;
}

function BackfillStep({
  clientId,
  slug,
  step,
  hasTiktok,
  hasGoogle,
}: {
  clientId: string;
  slug: string;
  step: number;
  /** Only offer the TikTok import once an advertiser is actually attached. */
  hasTiktok: boolean;
  /** Same for Google: an import with no account behind it can only fail. */
  hasGoogle: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  /*
   * An account that stopped spending more than 90 days ago returns nothing
   * from the default window, and a backfill reporting "0 rows" reads as a
   * broken connection rather than an old one. Meta keeps ~37 months.
   */
  const [days, setDays] = useState(90);
  /** The ad-level import's months so far, while it runs. */
  const [progress, setProgress] = useState<string | null>(null);
  const stopRef = useRef(false);
  /** Stop was pressed; the request under way finishes first. */
  const [stopping, setStopping] = useState(false);

  /*
   * Ad-level history arrives a few months per request (each fits the route's
   * time limit), so the button keeps asking until the window is done. Stopping
   * keeps what was imported; pressing again carries on, because months that
   * are already complete are skipped on the server.
   */
  async function importAdLevel(action: "meta_adlevel_backfill" | "tiktok_adlevel_backfill") {
    const tiktok = action === "tiktok_adlevel_backfill";
    setBusy(action);
    setMsg(null);
    setProgress(null);
    stopRef.current = false;
    let before: string | undefined;
    let rows = 0;
    const months: string[] = [];
    try {
      for (let request = 0; request < 40; request++) {
        const res = await fetch(`/api/clients/${clientId}/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, days, ...(before ? { before } : {}) }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setMsg({ ok: false, msg: failureText(body, "The ad-level import failed") });
          return;
        }
        rows += Number(body.rowsWritten) || 0;
        for (const m of (body.months ?? []) as Array<{ month: string }>) months.push(monthName(m.month));
        if (body.done) {
          setMsg({
            ok: true,
            msg:
              rows === 0
                ? `${tiktok ? "TikTok ad-level" : "Ad-level"} detail for the last ${windowLabel(days)} was already complete.`
                : `Imported ${rows} ${tiktok ? "TikTok " : ""}ad-level rows across ${months.length} months. ${tiktok ? "TikTok creative" : "Creative"} cards and ad tables now reach back ${windowLabel(days)}.`,
          });
          return;
        }
        before = body.nextBefore ?? undefined;
        setProgress(`${months.join(", ")} done — carrying on…`);
        if (stopRef.current) {
          setMsg({
            ok: true,
            msg: `Stopped after ${months.length} months (${rows} rows). Press the button again to carry on where it stopped.`,
          });
          return;
        }
      }
      setMsg({ ok: false, msg: "The import is taking longer than expected. Press the button again to carry on." });
    } finally {
      setBusy(null);
      setProgress(null);
      setStopping(false);
    }
  }

  /*
   * GoHighLevel history arrives a page at a time — every contact, then every
   * opportunity — and the server hands back where it stopped, so a large
   * sub-account finishes across a few requests instead of timing out in one.
   * Where it stopped is kept between presses: after a stop, a failure or a
   * dropped connection, pressing again carries on from there rather than
   * starting over. Repeating work is safe either way — nothing is written twice.
   */
  const ghlCursorRef = useRef<string | undefined>(undefined);

  async function importGhl() {
    setBusy("ghl_backfill");
    setMsg(null);
    setProgress(null);
    stopRef.current = false;
    const n = (v: unknown) => (Number(v) || 0).toLocaleString("en-US");
    const carryOn = (why: string) =>
      /import again/i.test(why) ? why : `${why} Import again to carry on where it stopped — nothing is imported twice.`;

    /** One request. A reply cut off by the time limit, or a dropped connection, is tried once more from the same place. */
    async function post(cursor: string | undefined) {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(`/api/clients/${clientId}/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "ghl_backfill", ...(cursor ? { cursor } : {}) }),
          });
          // A request cut off by the time limit answers with a page that is not JSON.
          const body = await res.json().catch(() => null);
          if (attempt === 0 && (res.status === 504 || !body)) {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          return { res, body };
        } catch {
          if (attempt > 0) return null;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }

    try {
      for (let request = 0; request < 60; request++) {
        const reply = await post(ghlCursorRef.current);
        if (!reply) {
          setMsg({ ok: false, msg: carryOn("Could not reach the server.") });
          return;
        }
        const { res, body } = reply;
        if (!res.ok || !body) {
          // A cursor the server refused can only be refused again: the next press starts afresh.
          if (res.status === 400) ghlCursorRef.current = undefined;
          const why = body
            ? failureText(body, "The GoHighLevel import failed")
            : `The GoHighLevel import was cut off (HTTP ${res.status}).`;
          setMsg({ ok: false, msg: res.status === 400 ? why : carryOn(why) });
          return;
        }
        const t = body.totals ?? {};
        if (body.done) {
          ghlCursorRef.current = undefined;
          const notes = ((body.notes ?? []) as string[]).join(" ");
          setMsg({
            ok: true,
            msg:
              `Imported ${n(t.contacts)} contacts and ${n(t.opportunities)} opportunities from GoHighLevel` +
              (Number(t.leads) > 0 ? `, with ${n(t.leads)} past leads dated to when they came in.` : ".") +
              (notes ? ` ${notes}` : ""),
          });
          return;
        }
        ghlCursorRef.current = body.cursor ?? undefined;
        setProgress(
          `${body.phase === "contacts" ? "Contacts" : "Opportunities"}: ${n(t.contacts)} contacts and ${n(
            t.opportunities,
          )} opportunities so far — carrying on…`,
        );
        if (stopRef.current) {
          setMsg({
            ok: true,
            msg: `Stopped after ${n(t.contacts)} contacts and ${n(t.opportunities)} opportunities. Import again to carry on where it stopped — nothing is imported twice.`,
          });
          return;
        }
      }
      setMsg({ ok: false, msg: "The import is taking longer than expected. Import again to carry on where it stopped." });
    } finally {
      setBusy(null);
      setProgress(null);
      setStopping(false);
    }
  }

  async function run(action: "meta_backfill" | "google_backfill" | "tiktok_backfill") {
    setBusy(action);
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, days }),
      });
      const body = await res.json();
      setMsg(
        res.ok
          ? {
              ok: true,
              msg:
                body.rowsWritten === 0
                  ? `No spend found in the last ${windowLabel(days)}. The connection works — this account simply has no activity in that window. Try a longer one.`
                  : `Imported ${body.rowsWritten} daily metric rows.`,
            }
          : { ok: false, msg: failureText(body, "Failed") },
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      step={step}
      title="Import historical data"
      description="Optional. Ad platform history imports fully, results included. GoHighLevel history imports every contact and opportunity, with each lead dated to when it came in. Ad-level detail — what creative cards and ad tables read — imports separately, month by month."
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="backfill-window">
          How far back to import Meta data
        </label>
        <select
          id="backfill-window"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          disabled={busy !== null}
          className="rounded-[var(--radius-sm)] border px-2 py-2 text-[13px] disabled:opacity-50"
          style={{
            borderColor: "var(--border-strong)",
            color: "var(--text-secondary)",
            background: "var(--surface-raised)",
          }}
        >
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 12 months</option>
          <option value={1095}>Last 36 months</option>
        </select>
        <button
          onClick={() => run("meta_backfill")}
          disabled={busy !== null}
          className="rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
          style={{
            borderColor: "var(--border-strong)",
            color: "var(--text-secondary)",
          }}
        >
          {busy === "meta_backfill"
            ? "Importing…"
            : `Import ${windowLabel(days)} of Meta data`}
        </button>
        <button
          onClick={() => importAdLevel("meta_adlevel_backfill")}
          disabled={busy !== null}
          className="rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
          style={{
            borderColor: "var(--border-strong)",
            color: "var(--text-secondary)",
          }}
        >
          {busy === "meta_adlevel_backfill" ? "Importing ad-level detail…" : "Import ad-level detail (creative cards, ad sets)"}
        </button>
        {(busy === "meta_adlevel_backfill" || busy === "tiktok_adlevel_backfill" || busy === "ghl_backfill") && (
          <button
            onClick={() => {
              stopRef.current = true;
              setStopping(true);
            }}
            disabled={stopping}
            className="rounded-[var(--radius-sm)] px-3 py-2 text-[13px] font-medium disabled:opacity-60"
            style={{ color: "var(--text-muted)" }}
          >
            {stopping ? "Stopping…" : busy === "ghl_backfill" ? "Stop after this batch" : "Stop after this month"}
          </button>
        )}
        {hasGoogle && (
          <button
            onClick={() => run("google_backfill")}
            disabled={busy !== null}
            className="rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
            style={{
              borderColor: "var(--border-strong)",
              color: "var(--text-secondary)",
            }}
          >
            {busy === "google_backfill"
              ? "Importing…"
              : `Import ${windowLabel(days)} of Google data`}
          </button>
        )}
        {hasTiktok && (
          <button
            onClick={() => run("tiktok_backfill")}
            disabled={busy !== null}
            className="rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
            style={{
              borderColor: "var(--border-strong)",
              color: "var(--text-secondary)",
            }}
          >
            {busy === "tiktok_backfill"
              ? "Importing…"
              : `Import ${windowLabel(days)} of TikTok data`}
          </button>
        )}
        {hasTiktok && (
          <button
            onClick={() => importAdLevel("tiktok_adlevel_backfill")}
            disabled={busy !== null}
            className="rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
            style={{
              borderColor: "var(--border-strong)",
              color: "var(--text-secondary)",
            }}
          >
            {busy === "tiktok_adlevel_backfill"
              ? "Importing TikTok ad-level detail…"
              : "Import TikTok ad-level detail (creative cards)"}
          </button>
        )}
        <button
          onClick={() => importGhl()}
          disabled={busy !== null}
          className="rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
          style={{
            borderColor: "var(--border-strong)",
            color: "var(--text-secondary)",
          }}
        >
          {busy === "ghl_backfill" ? "Importing GoHighLevel history…" : "Import GoHighLevel history"}
        </button>
      </div>

      <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
        GoHighLevel keeps no record of the stages a lead passed through, so the
        import knows when each lead came in, its source and ad, and the stage it
        is in now — not the steps in between. Map your pipeline stages first: a
        lead counts once its pipeline has a stage mapped to New lead. Full
        stage-by-stage history begins from when the webhook went live.
      </p>

      {progress && (
        <p className="mt-3 text-xs" role="status" style={{ color: "var(--text-muted)" }}>
          {progress}
        </p>
      )}
      {msg && <Result ok={msg.ok}>{msg.msg}</Result>}

      <a
        href={`/c/${slug}`}
        className="mt-4 inline-block text-[13px] font-medium hover:underline"
        style={{ color: "var(--accent)" }}
      >
        Go to dashboard →
      </a>
    </Card>
  );
}
