/**
 * Epic 58 — the format-date helpers that had no functional test.
 *
 * `tests/unit/format-date-range.test.ts` covers `formatDateCompact` +
 * `formatDateRange`, and `tests/unit/pdf-date-formatting.test.ts` covers
 * `formatDateTime` / `formatDateTimeLong` / `formatDateShort`. That left
 * FOUR exported helpers with zero functional coverage anywhere in the
 * repo — `formatDateLong`, `formatMonthYear`, `formatMonthShort`,
 * `formatWeekdayShort` — plus the happy path of `formatDate` itself,
 * which is the single most-called date helper in the product.
 *
 * REGRESSION CLASS THIS PROTECTS
 * ──────────────────────────────
 * These five helpers are near-identical three-liners that differ ONLY in
 * which module-level `Intl.DateTimeFormat` constant they reach for. The
 * cheap mistake is wiring the wrong constant (or "tidying" an option
 * away): `formatMonthShort` silently starts emitting "January 2026",
 * `formatDateLong` starts emitting "16 Apr 2026". Nothing type-checks
 * that — every one of them returns `string`.
 *
 * So the assertions below compare against a locally-declared reference
 * formatter carrying the OPTIONS THE DOCBLOCK PROMISES, with locale and
 * timeZone pinned in the reference too. That makes the check independent
 * of the host's ICU build (we never hard-code the glyphs ICU chose)
 * while still failing loudly if the module's option set, locale, or
 * timezone pinning drifts.
 */

import {
    formatDate,
    formatDateLong,
    formatMonthShort,
    formatMonthYear,
    formatWeekdayShort,
} from '@/lib/format-date';

/** The locale + timezone the module docblock commits to. */
const LOCALE = 'en-GB';
const TZ = 'UTC';

/** A Thursday, deliberately mid-month and mid-year. */
const D = new Date('2026-04-16T08:00:00Z');

function ref(options: Intl.DateTimeFormatOptions): string {
    return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: TZ }).format(D);
}

/** The four inputs every helper in this module must funnel to `fallback`. */
const BAD_INPUTS: Array<string | Date | null | undefined> = [
    null,
    undefined,
    '',
    'not-a-date',
];

describe('formatDate — the happy path (day 2-digit / month short / year numeric)', () => {
    it('formats through DATE_FMT, not one of its neighbours', () => {
        expect(formatDate(D)).toBe(
            ref({ day: '2-digit', month: 'short', year: 'numeric' }),
        );
    });

    it('accepts an ISO string and a Date identically', () => {
        expect(formatDate('2026-04-16T08:00:00Z')).toBe(formatDate(D));
    });

    it('is pinned to UTC — 23:59Z and 00:01Z on the same UTC day agree', () => {
        // If `timeZone: 'UTC'` were dropped, a host east or west of UTC
        // would roll one of these onto the neighbouring calendar day.
        expect(formatDate('2026-04-16T23:59:00Z')).toBe(
            formatDate('2026-04-16T00:01:00Z'),
        );
    });

    it.each(BAD_INPUTS)('returns the default em-dash fallback for %p', (bad) => {
        expect(formatDate(bad)).toBe('—');
    });

    it('returns a caller-supplied fallback instead of the em-dash', () => {
        expect(formatDate(null, 'Never')).toBe('Never');
        expect(formatDate('not-a-date', 'Never')).toBe('Never');
    });
});

describe('formatDateLong — "16 April 2026"', () => {
    it('uses the numeric-day / long-month / numeric-year option set', () => {
        expect(formatDateLong(D)).toBe(
            ref({ day: 'numeric', month: 'long', year: 'numeric' }),
        );
    });

    it('is NOT the short-month form — it must differ from formatDate', () => {
        // Guards the copy-paste failure mode: `formatDateLong` reaching
        // for DATE_FMT instead of DATE_LONG_FMT.
        expect(formatDateLong(D)).not.toBe(formatDate(D));
    });

    it('carries the year', () => {
        expect(formatDateLong(D)).toContain('2026');
    });

    it.each(BAD_INPUTS)('returns the default em-dash fallback for %p', (bad) => {
        expect(formatDateLong(bad)).toBe('—');
    });

    it('returns a caller-supplied fallback instead of the em-dash', () => {
        expect(formatDateLong(null, 'n/a')).toBe('n/a');
    });
});

describe('formatMonthYear — "April 2026"', () => {
    it('uses the long-month + numeric-year option set, with no day', () => {
        expect(formatMonthYear(D)).toBe(ref({ month: 'long', year: 'numeric' }));
    });

    it('omits the day-of-month entirely', () => {
        // A calendar month-nav header that renders "16 April 2026" is
        // the bug; assert against the day number this fixture uses.
        expect(formatMonthYear(D)).not.toContain('16');
    });

    it('carries the year', () => {
        expect(formatMonthYear(D)).toContain('2026');
    });

    it.each(BAD_INPUTS)('returns the default em-dash fallback for %p', (bad) => {
        expect(formatMonthYear(bad)).toBe('—');
    });

    it('returns a caller-supplied fallback instead of the em-dash', () => {
        expect(formatMonthYear(undefined, '—/—')).toBe('—/—');
    });
});

describe('formatMonthShort — "Apr"', () => {
    it('uses the short-month option set alone', () => {
        expect(formatMonthShort(D)).toBe(ref({ month: 'short' }));
    });

    it('carries neither the year nor the day (timeline axis ticks)', () => {
        const out = formatMonthShort(D);
        expect(out).not.toContain('2026');
        expect(out).not.toContain('16');
    });

    it('is the abbreviated form, not the long month name', () => {
        expect(formatMonthShort(D)).not.toBe(ref({ month: 'long' }));
    });

    it.each(BAD_INPUTS)('returns the default em-dash fallback for %p', (bad) => {
        expect(formatMonthShort(bad)).toBe('—');
    });

    it('returns a caller-supplied fallback instead of the em-dash', () => {
        expect(formatMonthShort(null, '??')).toBe('??');
    });
});

describe('formatWeekdayShort — "Thu"', () => {
    it('uses the short-weekday option set alone', () => {
        expect(formatWeekdayShort(D)).toBe(ref({ weekday: 'short' }));
    });

    it('carries no calendar-date fields at all', () => {
        const out = formatWeekdayShort(D);
        expect(out).not.toContain('2026');
        expect(out).not.toContain('16');
        expect(out).not.toBe(ref({ month: 'short' }));
    });

    it('tracks the weekday, not a fixed string', () => {
        // 2026-04-16 and 2026-04-17 are different weekdays; a helper
        // that ignored its argument would return the same value.
        expect(formatWeekdayShort('2026-04-17T08:00:00Z')).not.toBe(
            formatWeekdayShort(D),
        );
    });

    it.each(BAD_INPUTS)('returns the default em-dash fallback for %p', (bad) => {
        expect(formatWeekdayShort(bad)).toBe('—');
    });

    it('returns a caller-supplied fallback instead of the em-dash', () => {
        expect(formatWeekdayShort('not-a-date', '·')).toBe('·');
    });
});

describe('the five helpers are genuinely five different formatters', () => {
    it('produces five distinct strings for one instant', () => {
        const outs = [
            formatDate(D),
            formatDateLong(D),
            formatMonthYear(D),
            formatMonthShort(D),
            formatWeekdayShort(D),
        ];
        expect(new Set(outs).size).toBe(5);
    });
});
