/**
 * Branch coverage for `src/lib/number-format.ts` (pure formatting utils).
 *
 * Exercises every branch of nFormatter + currencyFormatter:
 *   nFormatter:
 *     - undefined / 0 / falsy → '0' (the `!num` short-circuit).
 *     - opts.full → grouping-separator path.
 *     - num < 1 → toFixed + trailing-zero strip.
 *     - SI unit selection across K / M / G / T scales.
 *     - trailing-zero stripping ("1.0" → "1", "1.50" → "1.5").
 *     - custom digits.
 *     - bigint input coercion.
 *   currencyFormatter:
 *     - null / undefined → 0.
 *     - bigint → Number coercion.
 *     - zero-decimal currency (JPY) → whole units, no /100.
 *     - normal currency (USD) → /100.
 *     - options override (currency).
 */
import { nFormatter, currencyFormatter } from '@inflect/ui/lib/number-format';

describe('nFormatter', () => {
    it('returns "0" for undefined, 0, NaN (the falsy short-circuit)', () => {
        expect(nFormatter(undefined)).toBe('0');
        expect(nFormatter(0)).toBe('0');
        expect(nFormatter(NaN)).toBe('0');
    });

    it('formats with grouping separators when opts.full', () => {
        expect(nFormatter(2_000_000, { full: true })).toBe('2,000,000');
        expect(nFormatter(1234, { full: true })).toBe('1,234');
    });

    it('formats values < 1 with fixed precision + trailing-zero strip', () => {
        expect(nFormatter(0.5)).toBe('0.5');
        // 0.10 → "0.1" via trailing-zero regex
        expect(nFormatter(0.1)).toBe('0.1');
    });

    it('selects the right SI unit and strips trailing zeros', () => {
        expect(nFormatter(1500)).toBe('1.5K');
        expect(nFormatter(2_000_000)).toBe('2M'); // "2.0" → "2"
        expect(nFormatter(1_000)).toBe('1K');
        expect(nFormatter(3_500_000_000)).toBe('3.5G');
        expect(nFormatter(7_000_000_000_000)).toBe('7T');
        expect(nFormatter(42)).toBe('42'); // unit '' (value 1)
    });

    it('honours custom digits', () => {
        expect(nFormatter(1234, { digits: 2 })).toBe('1.23K');
        expect(nFormatter(1500, { digits: 0 })).toBe('2K');
    });

    it('coerces bigint input', () => {
        expect(nFormatter(BigInt(2_000_000))).toBe('2M');
        expect(nFormatter(BigInt(0))).toBe('0');
    });
});

describe('currencyFormatter', () => {
    it('treats null/undefined as 0', () => {
        expect(currencyFormatter(null)).toBe('$0.00');
        expect(currencyFormatter(undefined)).toBe('$0.00');
    });

    it('divides normal currency by 100 (cents → dollars)', () => {
        expect(currencyFormatter(12345)).toBe('$123.45');
    });

    it('treats zero-decimal currency (JPY) as whole units', () => {
        // 1000 minor units = ¥1,000 (no /100), trailingZeroDisplay stripped.
        expect(currencyFormatter(1000, { currency: 'JPY' })).toBe('¥1,000');
    });

    it('coerces bigint amounts', () => {
        expect(currencyFormatter(BigInt(50000))).toBe('$500.00');
    });

    it('honours an explicit currency option', () => {
        const out = currencyFormatter(10000, { currency: 'EUR' });
        expect(out).toContain('100');
    });
});
