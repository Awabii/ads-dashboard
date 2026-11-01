import { describe, it, expect } from "vitest";
import { isReconcileOverdue, fitsBeforeDeadline } from "./reconcile";
import { lastLocalHourBoundary } from "./dates";

const LA = "America/Los_Angeles";
const KARACHI = "Asia/Karachi"; // UTC+5, no DST
const KOLKATA = "Asia/Kolkata"; // UTC+5:30 — half-hour offset
const SYDNEY = "Australia/Sydney";



/** LA is UTC-7 in summer, so 10:00 UTC = 03:00 local on the same date. */
const AUG_5_LOCAL_10AM = new Date("2026-08-05T17:00:00Z"); // 10:00 LA
const AUG_5_LOCAL_1AM = new Date("2026-08-05T08:00:00Z"); //  01:00 LA

describe("lastLocalHourBoundary", () => {
  it("resolves to today's boundary once local time has passed it", () => {
    // 10:00 local → the most recent 03:00 local was earlier the same day.
    expect(lastLocalHourBoundary(3, LA, AUG_5_LOCAL_10AM).toISOString()).toBe(
      "2026-08-05T10:00:00.000Z",
    );
  });

  it("falls back to yesterday's boundary when local time is before it", () => {
    // 01:00 local on Aug 5 → the most recent 03:00 local was Aug 4.
    expect(lastLocalHourBoundary(3, LA, AUG_5_LOCAL_1AM).toISOString()).toBe(
      "2026-08-04T10:00:00.000Z",
    );
  });

  it("is exactly at the boundary, not after it", () => {
    const at3am = new Date("2026-08-05T10:00:00Z"); // 03:00:00 LA exactly
    expect(lastLocalHourBoundary(3, LA, at3am).toISOString()).toBe(
      "2026-08-05T10:00:00.000Z",
    );
  });

  it("handles a half-hour offset zone, once per local day", () => {
    // Kolkata is UTC+5:30, so 03:00 local = 21:30 UTC the previous day.
    const now = new Date("2026-08-05T06:00:00Z"); // 11:30 local Aug 5
    expect(lastLocalHourBoundary(3, KOLKATA, now).toISOString()).toBe(
      "2026-08-04T21:30:00.000Z",
    );
  });

  it("still resolves a boundary on a spring-forward day at hour 3", () => {
    // US clocks jump 02:00 → 03:00 on 2027-03-14. Hour 3 exists; hour 2 does not.
    const afterJump = new Date("2027-03-14T18:00:00Z"); // 11:00 LA (PDT)
    const boundary = lastLocalHourBoundary(3, LA, afterJump);
    expect(boundary.toISOString()).toBe("2027-03-14T10:00:00.000Z");
    expect(boundary.getTime()).toBeLessThanOrEqual(afterJump.getTime());
  });
});

describe("isReconcileOverdue", () => {
  it("treats a client that has never been reconciled as overdue", () => {
    expect(isReconcileOverdue(LA, null, 3, AUG_5_LOCAL_10AM)).toBe(true);
  });

  it("is not overdue when reconciled after today's boundary", () => {
    const at330 = new Date("2026-08-05T10:30:00Z"); // 03:30 LA
    expect(isReconcileOverdue(LA, at330, 3, AUG_5_LOCAL_10AM)).toBe(false);
  });

  it("is overdue when the last reconcile was before today's boundary", () => {
    const yesterday330 = new Date("2026-08-04T10:30:00Z"); // 03:30 LA, Aug 4
    expect(isReconcileOverdue(LA, yesterday330, 3, AUG_5_LOCAL_10AM)).toBe(
      true,
    );
  });

  it("is NOT overdue before the local boundary, even a full day after the last run", () => {
    // 01:00 local Aug 5. Yesterday's 03:30 reconcile still satisfies the most
    // recent boundary (Aug 4 03:00) — firing again now would be a duplicate.
    const yesterday330 = new Date("2026-08-04T10:30:00Z");
    expect(isReconcileOverdue(LA, yesterday330, 3, AUG_5_LOCAL_1AM)).toBe(
      false,
    );
  });

  it("judges clients in different timezones independently at the same instant", () => {
    // 2026-08-05T17:00Z — 10:00 in LA, 22:00 in Karachi, 03:00 next day in Sydney.
    const lastRun = new Date("2026-08-05T09:00:00Z");
    const now = new Date("2026-08-05T17:00:00Z");
    // LA boundary (Aug 5 03:00 = 10:00Z) is AFTER lastRun → overdue.
    expect(isReconcileOverdue(LA, lastRun, 3, now)).toBe(true);
    // Karachi boundary (Aug 5 03:00 = Aug 4 22:00Z) is BEFORE lastRun → done.
    expect(isReconcileOverdue(KARACHI, lastRun, 3, now)).toBe(false);
  });

  it("becomes overdue again after the next local boundary passes", () => {
    const run = new Date("2026-08-05T10:30:00Z"); // 03:30 LA Aug 5
    const nextDayNoon = new Date("2026-08-06T19:00:00Z"); // 12:00 LA Aug 6
    expect(isReconcileOverdue(LA, run, 3, nextDayNoon)).toBe(true);
  });

  it("works in a southern-hemisphere zone across the date line", () => {
    // 2026-08-05T17:00Z is 03:00 on Aug 6 in Sydney (UTC+10 in August).
    const now = new Date("2026-08-05T17:00:00Z");
    const beforeBoundary = new Date("2026-08-05T16:00:00Z");
    expect(isReconcileOverdue(SYDNEY, beforeBoundary, 3, now)).toBe(true);
    const afterBoundary = new Date("2026-08-05T17:00:00Z");
    expect(isReconcileOverdue(SYDNEY, afterBoundary, 3, now)).toBe(false);
  });

  it("defaults to hour 3 when no target hour is given", () => {
    const at330 = new Date("2026-08-05T10:30:00Z");
    expect(isReconcileOverdue(LA, at330, undefined, AUG_5_LOCAL_10AM)).toBe(
      false,
    );
  });
});

describe("fitsBeforeDeadline", () => {
  it("🔴 refuses a client whose usual run would outlast the function", () => {
    // King LASIK, 1 Nov 2026: about 95 s, started 238 s in, killed at 300 s.
    expect(fitsBeforeDeadline(238_000, 95_000)).toBe(false);
    // The same client earlier in the run finishes in time: 150 + 95 × 1.25 = 268.75 s.
    expect(fitsBeforeDeadline(150_000, 95_000)).toBe(true);
  });

  it("allows a quarter more than usual, for a slow night", () => {
    expect(fitsBeforeDeadline(180_000, 80_000)).toBe(true); // 180 + 100 = 280, just in
    expect(fitsBeforeDeadline(180_001, 80_000)).toBe(false);
  });

  it("assumes a minute for a client with no recent success", () => {
    expect(fitsBeforeDeadline(205_000, undefined)).toBe(true); // 205 + 75 = 280
    expect(fitsBeforeDeadline(206_000, undefined)).toBe(false);
  });
});
