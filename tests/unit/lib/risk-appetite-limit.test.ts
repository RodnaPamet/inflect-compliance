/** #4822 — a limit is parsed, never cast: a separator is refused, not saved as empty. */
import { parseLimit } from '@/lib/risk-appetite-limit';

describe('parseLimit', () => {
    it.each([
        ['', null],
        ['   ', null],
        ['1000000', 1_000_000],
        ['1 000 000', 1_000_000],
        ['2.5', 2.5],
        ['15', 15],
    ])('%j reads as %p', (raw, value) => {
        expect(parseLimit(raw)).toEqual({ ok: true, value });
    });

    it.each(['1,000,000', '1.000.000', '1e6', '-5', 'abc', '12abc', '1,5'])('%j is refused', (raw) => {
        expect(parseLimit(raw)).toEqual({ ok: false });
    });
});
