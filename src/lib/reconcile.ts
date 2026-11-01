import { lastLocalHourBoundary } from "./dates";

/**
 * When is a client due for its nightly reconciliation?
 *
 * Meta buckets days in the ad account's timezone, so "the day just closed, true
 * it up" is a different instant for every client. Clients are NOT all in one
 * region, so a single global run cannot be right for all of them.
 *
 * The gate is deliberately "has this client been reconciled since its local
 * target hour" rather than the obvious "is it that hour for them right now".
 * The difference matters because the trigger is a free, best-effort scheduler:
 *
 *   - An exact-hour match forces an HOURLY trigger, and a run delayed past the
 *     hour boundary silently skips every client at that offset for the night.
 *     Silent skips are the failure class this whole dashboard exists to remove.
 *   - An overdue check works on ANY cadence, tolerates late or missed runs, and
 *     catches up automatically once the trigger resumes — a multi-day outage
 *     costs nothing beyond latency.
 *
 * It is also idempotent, which is what lets several triggers coexist (a
 * 3-hourly external schedule plus Vercel's once-daily cron as a backstop):
 * whichever fires first does the work, the other finds nothing to do.
 */

/**
 * Local hour at which a client's day is considered closed and reconcilable.
 *
 * 3, not 2: local 2am does not exist on spring-forward day in the US, EU or
 * Australia, so an hour-2 target would skip those clients once a year.
 */
export const DEFAULT_RECONCILE_HOUR = 3;

/**
 * Has this client's local reconcile hour passed without a reconcile since?
 *
 * Takes the timestamp explicitly rather than a client object, because each
 * platform keeps its own marker (`lastMetaReconciledAt` /
 * `lastGoogleReconciledAt`) and the caller must choose. A null timestamp reads
 * as overdue, which is correct: a client that has never been reconciled should
 * be picked up by the very next run.
 */
/** Latest point a cron run should still be working: 20 s inside its 300 s `maxDuration`. */
export const RUN_FINISH_BY_MS = 280_000;

/** Assumed length of a client's run when it has no recent success to go by. */
export const DEFAULT_CLIENT_RUN_MS = 60_000;

/**
 * Can a client still be synced in this run, given how long it usually takes?
 *
 * A client started too late is killed at `maxDuration` with nothing to show:
 * its run is reaped as abandoned, and the whole cron call reads as failed. That
 * was King LASIK, about 95 s, started with 60–95 s left on 30 Oct–1 Nov 2026.
 * A quarter is added for a slow night. The caller always starts a run's first
 * client whatever this says: nothing else could use the time, and refusing it
 * would refuse it every night.
 */
export function fitsBeforeDeadline(
  elapsedMs: number,
  usualMs: number | undefined,
  finishByMs: number = RUN_FINISH_BY_MS,
): boolean {
  return elapsedMs + (usualMs ?? DEFAULT_CLIENT_RUN_MS) * 1.25 <= finishByMs;
}

export function isReconcileOverdue(
  timezone: string,
  lastReconciledAt: Date | null,
  targetHour: number = DEFAULT_RECONCILE_HOUR,
  now: Date = new Date(),
): boolean {
  if (!lastReconciledAt) return true;
  const boundary = lastLocalHourBoundary(targetHour, timezone, now);
  return lastReconciledAt.getTime() < boundary.getTime();
}
