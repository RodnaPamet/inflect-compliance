/**
 * The compliance calendar's day arithmetic at the edges of the clock (#5376).
 *
 * `civilDayInTz`, `daysUntilInTz` and `todayYmdInTz` decide which day "today"
 * is for the observer, and so whether an item is `overdue`, `due_soon` or
 * `scheduled`. The rest of the calendar's tests run in one comfortable zone;
 * these are the instants where a mistake in that arithmetic shows:
 *
 *   - THE WIDEST SPREAD. Pacific/Kiritimati is UTC+14 and Etc/GMT+12 is UTC−12
 *     (the IANA `Etc/GMT` sign is inverted). One instant is two different civil
 *     days apart in them, so an implementation that ignored the zone, or
 *     applied it the wrong way round, cannot pass.
 *   - THE DST TRANSITION DAYS in Europe/Sofia — the last Sunday of March is 23
 *     hours long and the last Sunday of October 25. An implementation that
 *     fixed the offset at the start of the day (or took the current offset for
 *     every instant) puts the last hour of the October day, or the hour after
 *     midnight on the March one, on the wrong date.
 *   - THE MEMO. `civilDayForNow` caches the last (instant, zone) pair. Asking
 *     about the same instant in a second zone must not return the first zone's
 *     day, and asking about a second instant must not return the first's.
 *
 * Pure functions, no database.
 */
import {
    civilDayInTz,
    civilDayForNow,
    daysUntilInTz,
    todayYmdInTz,
    utcDayOf,
} from '@/app-layer/usecases/compliance-calendar/shared';

const KIRITIMATI = 'Pacific/Kiritimati'; // UTC+14, no DST
const MINUS_12 = 'Etc/GMT+12'; // UTC−12
const SOFIA = 'Europe/Sofia'; // EET/EEST

/** The UTC-midnight epoch day of a `YYYY-MM-DD`, the unit `civilDayInTz` returns. */
const dayOf = (ymd: string) => utcDayOf(new Date(`${ymd}T00:00:00Z`));
const at = (iso: string) => new Date(iso);

describe('one instant, the two ends of the clock', () => {
    // 11:00 UTC on 15 June: 01:00 on the 16th in Kiritimati, 23:00 on the 14th at UTC−12.
    const instant = at('2026-06-15T11:00:00Z');

    it('civilDayInTz gives different civil days, two apart', () => {
        expect(civilDayInTz(instant, KIRITIMATI)).toBe(dayOf('2026-06-16'));
        expect(civilDayInTz(instant, MINUS_12)).toBe(dayOf('2026-06-14'));
        expect(civilDayInTz(instant, 'UTC')).toBe(dayOf('2026-06-15'));
        expect(civilDayInTz(instant, KIRITIMATI) - civilDayInTz(instant, MINUS_12)).toBe(2);
    });

    it('todayYmdInTz names the zone\'s own date', () => {
        expect(todayYmdInTz(instant, KIRITIMATI)).toBe('2026-06-16');
        expect(todayYmdInTz(instant, MINUS_12)).toBe('2026-06-14');
    });

    it('daysUntilInTz: the same deadline is yesterday in one zone and tomorrow in the other', () => {
        // The deadline's day is its UTC day (what the grid draws); the zone
        // applies to the observer only.
        const deadline = at('2026-06-15T00:00:00Z');
        expect(daysUntilInTz(deadline, instant, KIRITIMATI)).toBe(-1);
        expect(daysUntilInTz(deadline, instant, MINUS_12)).toBe(1);
        expect(daysUntilInTz(deadline, instant, 'UTC')).toBe(0);
    });

    it('a civil day ends at the zone\'s midnight, not UTC\'s', () => {
        // Kiritimati's 16 June runs from 10:00Z on the 15th to 09:59:59Z on the 16th.
        expect(todayYmdInTz(at('2026-06-15T09:59:59Z'), KIRITIMATI)).toBe('2026-06-15');
        expect(todayYmdInTz(at('2026-06-15T10:00:00Z'), KIRITIMATI)).toBe('2026-06-16');
        // UTC−12's 15 June runs from 12:00Z on the 15th to 11:59:59Z on the 16th.
        expect(todayYmdInTz(at('2026-06-15T11:59:59Z'), MINUS_12)).toBe('2026-06-14');
        expect(todayYmdInTz(at('2026-06-15T12:00:00Z'), MINUS_12)).toBe('2026-06-15');
    });
});

describe('Europe/Sofia on its DST transition days', () => {
    describe('last Sunday of March 2026 (29th): 03:00 EET → 04:00 EEST, a 23-hour day', () => {
        it('starts at 22:00Z the day before (still UTC+2 at midnight)', () => {
            expect(todayYmdInTz(at('2026-03-28T21:59:59Z'), SOFIA)).toBe('2026-03-28');
            expect(todayYmdInTz(at('2026-03-28T22:00:00Z'), SOFIA)).toBe('2026-03-29');
        });

        it('ends at 21:00Z (UTC+3 by the evening), an hour earlier than it started', () => {
            expect(todayYmdInTz(at('2026-03-29T20:59:59Z'), SOFIA)).toBe('2026-03-29');
            expect(todayYmdInTz(at('2026-03-29T21:00:00Z'), SOFIA)).toBe('2026-03-30');
        });

        it('either side of the skipped hour is the same day', () => {
            expect(civilDayInTz(at('2026-03-29T00:59:59Z'), SOFIA)).toBe(dayOf('2026-03-29'));
            expect(civilDayInTz(at('2026-03-29T01:00:00Z'), SOFIA)).toBe(dayOf('2026-03-29'));
        });

        it('a deadline on the 30th is due TODAY at 21:30Z on the 29th', () => {
            // 00:30 on the 30th in Sofia. A fixed UTC+2 reading says 23:30 on the
            // 29th and calls it tomorrow.
            expect(daysUntilInTz(at('2026-03-30T00:00:00Z'), at('2026-03-29T21:30:00Z'), SOFIA)).toBe(0);
        });
    });

    describe('last Sunday of October 2026 (25th): 04:00 EEST → 03:00 EET, a 25-hour day', () => {
        it('starts at 21:00Z the day before (still UTC+3 at midnight)', () => {
            expect(todayYmdInTz(at('2026-10-24T20:59:59Z'), SOFIA)).toBe('2026-10-24');
            expect(todayYmdInTz(at('2026-10-24T21:00:00Z'), SOFIA)).toBe('2026-10-25');
        });

        it('ends at 22:00Z (UTC+2 by the evening), an hour later than it started', () => {
            // 21:30Z is 23:30 on the 25th. A reading that kept UTC+3 all day
            // would put it at 00:30 on the 26th.
            expect(todayYmdInTz(at('2026-10-25T21:30:00Z'), SOFIA)).toBe('2026-10-25');
            expect(todayYmdInTz(at('2026-10-25T21:59:59Z'), SOFIA)).toBe('2026-10-25');
            expect(todayYmdInTz(at('2026-10-25T22:00:00Z'), SOFIA)).toBe('2026-10-26');
        });

        it('the repeated 03:xx hour is the same day both times', () => {
            // 00:30Z is 03:30 EEST; 01:30Z is 03:30 EET.
            expect(civilDayInTz(at('2026-10-25T00:30:00Z'), SOFIA)).toBe(dayOf('2026-10-25'));
            expect(civilDayInTz(at('2026-10-25T01:30:00Z'), SOFIA)).toBe(dayOf('2026-10-25'));
        });

        it('a deadline on the 26th is still tomorrow at 21:30Z on the 25th', () => {
            expect(daysUntilInTz(at('2026-10-26T00:00:00Z'), at('2026-10-25T21:30:00Z'), SOFIA)).toBe(1);
        });
    });
});

describe('the "today" memo never answers for a different question', () => {
    const instant = at('2026-06-15T11:00:00Z');

    it('the same instant asked in a second zone gets that zone\'s day, and back again', () => {
        // Interleaved, so each call follows a memo primed by the OTHER zone.
        expect(civilDayForNow(instant, KIRITIMATI)).toBe(dayOf('2026-06-16'));
        expect(civilDayForNow(instant, MINUS_12)).toBe(dayOf('2026-06-14'));
        expect(civilDayForNow(instant, KIRITIMATI)).toBe(dayOf('2026-06-16'));
        expect(todayYmdInTz(instant, MINUS_12)).toBe('2026-06-14');
        expect(todayYmdInTz(instant, KIRITIMATI)).toBe('2026-06-16');
    });

    it('a second instant in the same zone gets its own day', () => {
        expect(todayYmdInTz(at('2026-06-15T09:59:59Z'), KIRITIMATI)).toBe('2026-06-15');
        expect(todayYmdInTz(at('2026-06-15T10:00:00Z'), KIRITIMATI)).toBe('2026-06-16');
        expect(todayYmdInTz(at('2026-06-15T09:59:59Z'), KIRITIMATI)).toBe('2026-06-15');
    });

    it('daysUntilInTz reads the memo through the zone it was asked with', () => {
        const deadline = at('2026-06-15T00:00:00Z');
        expect(daysUntilInTz(deadline, instant, KIRITIMATI)).toBe(-1);
        expect(daysUntilInTz(deadline, instant, MINUS_12)).toBe(1);
        expect(daysUntilInTz(deadline, instant, KIRITIMATI)).toBe(-1);
    });
});
