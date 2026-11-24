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
 * Every helper renders in the UTC calendar and in ONE of the app's
 * locales — never the host's. The locale is the reader's UI language,
 * not the machine's, and it is chosen in one of two ways:
 *
 *   • Explicitly — `dateFormattersFor(locale)` returns the helpers bound
 *     to that locale. Server components use this (through
 *     `getDateFormatters()` in `src/lib/i18n/date-format-server.ts`), as
 *     does anything that formats outside a React render.
 *   • Implicitly — the bare exports below (`formatDate`, …) read the
 *     ACTIVE locale, which `bindDateLocale()` sets once per render from
 *     next-intl's `useLocale()` (the app's root `<Providers>` does it).
 *     In the browser that is a module value: a tab has one locale. On
 *     the server it is recorded against THIS request's render scope (see
 *     `date-locale-scope.ts`), so two concurrent requests in different
 *     languages cannot see each other's locale. Outside any binding
 *     (jobs, API routes, PDFs, tests) the active locale is English.
 *
 * English keeps the `en-GB` Intl output it always had. Bulgarian is
 * TABLE-DRIVEN rather than `Intl.DateTimeFormat('bg')`: Intl's `bg`
 * output depends on the ICU/CLDR build (Node and each browser ship
 * their own), and a server and a browser that disagree by one "г."
 * is a hydration mismatch. A table renders the same bytes everywhere.
 *
 * PICK-A-HELPER DECISION TREE
 * ───────────────────────────
 *   formatDate         → "16 Apr 2026"                       (default — tables, detail chrome, filter pills)
 *   formatDateTime     → "16 Apr 2026, 08:00"                 (activity rows, event logs, modal detail)
 *   formatDateTimeLong → "Thursday, 16 April 2026 at 08:00:45" (PDF metadata, receipts — weekday + seconds)
 *   formatDateShort    → "16/04/2026"                         (compact headers, dense tables)
 *   formatDateLong     → "16 April 2026"                      (formal docs, legal-style layouts)
 *   formatDateCompact  → "16 Apr"                             (chart axes, mini-calendars — year is context)
 *   formatDateRange    → adaptive (see the function's docblock) (all range chrome — pickers, filters, legends)
 *   formatRelativeTime → "2 hours ago" / "in 3 days"           (Epic 63 — the underlying helper for <TimestampTooltip>)
 *
 * In Bulgarian the same helpers read "16 апр 2026", "16 апр 2026, 08:00",
 * "16.04.2026", "16 април 2026 г." and "преди 2 часа".
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
 * the five primary list pages.
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
 *     surface. The older vendored helpers `formatDateSmart`,
 *     `formatDateTimeSmart`, `timeAgo`, `formatPeriod`, `parseDateTime`,
 *     `getDateTimeLocal`, `getDaysDifference`, `getFirstAndLastDay`
 *     were removed on 2026-04-22; don't resurrect them.
 *   - Call date-fns `format*` / `formatDistance*` without a locale, or
 *     build an `Intl.DateTimeFormat` with a hard-coded language for text a
 *     person reads: the reader's language is the active locale.
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
 *   } from '<the ui package>/lib/format-date';
 *
 *   formatDate('2026-04-16T08:00:00Z')     // → "16 Apr 2026"
 *   formatDateTime('2026-04-16T08:00:00Z') // → "16 Apr 2026, 08:00"
 *   formatDateShort('2026-04-16T08:00:00Z') // → "16/04/2026"
 */

import { formatDistance, type Locale as DateFnsLocale } from 'date-fns';
import { bg as dateFnsBg, enUS as dateFnsEnUS } from 'date-fns/locale';

import type * as DateLocaleScope from './date-locale-scope';

export type { DateLocaleRenderScope } from './date-locale-scope';

/**
 * The server half of the active locale (`date-locale-scope.ts`). Required
 * only where `window` is undefined: Next defines `typeof window` for the
 * browser build, so webpack drops this branch, and the module with it, at
 * parse time. See that module for why it must stay out of the browser graph.
 */
const serverScope: typeof DateLocaleScope | null =
    typeof window === 'undefined'
        ? (require('./date-locale-scope') as typeof DateLocaleScope)
        : null;

// ─── Locales ─────────────────────────────────────────────────────────────────

/** The UI languages a date can be written in. Mirrors the app's message catalogs. */
export type DateLocale = 'en' | 'bg';

/** Any locale tag (`'bg'`, `'bg-BG'`, `'en'`, junk) → a supported date locale. */
export function resolveDateLocale(value: string | null | undefined): DateLocale {
    return typeof value === 'string' && value.trim().toLowerCase().startsWith('bg') ? 'bg' : 'en';
}

const IS_BROWSER = typeof window !== 'undefined';

/**
 * Tell the server which request is rendering, so the root's binding holds
 * wherever React resumes that render. See `date-locale-scope.ts`.
 */
export function setDateLocaleRenderScope(getScope: DateLocaleScope.DateLocaleRenderScope | null): void {
    serverScope?.setDateLocaleRenderScope(getScope);
}

let browserLocale: DateLocale = 'en';

/**
 * Make `locale` the active date locale for the current render.
 *
 * Called once per render, at the root, before anything that formats a date
 * renders (`useBindDateLocale()` in the app's `<Providers>`). Idempotent.
 * The server half lives in `date-locale-scope.ts`.
 */
export function bindDateLocale(locale: string | null | undefined): void {
    const resolved = resolveDateLocale(locale);
    if (IS_BROWSER) {
        browserLocale = resolved;
        return;
    }
    serverScope?.bindServerDateLocale(resolved);
}

/** The locale the bare helpers render in right now. */
export function activeDateLocale(): DateLocale {
    return IS_BROWSER ? browserLocale : (serverScope?.serverDateLocale() ?? 'en');
}

/** The date-fns locale for a UI locale (react-day-picker, relative time). */
export function dateFnsLocaleFor(locale: string | null | undefined): DateFnsLocale {
    return resolveDateLocale(locale) === 'bg' ? dateFnsBg : dateFnsEnUS;
}

/** The date-fns locale for the active UI locale. */
export function activeDateFnsLocale(): DateFnsLocale {
    return dateFnsLocaleFor(activeDateLocale());
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type DateInput = string | Date | null | undefined;

function toDate(value: DateInput): Date | null {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return isNaN(d.getTime()) ? null : d;
}

export interface FormatRelativeTimeOptions {
    /** Show "less than a minute ago" instead of "less than a minute". Defaults to true. */
    addSuffix?: boolean;
    /** Round to seconds for sub-minute deltas. Defaults to true. */
    includeSeconds?: boolean;
}

/** Every helper, bound to one locale. See the decision tree above. */
export interface DateFormatters {
    readonly locale: DateLocale;
    formatDate(value: DateInput, fallback?: string): string;
    formatDateTime(value: DateInput, fallback?: string): string;
    formatDateTimeLong(value: DateInput, fallback?: string): string;
    formatDateShort(value: DateInput, fallback?: string): string;
    formatDateLong(value: DateInput, fallback?: string): string;
    formatDateCompact(value: DateInput, fallback?: string): string;
    formatMonthYear(value: DateInput, fallback?: string): string;
    formatMonthShort(value: DateInput, fallback?: string): string;
    formatWeekdayShort(value: DateInput, fallback?: string): string;
    formatDateRange(from: DateInput, to: DateInput, fallback?: string): string;
    formatRelativeTime(
        value: DateInput,
        now: Date | null | undefined,
        options?: FormatRelativeTimeOptions,
        fallback?: string,
    ): string;
}

/**
 * The calendar pieces a locale's formatters are assembled from. Each takes a
 * Date that has already been validated, and reads only its UTC fields.
 */
interface CalendarParts {
    date(d: Date): string;
    dateTime(d: Date): string;
    dateTimeLong(d: Date): string;
    dateShort(d: Date): string;
    dateLong(d: Date): string;
    dateCompact(d: Date): string;
    monthYear(d: Date): string;
    monthShort(d: Date): string;
    weekdayShort(d: Date): string;
    /** "From X" / "Until X" for an open-ended range. */
    rangeFrom(formatted: string): string;
    rangeUntil(formatted: string): string;
    relativeLocale: DateFnsLocale | undefined;
}

// ─── English (en-GB, through Intl) ───────────────────────────────────────────

const EN_TAG = 'en-GB';

const intl = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(EN_TAG, { ...options, timeZone: 'UTC' });

const EN_DATE = intl({ day: '2-digit', month: 'short', year: 'numeric' });
const EN_DATETIME = intl({ day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
// Richer form for record-quality timestamps (PDF metadata page, export
// receipts): weekday + long month + seconds so the exact moment is preserved
// for downstream forensics.
const EN_DATETIME_LONG = intl({
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
});
const EN_DATE_SHORT = intl({ day: '2-digit', month: '2-digit', year: 'numeric' });
const EN_DATE_LONG = intl({ day: 'numeric', month: 'long', year: 'numeric' });
const EN_DATE_COMPACT = intl({ day: 'numeric', month: 'short' });
// Standalone month / weekday names — the shared, SSR-safe replacement for
// hand-rolled `MONTH_NAMES` / `WEEKDAY_NAMES` arrays scattered across the
// calendar views.
const EN_MONTH_YEAR = intl({ month: 'long', year: 'numeric' });
const EN_MONTH_SHORT = intl({ month: 'short' });
const EN_WEEKDAY_SHORT = intl({ weekday: 'short' });

const EN_PARTS: CalendarParts = {
    date: (d) => EN_DATE.format(d),
    dateTime: (d) => EN_DATETIME.format(d),
    dateTimeLong: (d) => EN_DATETIME_LONG.format(d),
    dateShort: (d) => EN_DATE_SHORT.format(d),
    dateLong: (d) => EN_DATE_LONG.format(d),
    dateCompact: (d) => EN_DATE_COMPACT.format(d),
    monthYear: (d) => EN_MONTH_YEAR.format(d),
    monthShort: (d) => EN_MONTH_SHORT.format(d),
    weekdayShort: (d) => EN_WEEKDAY_SHORT.format(d),
    rangeFrom: (s) => `From ${s}`,
    rangeUntil: (s) => `Until ${s}`,
    // date-fns' default IS English; passing none keeps the strings it always gave.
    relativeLocale: undefined,
};

// ─── Bulgarian (table-driven — see FIX above) ────────────────────────────────

const BG_MONTHS_LONG = [
    'януари', 'февруари', 'март', 'април', 'май', 'юни',
    'юли', 'август', 'септември', 'октомври', 'ноември', 'декември',
] as const;
const BG_MONTHS_SHORT = [
    'яну', 'фев', 'мар', 'апр', 'май', 'юни',
    'юли', 'авг', 'сеп', 'окт', 'ное', 'дек',
] as const;
/** Indexed by `getUTCDay()` — Sunday first. */
const BG_WEEKDAYS_LONG = [
    'неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота',
] as const;
const BG_WEEKDAYS_SHORT = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const;

const pad2 = (n: number) => String(n).padStart(2, '0');
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const hhmm = (d: Date) => `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
const bgDate = (d: Date) =>
    `${pad2(d.getUTCDate())} ${BG_MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const bgDateLong = (d: Date) =>
    `${d.getUTCDate()} ${BG_MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()} г.`;

const BG_PARTS: CalendarParts = {
    date: bgDate,
    dateTime: (d) => `${bgDate(d)}, ${hhmm(d)}`,
    dateTimeLong: (d) =>
        `${BG_WEEKDAYS_LONG[d.getUTCDay()]}, ${pad2(d.getUTCDate())} ${BG_MONTHS_LONG[d.getUTCMonth()]} ` +
        `${d.getUTCFullYear()} г., ${hhmm(d)}:${pad2(d.getUTCSeconds())}`,
    dateShort: (d) => `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`,
    dateLong: bgDateLong,
    dateCompact: (d) => `${d.getUTCDate()} ${BG_MONTHS_SHORT[d.getUTCMonth()]}`,
    monthYear: (d) => `${capitalise(BG_MONTHS_LONG[d.getUTCMonth()] ?? '')} ${d.getUTCFullYear()} г.`,
    monthShort: (d) => BG_MONTHS_SHORT[d.getUTCMonth()] ?? '',
    weekdayShort: (d) => BG_WEEKDAYS_SHORT[d.getUTCDay()] ?? '',
    rangeFrom: (s) => `От ${s}`,
    rangeUntil: (s) => `До ${s}`,
    relativeLocale: dateFnsBg,
};

// ─── Assembly ────────────────────────────────────────────────────────────────

function buildFormatters(locale: DateLocale, parts: CalendarParts): DateFormatters {
    const single =
        (render: (d: Date) => string) =>
        (value: DateInput, fallback = '—'): string => {
            const d = toDate(value);
            return d ? render(d) : fallback;
        };

    return {
        locale,
        formatDate: single(parts.date),
        formatDateTime: single(parts.dateTime),
        formatDateTimeLong: single(parts.dateTimeLong),
        formatDateShort: single(parts.dateShort),
        formatDateLong: single(parts.dateLong),
        formatDateCompact: single(parts.dateCompact),
        formatMonthYear: single(parts.monthYear),
        formatMonthShort: single(parts.monthShort),
        formatWeekdayShort: single(parts.weekdayShort),

        formatDateRange(from, to, fallback = '—') {
            const fromD = toDate(from);
            const toD = toDate(to);

            if (!fromD && !toD) return fallback;
            if (fromD && !toD) return parts.rangeFrom(parts.date(fromD));
            if (!fromD && toD) return parts.rangeUntil(parts.date(toD));

            // TS narrowing — both non-null here.
            const a = fromD as Date;
            const b = toD as Date;

            const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
            const sameMonth = sameYear && a.getUTCMonth() === b.getUTCMonth();
            const sameDay = sameMonth && a.getUTCDate() === b.getUTCDate();

            if (sameDay) return parts.date(a);
            // "16 – 30 Apr 2026"
            if (sameMonth) return `${a.getUTCDate()} – ${parts.date(b)}`;
            // "16 Apr – 30 Jun 2026": drop the year on the left endpoint.
            if (sameYear) return `${a.getUTCDate()} ${parts.monthShort(a)} – ${parts.date(b)}`;
            // Different years — both endpoints carry their year.
            return `${parts.date(a)} – ${parts.date(b)}`;
        },

        // Wraps date-fns's `formatDistance` rather than `formatDistanceToNow`
        // so the caller can pin "now" — this is what makes `<TimestampTooltip>`
        // hydration-safe (the component passes the `useHydratedNow()` value as
        // `now`). Returns the fallback when EITHER `value` or `now` is null /
        // invalid: a card with a missing date should not flash "less than a
        // minute ago".
        formatRelativeTime(value, now, options = {}, fallback = '—') {
            const d = toDate(value);
            if (!d || !now) return fallback;
            return formatDistance(d, now, {
                addSuffix: options.addSuffix ?? true,
                includeSeconds: options.includeSeconds ?? true,
                ...(parts.relativeLocale ? { locale: parts.relativeLocale } : {}),
            });
        },
    };
}

const FORMATTERS: Readonly<Record<DateLocale, DateFormatters>> = {
    en: buildFormatters('en', EN_PARTS),
    bg: buildFormatters('bg', BG_PARTS),
};

/** The helpers bound to an explicit locale — server components, jobs, exports. */
export function dateFormattersFor(locale: string | null | undefined): DateFormatters {
    return FORMATTERS[resolveDateLocale(locale)];
}

const active = (): DateFormatters => FORMATTERS[activeDateLocale()];

// ─── Public API (active locale) ──────────────────────────────────────────────

/**
 * Format a date as "16 Apr 2026".
 * Returns the fallback string (default `'—'`) for null/invalid inputs.
 */
export function formatDate(value: DateInput, fallback = '—'): string {
    return active().formatDate(value, fallback);
}

/**
 * Format a date + time as "16 Apr 2026, 08:00".
 * Returns the fallback string (default `'—'`) for null/invalid inputs.
 */
export function formatDateTime(value: DateInput, fallback = '—'): string {
    return active().formatDateTime(value, fallback);
}

/**
 * Format a date + time in long, record-quality form —
 * "Thursday, 16 April 2026, 08:00:45". Use for PDF metadata pages,
 * export receipts, or any surface where the exact moment is
 * legally / operationally load-bearing. Returns the fallback string
 * (default `'—'`) for null/invalid inputs.
 */
export function formatDateTimeLong(value: DateInput, fallback = '—'): string {
    return active().formatDateTimeLong(value, fallback);
}

/**
 * "2 hours ago" / "in 3 days" (Epic 63). Both past and future dates
 * supported via `addSuffix: true`. Returns the fallback string
 * (default `'—'`) when EITHER `value` or `now` is null / invalid.
 */
export function formatRelativeTime(
    value: DateInput,
    now: Date | null | undefined,
    options: FormatRelativeTimeOptions = {},
    fallback = '—',
): string {
    return active().formatRelativeTime(value, now, options, fallback);
}

/**
 * Format a date as "16/04/2026".
 * Returns the fallback string (default `'—'`) for null/invalid inputs.
 */
export function formatDateShort(value: DateInput, fallback = '—'): string {
    return active().formatDateShort(value, fallback);
}

/**
 * Format a date as "16 April 2026".
 * Returns the fallback string (default `'—'`) for null/invalid inputs.
 */
export function formatDateLong(value: DateInput, fallback = '—'): string {
    return active().formatDateLong(value, fallback);
}

/**
 * Compact day + month, no year — "16 Apr". Use for chart axes,
 * mini-calendars, and anywhere the calendar context already implies
 * the year. Returns the fallback (default `'—'`) for nullish input.
 */
export function formatDateCompact(value: DateInput, fallback = '—'): string {
    return active().formatDateCompact(value, fallback);
}

/** Month + year, e.g. "January 2026" — calendar month-nav headers. */
export function formatMonthYear(value: DateInput, fallback = '—'): string {
    return active().formatMonthYear(value, fallback);
}

/** Short month name, e.g. "Jan" — timeline axis ticks. */
export function formatMonthShort(value: DateInput, fallback = '—'): string {
    return active().formatMonthShort(value, fallback);
}

/** Short weekday name, e.g. "Mon" — month-grid + heatmap column headers. */
export function formatWeekdayShort(value: DateInput, fallback = '—'): string {
    return active().formatWeekdayShort(value, fallback);
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
 * — picker triggers, filter pills, period headers, reports legends.
 */
export function formatDateRange(from: DateInput, to: DateInput, fallback = '—'): string {
    return active().formatDateRange(from, to, fallback);
}
