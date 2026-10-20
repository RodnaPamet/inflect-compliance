/**
 * Cadence utility for computing next due dates based on control frequency.
 *
 * ═══ THE ONE PLACE THIS IS DECIDED (#3136) ═══
 *
 * `automation-runner.ts` carried a second `computeNextDueAt` built on a
 * fixed-millisecond table — MONTHLY as 30 days flat, ANNUALLY as 365 — and both
 * wrote `nextDueAt` on the same rows from identical-looking call sites. Two
 * controls on one declared frequency could therefore fall due on different
 * dates depending on which path rolled them. For a compliance product the
 * cadence IS the obligation, so that is a correctness bug and not untidiness.
 *
 * That copy is deleted; this is the only implementation. The fixed-interval
 * TABLE survives in the runner, because its other consumer is a de-duplication
 * lookback window — "has this already run in roughly the last month?" — where a
 * fixed span is the right tool and a calendar boundary would be wrong.
 *
 * ═══ CALENDAR, CLAMPED TO MONTH END ═══
 *
 * Owner decision: "monthly" means the same date next month, and a month that
 * does not have that date clamps to its last day. 31 January + 1 month is 28
 * February (29 in a leap year), not 3 March.
 *
 * `setMonth` alone OVERFLOWS rather than clamping, which is what this used to
 * do: 31 Jan + setMonth(+1) lands on 3 March, so February gets no deadline at
 * all and the date drifts further every month after. The clamp is the whole
 * point of `addMonthsClamped` below — a bare `setMonth` is the bug.
 */

type ControlFrequency = 'AD_HOC' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY';

/**
 * Every cadence this module can advance a date by.
 *
 * WIDER THAN `ControlFrequency`, and deliberately a separate name. Evidence
 * review cycles are the Prisma enum `ReviewCadence`
 * (MONTHLY | QUARTERLY | SEMI_ANNUALLY | ANNUALLY), which has a value controls
 * do not — so folding SEMI_ANNUALLY into `ControlFrequency` would tell every
 * control surface that a control may be semi-annual, which is not true.
 *
 * SEMI_ANNUALLY exists here because it is the reason `task-source-reconcile.ts`
 * kept a flat day table of its own: this module could not express the cadence
 * its rows actually carry, so it computed them elsewhere and drifted (#3802).
 */
export type Cadence = ControlFrequency | 'SEMI_ANNUALLY';

/**
 * `from` advanced by whole months, clamped to the target month's last day.
 *
 * The `setDate(1)` first is load-bearing and not defensive: changing the month
 * while the day-of-month is 31 is exactly what overflows, so the day has to be
 * parked somewhere every month has before the month is moved. Only then is the
 * real day restored, bounded by that month's length.
 *
 * Day 0 of month N+1 is the last day of month N — the standard idiom for
 * "how many days does this month have", and it handles February in leap years
 * without a leap-year rule of its own.
 *
 * Wall-clock, not UTC, deliberately: a deadline is a date a human reads off a
 * calendar, so it should keep its local time-of-day across a DST change rather
 * than shifting an hour to preserve an elapsed-millisecond count.
 */
function addMonthsClamped(from: Date, months: number): Date {
    const dayOfMonth = from.getDate();
    const next = new Date(from);

    next.setDate(1);
    next.setMonth(next.getMonth() + months);

    const lastDayOfTargetMonth = new Date(
        next.getFullYear(),
        next.getMonth() + 1,
        0,
    ).getDate();
    next.setDate(Math.min(dayOfMonth, lastDayOfTargetMonth));

    return next;
}

/**
 * `from` advanced by whole months, clamped, in UTC.
 *
 * ═══ WHY BOTH FLAVOURS LIVE HERE ═══
 *
 * `addMonthsClamped` above is wall-clock, deliberately, because a DUE DATE is a
 * date a human reads off a calendar. But a report SCHEDULE is an instant: the
 * delivery job claims rows where `nextRunAt <= now`, so wall-clock arithmetic
 * moves the stored instant by an hour across a DST boundary — and for a time
 * near midnight that moves the DAY. Measured: a 15 January 00:00Z schedule
 * advanced three months wall-clock lands on 14 April 23:00Z, so a schedule the
 * user set for the 15th becomes claimable on the 14th.
 *
 * So the two exist for two kinds of caller, and neither is a copy of the other's
 * arithmetic: both clamp, and the clamp is the part that must not be duplicated
 * (#3802). A caller that stores a DATE wants `computeNextDueAt`; a caller that
 * stores an INSTANT wants this.
 */
export function addMonthsClampedUtc(from: Date, months: number): Date {
    const dayOfMonth = from.getUTCDate();
    const next = new Date(from);

    // Same ordering as the wall-clock version, and load-bearing for the same
    // reason: park the day somewhere every month has before moving the month,
    // or 31 January + 1 overflows into March instead of clamping to February.
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + months);

    const lastDayOfTargetMonth = new Date(
        Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
    ).getUTCDate();
    next.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));

    return next;
}

/**
 * Compute the next due date based on frequency and a reference date.
 * AD_HOC returns null (no automatic scheduling).
 */
export function computeNextDueAt(frequency: Cadence | string | null | undefined, fromDate: Date = new Date()): Date | null {
    if (!frequency || frequency === 'AD_HOC') return null;

    const next = new Date(fromDate);

    switch (frequency) {
        case 'DAILY':
            next.setDate(next.getDate() + 1);
            break;
        case 'WEEKLY':
            next.setDate(next.getDate() + 7);
            break;
        case 'MONTHLY':
            return addMonthsClamped(next, 1);
        case 'QUARTERLY':
            return addMonthsClamped(next, 3);
        case 'SEMI_ANNUALLY':
            // Six months, clamped, for the same reason ANNUALLY is twelve months
            // rather than `setFullYear(+1)`: 31 August + 6 months is 28 February,
            // not 3 March.
            return addMonthsClamped(next, 6);
        case 'ANNUALLY':
            // Twelve months rather than `setFullYear(+1)`, so 29 February
            // clamps to 28 February instead of silently becoming 1 March.
            return addMonthsClamped(next, 12);
        default:
            return null;
    }

    return next;
}
