/**
 * Same-cell ALE collisions — the qualitative matrix hiding a 100× spread.
 *
 * Two risks land in the same likelihood×impact cell, so the matrix paints
 * them identically — while one carries €5k of expected loss and the other
 * €5M. The cell is the claim "these are the same size", and the money says
 * otherwise. That is what this detector surfaces.
 *
 * B3-5 — `rq3-5-histograms.test.ts` asserted this by scanning source for
 * `export function detectCellCollisions` and
 * `export const COLLISION_RATIO_THRESHOLD = 10`. That proves the identifiers
 * exist and the literal reads 10; it says nothing about which cells are
 * flagged, and the function had NO other coverage — so every rule below was
 * unverified.
 *
 * The purity assertion (`no prisma / RequestContext import`) stays a file
 * scan in that guard: it is an architectural claim about the module's
 * dependencies, which a unit test cannot make.
 */
import {
    detectCellCollisions,
    COLLISION_RATIO_THRESHOLD,
} from '@/lib/risk-collisions';

const risk = (id: string, likelihood: number, impact: number, ale: number | null) => ({
    id, title: `Risk ${id}`, likelihood, impact, ale,
});

describe('detectCellCollisions', () => {
    it('flags a cell whose ALEs differ beyond the threshold', () => {
        const out = detectCellCollisions([
            risk('a', 3, 3, 1_000),
            risk('b', 3, 3, 50_000), // 50× — well past 10
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            likelihood: 3, impact: 3, quantifiedCount: 2, ratio: 50,
        });
        expect(out[0].minRisk.id).toBe('a');
        expect(out[0].maxRisk.id).toBe('b');
    });

    it('does NOT flag a cell within the threshold', () => {
        // 9× — tight enough that the cell is telling the truth.
        expect(detectCellCollisions([risk('a', 2, 2, 1_000), risk('b', 2, 2, 9_000)])).toEqual([]);
    });

    it('treats the threshold as exclusive — exactly 10× is not a collision', () => {
        // The boundary decides whether a real register lights up or stays
        // quiet; `>` vs `>=` is a one-character difference with visible
        // consequences, and nothing else pins it.
        expect(detectCellCollisions([risk('a', 2, 2, 1_000), risk('b', 2, 2, 10_000)])).toEqual([]);
        expect(detectCellCollisions([risk('a', 2, 2, 1_000), risk('b', 2, 2, 10_001)]))
            .toHaveLength(1);
    });

    it('ignores zero and null ALEs rather than reporting infinite ratios', () => {
        // A €0 "estimate" carries no magnitude. Dividing by it would make
        // every cell an infinite collision and the feature useless noise.
        expect(detectCellCollisions([risk('a', 4, 4, 0), risk('b', 4, 4, 90_000)])).toEqual([]);
        expect(detectCellCollisions([risk('a', 4, 4, null), risk('b', 4, 4, 90_000)])).toEqual([]);
        expect(detectCellCollisions([risk('a', 4, 4, -5), risk('b', 4, 4, 90_000)])).toEqual([]);
    });

    it('needs at least two quantified risks in the SAME cell', () => {
        // One quantified risk beside one unquantified is not a comparison.
        expect(detectCellCollisions([risk('a', 1, 1, 100), risk('b', 1, 1, null)])).toEqual([]);
        // …and two big spreads in DIFFERENT cells are not a collision either.
        expect(detectCellCollisions([risk('a', 1, 1, 100), risk('b', 5, 5, 100_000)])).toEqual([]);
    });

    it('sorts worst-compression first', () => {
        const out = detectCellCollisions([
            risk('a', 1, 1, 1_000), risk('b', 1, 1, 20_000),   // 20×
            risk('c', 2, 2, 1_000), risk('d', 2, 2, 500_000),  // 500×
        ]);
        expect(out.map((c) => c.ratio)).toEqual([500, 20]);
    });

    it('picks the true min and max across more than two risks', () => {
        const out = detectCellCollisions([
            risk('mid', 3, 3, 10_000),
            risk('low', 3, 3, 500),
            risk('high', 3, 3, 200_000),
        ]);
        expect(out[0].quantifiedCount).toBe(3);
        expect(out[0].minRisk.id).toBe('low');
        expect(out[0].maxRisk.id).toBe('high');
        expect(out[0].ratio).toBe(400);
    });

    it('honours a caller-supplied threshold', () => {
        const pair = [risk('a', 2, 2, 1_000), risk('b', 2, 2, 3_000)];
        expect(detectCellCollisions(pair)).toEqual([]);          // default 10
        expect(detectCellCollisions(pair, 2)).toHaveLength(1);   // stricter
    });

    it('exports the documented default threshold', () => {
        expect(COLLISION_RATIO_THRESHOLD).toBe(10);
    });

    it('returns an empty list for an empty register', () => {
        expect(detectCellCollisions([])).toEqual([]);
    });
});
