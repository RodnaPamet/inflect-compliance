/**
 * "Detected at" (#4463) — the instant every NIS2 Article 23 deadline is
 * counted from. The form takes a day (DatePicker, UTC-midnight Y/M/D) and a
 * time (`HH:MM`), and these helpers make one local instant of them. Pure.
 */
import {
    DETECTED_AT_FUTURE_TOLERANCE_MS,
    combineDetectedAt,
    isDetectedAtInFuture,
    localTimeOf,
    pickerDayOf,
} from '@/lib/incidents/detected-at';
import { computeDeadlines } from '@/lib/incidents/deadlines';

describe('detected-at helpers', () => {
    it('reads the LOCAL day and time of an instant', () => {
        const at = new Date(2026, 9, 29, 14, 37, 20);
        expect(pickerDayOf(at).toISOString()).toBe('2026-10-29T00:00:00.000Z');
        expect(localTimeOf(at)).toBe('14:37');
        expect(localTimeOf(new Date(2026, 0, 2, 3, 4))).toBe('03:04');
    });

    it('combines a picker day and a time into that local instant', () => {
        const day = new Date(Date.UTC(2026, 9, 29));
        expect(combineDetectedAt(day, '14:37')?.getTime()).toBe(new Date(2026, 9, 29, 14, 37).getTime());
        expect(combineDetectedAt(day, '23:59:30')?.getTime()).toBe(
            new Date(2026, 9, 29, 23, 59, 30).getTime(),
        );
        // Round trip: the default the form shows is the instant it was opened, to the minute.
        const opened = new Date(2026, 9, 29, 8, 5, 41);
        expect(combineDetectedAt(pickerDayOf(opened), localTimeOf(opened))?.getTime()).toBe(
            new Date(2026, 9, 29, 8, 5).getTime(),
        );
    });

    it('refuses to guess: no day, no time, or a value a time input cannot hold', () => {
        const day = new Date(Date.UTC(2026, 9, 29));
        expect(combineDetectedAt(null, '14:37')).toBeNull();
        expect(combineDetectedAt(day, '')).toBeNull();
        expect(combineDetectedAt(day, '24:00')).toBeNull();
        expect(combineDetectedAt(day, '9:5')).toBeNull();
        expect(combineDetectedAt(day, '12:60')).toBeNull();
    });

    it('calls a time "in the future" only past the tolerance given', () => {
        const now = new Date('2026-10-29T14:37:00.000Z');
        expect(isDetectedAtInFuture(new Date('2026-10-29T14:37:00.000Z'), now)).toBe(false);
        expect(isDetectedAtInFuture(new Date('2026-10-29T14:37:01.000Z'), now)).toBe(true);
        const withinSkew = new Date(now.getTime() + DETECTED_AT_FUTURE_TOLERANCE_MS);
        expect(isDetectedAtInFuture(withinSkew, now, DETECTED_AT_FUTURE_TOLERANCE_MS)).toBe(false);
        const pastSkew = new Date(now.getTime() + DETECTED_AT_FUTURE_TOLERANCE_MS + 1);
        expect(isDetectedAtInFuture(pastSkew, now, DETECTED_AT_FUTURE_TOLERANCE_MS)).toBe(true);
    });

    it('lets the Article 23 deadlines follow the time entered, not midnight', () => {
        const detectedAt = combineDetectedAt(new Date(Date.UTC(2026, 9, 29)), '14:37')!;
        const due = Object.fromEntries(
            computeDeadlines(detectedAt).map((d) => [d.kind, d.dueAt.getTime()]),
        );
        expect(due.EARLY_WARNING_24H).toBe(detectedAt.getTime() + 24 * 3_600_000);
        expect(new Date(due.EARLY_WARNING_24H).getMinutes()).toBe(37);
        expect(due.DETAILED_72H).toBe(detectedAt.getTime() + 72 * 3_600_000);
        // A day-only value would have started every clock at the day's start.
        const midnight = computeDeadlines(pickerDayOf(detectedAt));
        expect(midnight[0].dueAt.getTime()).toBeLessThan(due.EARLY_WARNING_24H);
    });
});
