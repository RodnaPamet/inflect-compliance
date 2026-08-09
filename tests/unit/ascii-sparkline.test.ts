/**
 * The block-character sparkline.
 *
 * B2-7 — this existed as two CHARACTER-IDENTICAL copies, in
 * `risks/kri/page.tsx` and `[riskId]/RiskHistoryPanel.tsx`. Neither had a
 * test, so the edge cases below were unverified in both places at once:
 * the empty series, the flat series (which divides by a zero span unless
 * guarded), and the top-of-range value (which computes exactly the last
 * index and can overshoot on floating-point drift).
 */
import { sparkline } from '@/lib/ascii-sparkline';

describe('sparkline', () => {
    it('renders an em-dash for an empty series, not a flat line', () => {
        // A flat baseline would read as "measured, and unchanging". The
        // truth is "nothing measured".
        expect(sparkline([])).toBe('—');
    });

    it('maps the low value to the lowest glyph and the high to the highest', () => {
        const out = sparkline([0, 100]);
        expect(out).toHaveLength(2);
        expect(out[0]).toBe('▁');
        expect(out[1]).toBe('█');
    });

    it('renders a flat series at the low glyph rather than dividing by zero', () => {
        // span === 0 → the `|| 1` guard. Without it every value is NaN and
        // the whole sparkline renders as `undefined`.
        expect(sparkline([5, 5, 5])).toBe('▁▁▁');
    });

    it('renders one glyph per data point', () => {
        expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toHaveLength(10);
    });

    it('never emits undefined for a top-of-range value', () => {
        // The index for `max` lands exactly on SPARK.length-1; floating
        // point can push it over, and `SPARK[8]` is undefined — which
        // renders the string "undefined" mid-sparkline.
        for (const series of [[1, 3], [0, 7], [2, 9], [10, 30], [0.1, 0.3]]) {
            expect(sparkline(series)).not.toContain('undefined');
            expect([...sparkline(series)].every((c) => '▁▂▃▄▅▆▇█'.includes(c))).toBe(true);
        }
    });

    it('handles negatives, which a min of 0 assumption would break', () => {
        const out = sparkline([-10, 0, 10]);
        expect(out).toHaveLength(3);
        expect(out[0]).toBe('▁');
        expect(out[2]).toBe('█');
    });

    it('is monotonic — a rising series never dips', () => {
        const glyphs = '▁▂▃▄▅▆▇█';
        const out = sparkline([1, 2, 3, 4, 5, 6, 7, 8]);
        const idx = [...out].map((c) => glyphs.indexOf(c));
        expect(idx).toEqual([...idx].sort((a, b) => a - b));
    });

    it('renders a single point without dividing by zero', () => {
        expect(sparkline([42])).toBe('▁');
    });
});
