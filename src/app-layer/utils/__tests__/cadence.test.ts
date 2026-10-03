import { computeNextDueAt } from '../cadence';

describe('computeNextDueAt', () => {
    const baseDate = new Date('2026-03-08T12:00:00Z');

    it('returns null for AD_HOC frequency', () => {
        expect(computeNextDueAt('AD_HOC', baseDate)).toBeNull();
    });

    it('returns null for null/undefined frequency', () => {
        expect(computeNextDueAt(null, baseDate)).toBeNull();
        expect(computeNextDueAt(undefined, baseDate)).toBeNull();
    });

    it('returns null for unknown frequency', () => {
        expect(computeNextDueAt('UNKNOWN_FREQ', baseDate)).toBeNull();
    });

    it('computes DAILY correctly (+1 day)', () => {
        const result = computeNextDueAt('DAILY', baseDate)!;
        expect(result.getDate()).toBe(9);
        expect(result.getMonth()).toBe(baseDate.getMonth());
    });

    it('computes WEEKLY correctly (+7 days)', () => {
        const result = computeNextDueAt('WEEKLY', baseDate)!;
        expect(result.getDate()).toBe(15);
    });

    it('computes MONTHLY correctly (+1 month)', () => {
        const result = computeNextDueAt('MONTHLY', baseDate)!;
        expect(result.getMonth()).toBe(3); // April
        expect(result.getDate()).toBe(8);
    });

    it('computes QUARTERLY correctly (+3 months)', () => {
        const result = computeNextDueAt('QUARTERLY', baseDate)!;
        expect(result.getMonth()).toBe(5); // June
        expect(result.getDate()).toBe(8);
    });

    it('computes ANNUALLY correctly (+1 year)', () => {
        const result = computeNextDueAt('ANNUALLY', baseDate)!;
        expect(result.getFullYear()).toBe(2027);
        expect(result.getMonth()).toBe(2); // March
    });

    it('defaults to current date if no fromDate provided', () => {
        const beforeCall = new Date();
        const result = computeNextDueAt('DAILY')!;
        expect(result.getTime()).toBeGreaterThan(beforeCall.getTime());
    });

    it('CLAMPS month end rather than rolling over (#3136)', () => {
        /*
            This asserted March, with the comment "Feb 31 doesn't exist — JS
            rolls over to March". That described `setMonth`'s behaviour
            accurately and pinned it as if it were the intent — so the defect
            was covered by a passing test for its whole life, which is why it
            survived.

            What it meant in the product: a monthly control tested on the 31st
            got no February deadline at all, and the date walked forward every
            month after. Owner decision is to clamp — 31 Jan is due 28 Feb.
        */
        const jan31 = new Date('2026-01-31T12:00:00Z');
        const result = computeNextDueAt('MONTHLY', jan31)!;
        expect(result.getMonth()).toBe(1); // February, not March
        expect(result.getDate()).toBe(28); // 2026 is not a leap year
    });

    it('clamps to 29 February in a leap year', () => {
        // The clamp reads the target month's real length rather than carrying
        // a leap-year rule of its own.
        const jan31 = new Date('2024-01-31T12:00:00Z');
        const result = computeNextDueAt('MONTHLY', jan31)!;
        expect(result.getMonth()).toBe(1);
        expect(result.getDate()).toBe(29);
    });

    it('and a 31st that HAS a 31st is left alone', () => {
        // Teeth for the two above: a clamp that fired unconditionally would
        // move every month-end date to the 28th.
        const mar31 = new Date('2026-03-31T12:00:00Z');
        const result = computeNextDueAt('MONTHLY', mar31)!;
        expect(result.getMonth()).toBe(3); // April
        expect(result.getDate()).toBe(30); // April has 30 — still clamped
        const jan31 = new Date('2026-01-31T12:00:00Z');
        const dec = computeNextDueAt('MONTHLY', new Date('2026-12-31T12:00:00Z'))!;
        expect(dec.getMonth()).toBe(0); // January, wrapped
        expect(dec.getDate()).toBe(31); // …and January has a 31st
        expect(dec.getFullYear()).toBe(2027);
        expect(jan31.getDate()).toBe(31); // the input is not mutated
    });

    it('ANNUALLY clamps 29 February to 28 February', () => {
        // `setFullYear(+1)` on 29 Feb silently yields 1 March. Twelve clamped
        // months is why this lands on the 28th.
        const feb29 = new Date('2024-02-29T12:00:00Z');
        const result = computeNextDueAt('ANNUALLY', feb29)!;
        expect(result.getFullYear()).toBe(2025);
        expect(result.getMonth()).toBe(1);
        expect(result.getDate()).toBe(28);
    });

    it('QUARTERLY clamps too — 31 Aug is due 30 Nov', () => {
        const aug31 = new Date('2026-08-31T12:00:00Z');
        const result = computeNextDueAt('QUARTERLY', aug31)!;
        expect(result.getMonth()).toBe(10); // November
        expect(result.getDate()).toBe(30);
    });
});
