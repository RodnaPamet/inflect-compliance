/**
 * format-date.ts — Canonical Date Formatting Utilities (Epic 58)
 *
 * Every date rendered in the UI, emitted from a server route, or
 * written to a PDF MUST go through these helpers. This is the
 * single-source-of-truth date-formatting surface; there is no
 * second canonical module.
 *
 * WHY THIS EXISTS
 * ───────────────
 * React SSR hydration mismatches occur when the server locale differs
 * from the browser locale. For example, a Windows server configured
 * to Bulgarian renders dates as "16.04.2026 г., 11:04:57 ч." while
 * the browser renders "4/16/2026, 11:04:57 AM" — causing a React
 * hydration warning and a flash of incorrect content. Server-side
 * PDFs suffer the same drift across deploy regions.
 *
 * FIX
 * ───
 * Hardcode locale to `en-GB` and timezone to `UTC` on every
 * Intl.DateTimeFormat instance in this file so server and client
 * always produce identical output regardless of OS or browser
 * settings.
 *
 * PICK-A-HELPER DECISION TREE
 * ───────────────────────────
 *   formatDate         → "16 Apr 2026"                       (default — tables, detail chrome, filter pills)
 *   formatDateTime     → "16 Apr 2026, 08:00"                 (activity rows, audit events, modal detail)
 *   formatDateTimeLong → "Thursday, 16 April 2026 at 08:00:45" (PDF metadata, audit receipts — weekday + seconds)
 *   formatDateShort    → "16/04/2026"                         (compact headers, dense tables)
 *   formatDateLong     → "16 April 2026"                      (formal docs, legal-style layouts)
 *   formatDateCompact  → "16 Apr"                             (chart axes, mini-calendars — year is context)
 *   formatDateRange    → adaptive (see the function's docblock) (all range chrome — pickers, filters, legends)
 *   formatRelativeTime → "2 hours ago" / "in 3 days"           (Epic 63 — the underlying helper for <TimestampTooltip>)
 *
 * RELATIVE-TIME RENDERING (Epic 63)
 * ─────────────────────────────────
 * For "X ago" / "in X" cells in lists and tables, do NOT call
 * `formatRelativeTime` from JSX directly. Use
 * `<TimestampTooltip date={…}>` from `@/components/ui/timestamp-tooltip`
 * instead — it pairs the relative phrasing with an exact-timestamp
 * tooltip and is hydration-safe (the component handles the
 * `useHydratedNow()` dance internally). The structural ratchet at
 * `tests/guards/epic63-timestamp-rollout.test.ts` enforces this on
 * the five primary list pages (Evidence, Policies, Tasks, Vendors,
 * Risks).
 *
 * WHAT YOU MUST NOT DO
 * ────────────────────
 *   - Call `.toLocaleDateString()` / `.toLocaleString()` /
 *     `.toLocaleTimeString()` on a Date in app or component code —
 *     the date-display-consistency ratchet catches this in CI.
 *   - Use `new Date(…).toISOString().split('T')[0]` for YMD — that's
 *     a timezone foot-gun. Use `toYMD(date)` from
 *     `@/components/ui/date-picker/date-utils` instead.
 *   - Build a range string with a literal ` - ` or ` – ` separator —
 *     call `formatDateRange(from, to)` so endpoints adapt to same-
 *     month / same-year / different-years semantics.
 *   - Add a SECOND canonical formatter module. If a new variant is
 *     genuinely needed, extend this file — don't stand up a parallel
 *     surface. The dub-utils-era helpers `formatDateSmart`,
 *     `formatDateTimeSmart`, `timeAgo`, `formatPeriod`, `parseDateTime`,
 *     `getDateTimeLocal`, `getDaysDifference`, `getFirstAndLastDay`
 *     were removed on 2026-04-22; don't resurrect them.
 *
 * USAGE
 * ─────
 *   import {
 *     formatDate,
 *     formatDateTime,
 *     formatDateTimeLong,
 *     formatDateShort,
 *     formatDateLong,
 *     formatDateCompact,
 *     formatDateRange,
 *   } from '@/lib/format-date';
 *
 *   formatDate('2026-04-16T08:00:00Z')     // → "16 Apr 2026"
 *   formatDateTime('2026-04-16T08:00:00Z') // → "16 Apr 2026, 08:00"
 *   formatDateShort('2026-04-16T08:00:00Z') // → "16/04/2026"
 */

const LOCALE = 'en-GB';

/** Shared Intl.DateTimeFormat instances (created once, reused — fast). */
const DATE_FMT = new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
});

const DATETIME_FMT = new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
});

const DATE_SHORT_FMT = new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
});

const DATE_LONG_FMT = new Intl.DateTimeFormat(LOCALE, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
});

// Standalone month / weekday names — the shared, SSR-safe replacement for
// hand-rolled `MONTH_NAMES` / `WEEKDAY_NAMES` arrays scattered across the
// calendar views. Same en-GB/UTC pinning as every other formatter here.
const MONTH_YEAR_FMT = new Intl.DateTimeFormat(LOCALE, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
});

const MONTH_SHORT_FMT = new Intl.DateTimeFormat(LOCALE, {
    month: 'short',
    timeZone: 'UTC',
});

const WEEKDAY_SHORT_FMT = new Intl.DateTimeFormat(LOCALE, {
    weekday: 'short',
    timeZone: 'UTC',
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDate(value: string | Date | null | undefined): Date | null {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return isNaN(d.getTime()) ? null : d;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Format a date as "16 Apr 2026".
 * Returns the fallback string (default `'—'`) for null/invalid inputs.
 */
export function formatDate(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? DATE_FMT.format(d) : fallback;
}

/**
 * Format a date + time as "16 Apr 2026, 08:00".
 * Returns the fallback string (default `'—'`) for null/invalid inputs.
 */
export function formatDateTime(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? DATETIME_FMT.format(d) : fallback;
}

// Richer form for audit-quality timestamps (PDF metadata page,
// evidence-pack receipts): weekday + long month + seconds so the
// exact moment is preserved for downstream forensics. Locked to the
// same `en-GB` + `UTC` calendar as every other helper here so server
// and client produce identical strings regardless of host timezone.
const DATETIME_LONG_FMT = new Intl.DateTimeFormat(LOCALE, {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
});

/**
 * Format a date + time in long, audit-quality form —
 * "Thursday, 16 April 2026, 08:00:45". Use for PDF metadata pages,
 * evidence receipts, or any surface where the exact moment is
 * legally / operationally load-bearing. Returns the fallback string
 * (default `'—'`) for null/invalid inputs.
 */
export function formatDateTimeLong(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? DATETIME_LONG_FMT.format(d) : fallback;
}

// ─── Relative time (Epic 63) ─────────────────────────────────────────────────
//
// Centralised so every "2 hours ago" / "in 3 days" string in the UI
// goes through one helper. Wraps date-fns's `formatDistance` rather
// than `formatDistanceToNow` so the caller can pin "now" — this is
// what makes `<TimestampTooltip>` hydration-safe (the component
// passes the `useHydratedNow()` value as `now`).
//
// Both past and future dates supported via `addSuffix: true` —
// past becomes "X ago", future becomes "in X".
//
// Returns the fallback string (default `'—'`) when EITHER `value`
// or `now` is null / invalid; the visible text on a card with a
// missing date should not flash "less than a minute ago".

import { formatDistance } from 'date-fns';

export interface FormatRelativeTimeOptions {
    /** Show "less than a minute ago" instead of "less than a minute". Defaults to true. */
    addSuffix?: boolean;
    /** Round to seconds for sub-minute deltas. Defaults to true. */
    includeSeconds?: boolean;
}

export function formatRelativeTime(
    value: string | Date | null | undefined,
    now: Date | null | undefined,
    options: FormatRelativeTimeOptions = {},
    fallback = '—',
): string {
    const d = toDate(value);
    if (!d || !now) return fallback;
    return formatDistance(d, now, {
        addSuffix: options.addSuffix ?? true,
        includeSeconds: options.includeSeconds ?? true,
    });
}

/**
 * Format a date as "16/04/2026".
 * Returns the fallback string (default `'—'`) for null/invalid inputs.
 */
export function formatDateShort(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? DATE_SHORT_FMT.format(d) : fallback;
}

/**
 * Format a date as "16 April 2026".
 * Returns the fallback string (default `'—'`) for null/invalid inputs.
 */
export function formatDateLong(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? DATE_LONG_FMT.format(d) : fallback;
}

// ─── Compact + range formatters (Epic 58) ────────────────────────────────────

const DATE_COMPACT_FMT = new Intl.DateTimeFormat(LOCALE, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
});

const MONTH_FMT = new Intl.DateTimeFormat(LOCALE, {
    month: 'short',
    timeZone: 'UTC',
});

/**
 * Compact day + month, no year — "16 Apr". Use for chart axes,
 * mini-calendars, and anywhere the calendar context already implies
 * the year. Returns the fallback (default `'—'`) for nullish input.
 */
export function formatDateCompact(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? DATE_COMPACT_FMT.format(d) : fallback;
}

/** Month + year, e.g. "January 2026" — calendar month-nav headers. */
export function formatMonthYear(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? MONTH_YEAR_FMT.format(d) : fallback;
}

/** Short month name, e.g. "Jan" — timeline axis ticks. */
export function formatMonthShort(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? MONTH_SHORT_FMT.format(d) : fallback;
}

/** Short weekday name, e.g. "Mon" — month-grid + heatmap column headers. */
export function formatWeekdayShort(
    value: string | Date | null | undefined,
    fallback = '—',
): string {
    const d = toDate(value);
    return d ? WEEKDAY_SHORT_FMT.format(d) : fallback;
}

/**
 * Canonical date-range formatter. Adapts to the kind of range:
 *
 *   { from: 16 Apr, to: 16 Apr }       →  "16 Apr 2026"           (single day)
 *   { from: 16 Apr, to: 30 Apr }       →  "16 – 30 Apr 2026"      (same month)
 *   { from: 16 Apr, to: 30 Jun }       →  "16 Apr – 30 Jun 2026"  (same year)
 *   { from: 16 Apr 2025, to: 30 Jun }  →  "16 Apr 2025 – 30 Jun 2026"
 *   { from: 16 Apr, to: null }          →  "From 16 Apr 2026"
 *   { from: null, to: 30 Apr }          →  "Until 30 Apr 2026"
 *   { from: null, to: null }            →  fallback (default '—')
 *
 * The em-dash (U+2013) separator and the UTC calendar fields match the
 * rest of the date helpers. Use everywhere a range is surfaced in chrome
 * — picker triggers, filter pills, audit-cycle detail, reports legends.
 */
export function formatDateRange(
    from: string | Date | null | undefined,
    to: string | Date | null | undefined,
    fallback = '—',
): string {
    const fromD = toDate(from);
    const toD = toDate(to);

    if (!fromD && !toD) return fallback;
    if (fromD && !toD) return `From ${DATE_FMT.format(fromD)}`;
    if (!fromD && toD) return `Until ${DATE_FMT.format(toD)}`;

    // TS narrowing — both non-null here.
    const a = fromD as Date;
    const b = toD as Date;

    const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
    const sameMonth = sameYear && a.getUTCMonth() === b.getUTCMonth();
    const sameDay = sameMonth && a.getUTCDate() === b.getUTCDate();

    if (sameDay) return DATE_FMT.format(a);

    if (sameMonth) {
        // "16 – 30 Apr 2026"
        return `${a.getUTCDate()} – ${DATE_FMT.format(b)}`;
    }

    if (sameYear) {
        // "16 Apr – 30 Jun 2026": drop the year on the left endpoint.
        const leftNoYear = `${a.getUTCDate()} ${MONTH_FMT.format(a)}`;
        return `${leftNoYear} – ${DATE_FMT.format(b)}`;
    }

    // Different years — both endpoints carry their year.
    return `${DATE_FMT.format(a)} – ${DATE_FMT.format(b)}`;
}
