/**
 * #5716 — the label bound on the invoke-depth counter.
 *
 * The counter exists to answer one question the cap's own history could not:
 * what depths do `INVOKE_AGENT` dispatches actually arrive at? Until #5724
 * nothing wrote the depth, so every invoke arrived at 1 and
 * `MAX_AGENT_INVOKE_DEPTH` never fired — which says nothing about whether 5 is
 * the right ceiling.
 *
 * The depth reaches the dispatch off a BullMQ payload, so the LABEL has to be
 * bounded or a corrupted payload mints one time series per value. These pin the
 * bound, and pin that an unusable value agrees with what the dispatch does with
 * it rather than inventing a bucket of its own.
 */
import { depthLabel } from '@/lib/observability/metrics';

describe('the invoke-depth label', () => {
    it('reports a real depth as itself', () => {
        expect(depthLabel(1)).toBe('1');
        expect(depthLabel(5)).toBe('5');
        expect(depthLabel(6)).toBe('6'); // above the cap, and the sample worth having
        expect(depthLabel(10)).toBe('10');
    });

    it('buckets anything past the bound, so cardinality stays fixed', () => {
        expect(depthLabel(11)).toBe('>10');
        expect(depthLabel(9_999)).toBe('>10');
        expect(depthLabel(Number.MAX_SAFE_INTEGER)).toBe('>10');
    });

    it('reads an unusable value as depth 1, the same as the dispatch does', () => {
        expect(depthLabel(Number.NaN)).toBe('1');
        expect(depthLabel(Number.POSITIVE_INFINITY)).toBe('1');
        expect(depthLabel(0)).toBe('1');
        expect(depthLabel(-3)).toBe('1');
    });

    it('truncates a fractional depth rather than labelling a decimal', () => {
        expect(depthLabel(2.7)).toBe('2');
    });

    it('never produces an unbounded set of labels', () => {
        // The property, stated over a wide input range rather than by example.
        const labels = new Set(
            [...Array(200).keys()].map((i) => depthLabel(i - 50)),
        );
        expect(labels.size).toBeLessThanOrEqual(11); // 1..10 plus '>10'
    });
});
