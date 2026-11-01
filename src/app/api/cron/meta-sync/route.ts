import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import {
  syncClientMetrics,
  reapAbandonedSyncRuns,
  usualMetaRunMs,
  RECONCILE_DAYS,
} from "@/lib/meta/sync";
import { activeAdAccounts } from "@/lib/meta/accounts";
import { trailingWindowInclusive } from "@/lib/dates";
import {
  isReconcileOverdue,
  fitsBeforeDeadline,
  DEFAULT_RECONCILE_HOUR,
} from "@/lib/reconcile";
import { safeEqual } from "@/lib/crypto";

/**
 * Nightly reconciliation.
 *
 * Re-pulls a trailing window and upserts, which is what keeps the dashboard in
 * agreement with Ads Manager as Meta restates spend and conversions over the
 * following weeks.
 *
 * Safe to call at ANY cadence. Each client is picked up only once its local
 * reconcile hour has passed without a reconcile since (see `@/lib/reconcile`),
 * so this is idempotent and several triggers can coexist: a frequent external
 * schedule for timeliness, plus Vercel's once-daily cron as a backstop. Whichever
 * fires first does the work; the other finds nothing to do.
 *
 * Query params:
 *   ?force=1  — ignore the overdue gate and reconcile every active client.
 *   ?hour=N   — override the local reconcile hour (default 3).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Stop dispatching new clients past this point, leaving headroom to return a
 * response. Clients not reached stay overdue and are picked up by the next run —
 * an explicit, self-correcting deferral rather than a silent mid-loop
 * truncation at `maxDuration`.
 */
const DISPATCH_BUDGET_MS = 240_000;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  const secret = process.env.CRON_SECRET;

  // Vercel Cron sends the CRON_SECRET as a bearer token.
  if (!secret || !safeEqual(bearer, secret)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const startedAt = Date.now();
  const force = req.nextUrl.searchParams.get("force") === "1";
  // `?? NaN` matters: Number(null) is 0, and 0 is a valid hour, so an ABSENT
  // param would silently override the default with midnight.
  const hourRaw = req.nextUrl.searchParams.get("hour");
  const hourParam = Number(hourRaw ?? NaN);
  const targetHour =
    Number.isInteger(hourParam) && hourParam >= 0 && hourParam <= 23
      ? hourParam
      : DEFAULT_RECONCILE_HOUR;

  // Clear rows left behind by a previously killed run, so "running" always means
  // running and the health checklist stays honest.
  const reaped = await reapAbandonedSyncRuns();

  // Longest-waiting first, so a client deferred or killed last run leads this one.
  const active = await db
    .select()
    .from(clients)
    .where(eq(clients.status, "active"))
    .orderBy(sql`${clients.lastMetaReconciledAt} ASC NULLS FIRST`);
  const usualMs = await usualMetaRunMs();

  const results: Array<{
    slug: string;
    status: "synced" | "skipped" | "deferred" | "failed";
    rows?: number;
    error?: string;
  }> = [];

  let started = 0;
  for (const client of active) {
    const accounts = await activeAdAccounts(client.id);
    if (accounts.length === 0) {
      results.push({ slug: client.slug, status: "skipped" });
      continue;
    }
    if (
      !force &&
      !isReconcileOverdue(
        client.timezone,
        client.lastMetaReconciledAt,
        targetHour,
      )
    ) {
      results.push({ slug: client.slug, status: "skipped" });
      continue;
    }

    const elapsed = Date.now() - startedAt;
    if (
      elapsed > DISPATCH_BUDGET_MS ||
      (started > 0 && !fitsBeforeDeadline(elapsed, usualMs.get(client.id)))
    ) {
      // Out of time for this one. Say so rather than appearing to have covered
      // everyone; a smaller client further down may still fit.
      results.push({ slug: client.slug, status: "deferred" });
      continue;
    }
    started++;

    try {
      const window = trailingWindowInclusive(RECONCILE_DAYS, client.timezone);
      const { rowsWritten } = await syncClientMetrics(client, {
        since: window.startKey,
        until: window.endKey,
        includeReach: true,
        isReconcile: true,
        // Creative reporting and audience breakdowns ride the nightly
        // reconciliation, not the intraday refresh: together they are a second
        // insights pass, an ads listing and five segmented queries, and the
        // on-load path has to stay cheap enough to fire on every page view.
        includeAdLevel: true,
        includeBreakdowns: true,
      });
      results.push({ slug: client.slug, status: "synced", rows: rowsWritten });
    } catch (err) {
      // One client's bad token must not abort the whole run.
      results.push({
        slug: client.slug,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const deferred = results.filter((r) => r.status === "deferred").length;
  return NextResponse.json({
    ok: true,
    targetHour,
    reaped,
    deferred,
    elapsedMs: Date.now() - startedAt,
    results,
  });
}
