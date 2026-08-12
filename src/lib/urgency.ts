/**
 * Deadline urgency — one threshold set for the whole product.
 *
 * "Due soon" used to mean three different numbers depending on which
 * screen you were looking at:
 *
 *   - the compliance calendar          → ≤7d  ("due_soon")
 *   - the dashboard ExpiryCalendar     → ≤7d urgent, ≤14d upcoming
 *   - the dashboard evidence KPI       → 7d / 30d buckets
 *
 * So the same deadline could be "This Week" on one card, inside the
 * ≤30d bucket on another, and merely "scheduled" on a third. The
 * concept is one concept; it gets one definition.
 *
 * This module is intentionally framework-free — no React, no Prisma —
 * because both halves of the stack consume it: the server classifies
 * calendar events and shapes KPI date-range queries from these numbers,
 * and the client renders tone/labels from them.
 */

/**
 * Day thresholds, in ascending order of distance.
 *
 *   - `URGENT`   — inside a week. Act now.
 *   - `UPCOMING` — inside a month. On the radar, not yet urgent.
 *
 * Anything past `UPCOMING` is "scheduled"; anything before now is
 * "overdue". `UPCOMING` is 30 rather than 14 so it lines up with the
 * dashboard's existing ≤30d evidence bucket and the natural "this
 * month" reading — the 14-day variant on the ExpiryCalendar was the
 * odd one out and had no separate meaning anywhere else.
 */
export const URGENCY_DAYS = {
    URGENT: 7,
    UPCOMING: 30,
} as const;

export const DAY_MS = 86_400_000;

/**
 * Default reminder windows, in days before a deadline, descending.
 *
 * Derived from `URGENCY_DAYS` rather than written out, because the literal
 * `[30, 7, 1]` was duplicated across five job files and the ratchet that
 * claimed "one urgency threshold set" only checked the calendar and the
 * dashboard — the job path was never covered, so the two could drift and the
 * guard would stay green.
 *
 * The trailing `1` is the day-before nudge. It has no urgency tier of its own:
 * anything inside `URGENT` is already urgent, and this is a second reminder at
 * the same tier rather than a third threshold.
 */
export const DEFAULT_REMINDER_WINDOWS: readonly number[] = [
    URGENCY_DAYS.UPCOMING,
    URGENCY_DAYS.URGENT,
    1,
] as const;

/** Millisecond equivalents, for date arithmetic on the server. */
export const URGENCY_MS = {
    URGENT: URGENCY_DAYS.URGENT * DAY_MS,
    UPCOMING: URGENCY_DAYS.UPCOMING * DAY_MS,
} as const;

/**
 * The shared urgency vocabulary. `overdue` is deliberately its own
 * level rather than "very urgent" — a missed deadline is a different
 * kind of fact from an approaching one, and every surface renders it
 * differently.
 */
export type UrgencyLevel = 'overdue' | 'urgent' | 'upcoming' | 'normal';

/**
 * Classify a whole-day distance. `daysUntil` is negative for the past,
 * matching the `daysUntil` the dashboard expiry list already computes.
 */
export function urgencyFromDaysUntil(daysUntil: number): UrgencyLevel {
    if (daysUntil < 0) return 'overdue';
    if (daysUntil <= URGENCY_DAYS.URGENT) return 'urgent';
    if (daysUntil <= URGENCY_DAYS.UPCOMING) return 'upcoming';
    return 'normal';
}

/** Classify a concrete date against a `now` anchor. */
export function urgencyFromDate(date: Date, now: Date): UrgencyLevel {
    const diffMs = date.getTime() - now.getTime();
    if (diffMs < 0) return 'overdue';
    if (diffMs <= URGENCY_MS.URGENT) return 'urgent';
    if (diffMs <= URGENCY_MS.UPCOMING) return 'upcoming';
    return 'normal';
}
