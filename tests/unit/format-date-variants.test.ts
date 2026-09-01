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

import * as fs from 'node:fs';
import * as path from 'node:path';

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

/**
 * ONE bad input per helper, deliberately — not a matrix.
 *
 * Each helper's own `d ? FMT.format(d) : fallback` is the branch that
 * needs a per-helper hit, and `null` reaches it. The two arms of the
 * SHARED `toDate` are `!value` (null / undefined / '' — one arm, three
 * spellings) and `isNaN` ('not-a-date'), and both are hit once below by
 * `formatDate`'s caller-supplied-fallback case. An `it.each` over four
 * inputs x five helpers bought 20 test names for those same branches.
 */
describe('formatDate — the happy path (day 2-digit / month short / year numeric)', () => {
    it('formats through DATE_FMT, not one of its neighbours', () => {
        expect(formatDate(D)).toBe(
            ref({ day: '2-digit', month: 'short', year: 'numeric' }),
        );
    });

    it('accepts an ISO string and a Date identically', () => {
        expect(formatDate('2026-04-16T08:00:00Z')).toBe(formatDate(D));
    });

    it('returns the default em-dash fallback for an absent value', () => {
        expect(formatDate(null)).toBe('—');
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

    it('returns the default em-dash fallback for an absent value', () => {
        expect(formatDateLong(null)).toBe('—');
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

    it('returns the default em-dash fallback for an absent value', () => {
        expect(formatMonthYear(null)).toBe('—');
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

    it('returns the default em-dash fallback for an absent value', () => {
        expect(formatMonthShort(null)).toBe('—');
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

    it('returns the default em-dash fallback for an absent value', () => {
        expect(formatWeekdayShort(null)).toBe('—');
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

// ─── The UTC pin — the module's entire stated reason for existing ──────

describe('every Intl.DateTimeFormat in format-date.ts is pinned to en-GB + UTC', () => {
    /**
     * WHY THIS IS A SOURCE READ AND NOT A BEHAVIOURAL ASSERTION
     * ─────────────────────────────────────────────────────────
     * The obvious test — "23:59Z and 00:01Z on the same UTC day format
     * identically" — is INERT on a UTC host, and GitHub runners are UTC.
     * Dropping `timeZone: 'UTC'` from `DATE_FMT` fails it under
     * Europe/Sofia and passes the whole file under `TZ=UTC`, so on CI it
     * asserts nothing. Setting `process.env.TZ` inside the suite does not
     * rescue it either: Node caches the default zone, so a
     * `jest.resetModules()` + dynamic re-import passes against clean AND
     * mutated source.
     *
     * The pin is the reason this module exists (SSR hydration drift when
     * server and browser disagree on the zone), so it gets a check that
     * fires on every host: each formatter constant must literally carry
     * the locale and the timezone.
     */
    const SOURCE = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'lib', 'format-date.ts'),
        'utf8',
    );

    /** Each `new Intl.DateTimeFormat(...)` call, sliced to its closing `})`. */
    function formatterBlocks(source: string): string[] {
        const marker = 'new Intl.DateTimeFormat(';
        const out: string[] = [];
        let from = 0;
        for (;;) {
            const start = source.indexOf(marker, from);
            if (start < 0) break;
            const end = source.indexOf('})', start);
            expect(end).toBeGreaterThan(start);
            out.push(source.slice(start, end + 2));
            from = end + 2;
        }
        return out;
    }

    const blocks = formatterBlocks(SOURCE);

    it('finds every formatter constant in the module (the scan is not silently empty)', () => {
        // An absence is ambiguous: a scan that matched nothing would let
        // the per-block assertion below pass vacuously. Pin the count
        // against an independent count of the same marker, and against a
        // floor. Lower the floor deliberately if a formatter is removed.
        expect(blocks.length).toBe(SOURCE.split('new Intl.DateTimeFormat(').length - 1);
        expect(blocks.length).toBeGreaterThanOrEqual(10);
    });

    it("every formatter carries timeZone: 'UTC'", () => {
        const offenders = blocks.filter((b) => !/timeZone:\s*'UTC'/.test(b));
        expect(offenders).toStrictEqual([]);
    });

    it('every formatter is constructed with the shared LOCALE constant', () => {
        const offenders = blocks.filter(
            (b) => !/^new Intl\.DateTimeFormat\(LOCALE,/.test(b),
        );
        expect(offenders).toStrictEqual([]);
    });

    it("pins LOCALE to 'en-GB'", () => {
        expect(SOURCE).toMatch(/^const LOCALE = 'en-GB';$/m);
    });
});
