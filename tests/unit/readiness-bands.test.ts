/**
 * The readiness bands, behaviourally.
 *
 * `tests/guards/readiness-band-single-definition.test.ts` asserts the numbers
 * exist in one place. This asserts they are the RIGHT numbers and that the
 * three vocabularies agree — a single definition that quietly changed a
 * boundary, or whose maps disagreed about which band is which, would satisfy
 * the structural guard and still repaint the product.
 *
 * The boundary cases are the point. All six replaced call sites used `>=`, so
 * a score of exactly 80 was `ready` and exactly 50 was `nearly`. An off-by-one
 * here silently re-bands every tenant sitting on a round number.
 */
import {
    readinessBand,
    readinessVariant,
    readinessTone,
    READINESS_BAND_MIN,
    READINESS_BAND_VARIANT,
    READINESS_BAND_TONE,
    READINESS_BAND_COLOR_VAR,
    type ReadinessBand,
} from '@/lib/readiness/bands';

describe('readinessBand', () => {
    it.each([
        [100, 'ready'],
        [81, 'ready'],
        [80, 'ready'], // inclusive — the exact boundary every call site used
        [79, 'nearly'],
        [65, 'nearly'],
        [51, 'nearly'],
        [50, 'nearly'], // inclusive
        [49, 'atRisk'],
        [1, 'atRisk'],
        [0, 'atRisk'],
    ])('%i → %s', (score, expected) => {
        expect(readinessBand(score)).toBe(expected);
    });

    it('the boundaries are 80 and 50 — not "whatever the constant says"', () => {
        // Reading the constant back would make this test agree with any edit.
        // The product's contract is these two numbers.
        expect(READINESS_BAND_MIN.ready).toBe(80);
        expect(READINESS_BAND_MIN.nearly).toBe(50);
    });

    it('handles out-of-range scores without inventing a fourth band', () => {
        expect(readinessBand(120)).toBe('ready');
        expect(readinessBand(-5)).toBe('atRisk');
    });
});

describe('the three vocabularies say the same thing', () => {
    const BANDS: ReadinessBand[] = ['ready', 'nearly', 'atRisk'];

    it('every band has an entry in every vocabulary', () => {
        // A missing entry renders as `undefined` — an uncoloured badge, which
        // reads as "no data" rather than as an error.
        for (const band of BANDS) {
            expect(READINESS_BAND_VARIANT[band]).toBeTruthy();
            expect(READINESS_BAND_TONE[band]).toBeTruthy();
            expect(READINESS_BAND_COLOR_VAR[band]).toBeTruthy();
        }
    });

    it('maps the bands to the vocabularies the six call sites used', () => {
        expect(READINESS_BAND_VARIANT).toEqual({
            ready: 'success',
            nearly: 'warning',
            atRisk: 'error',
        });
        expect(READINESS_BAND_TONE).toEqual({
            ready: 'success',
            nearly: 'attention',
            atRisk: 'critical',
        });
    });

    it('the colour vocabulary is tokens, never hex', () => {
        // The ring shipped #22c55e/#eab308/#ef4444, which do not re-theme.
        for (const value of Object.values(READINESS_BAND_COLOR_VAR)) {
            expect(value).toMatch(/^var\(--[\w-]+\)$/);
            expect(value).not.toMatch(/#[0-9a-f]{3,8}/i);
        }
    });

    it('no two bands share a colour — the ring must stay readable', () => {
        const colors = Object.values(READINESS_BAND_COLOR_VAR);
        expect(new Set(colors).size).toBe(colors.length);
    });

    it('the convenience helpers agree with the maps they wrap', () => {
        for (const score of [95, 80, 79, 50, 49, 0]) {
            expect(readinessVariant(score)).toBe(READINESS_BAND_VARIANT[readinessBand(score)]);
            expect(readinessTone(score)).toBe(READINESS_BAND_TONE[readinessBand(score)]);
        }
    });

    it('a "good" score is never painted as a problem in any vocabulary', () => {
        // The cross-vocabulary invariant: one map inverted would have been
        // invisible to a per-map test.
        expect(readinessVariant(90)).toBe('success');
        expect(readinessTone(90)).toBe('success');
        expect(READINESS_BAND_COLOR_VAR[readinessBand(90)]).toContain('success');

        expect(readinessVariant(10)).toBe('error');
        expect(readinessTone(10)).toBe('critical');
        expect(READINESS_BAND_COLOR_VAR[readinessBand(10)]).toContain('error');
    });
});
