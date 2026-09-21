/**
 * R18-PR5 — Donut bubble-entrance.
 *
 * Second consumer of the R18 motion foundations. The DonutChart
 * now drives its centring `<g>` through the R18-PR2
 * `useChartSpring` hook — on mount the whole pie scales from 0
 * through an overshoot peak (~1.05) and settles to 1. The donut
 * "bubbles in" rather than just appearing.
 *
 * Four load-bearing invariants:
 *
 *   1. The component calls `useChartSpring()` and binds the
 *      result to a single `entranceProgress` value. (SSR-safe by
 *      the hook's construction — returns 1 on server + first
 *      client render.)
 *
 *   2. The centring `<g>` transform composes
 *      `translate(center,center)` THEN `scale(entranceProgress)`
 *      — IN THAT ORDER. Scale-after-translate pivots the scale
 *      around the donut centre; scale-before-translate would
 *      bubble from the SVG corner. The order is the bug-or-not
 *      line.
 *
 *   3. The R17/#499 centring fix is preserved — the `translate`
 *      half of the transform is still present and still uses
 *      `${center},${center}`. The bubble-entrance composes ONTO
 *      the centring, it does not replace it.
 *
 *   4. The hover-pop + flow-gradient + gloss wiring (R16 + R18-
 *      PR4) is untouched — `useChartHoverPop`, `useChartFlow`,
 *      and the gloss overlay all still render. The entrance is
 *      additive.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const SRC = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/components/ui/DonutChart.tsx'),
    'utf8',
));

describe('R18-PR5 — Donut bubble-entrance', () => {
    it('calls useChartSpring and binds it to entranceProgress', () => {
        expect(SRC).toMatch(
            /import\s*\{[\s\S]*?useChartSpring[\s\S]*?\}\s*from\s*['"]@\/components\/ui\/charts\/chart-motion['"]/,
        );
        expect(SRC).toMatch(
            /const\s+entranceProgress\s*=\s*useChartSpring\(\)/,
        );
    });

    it('the centring <g> composes translate THEN scale (order is load-bearing)', () => {
        // translate(center,center) scale(entranceProgress) — the
        // scale pivots around the donut centre. The reverse order
        // would bubble from the SVG corner.
        expect(SRC).toMatch(
            /transform=\{`translate\(\$\{center\},\$\{center\}\)\s+scale\(\$\{entranceProgress\}\)`\}/,
        );
    });

    it('preserves the #499 centring fix (translate half still present)', () => {
        // The bubble-entrance composes ONTO the centring transform,
        // not instead of it. If a refactor drops the translate,
        // the donut regresses to the top-left-corner crescent bug.
        expect(SRC).toMatch(/translate\(\$\{center\},\$\{center\}\)/);
    });

    it('R16 hover + R18-PR4 gloss wiring is untouched', () => {
        // The entrance is additive — it must not have displaced
        // the existing motion / gloss layers.
        expect(SRC).toMatch(/useChartHoverPop/);
        expect(SRC).toMatch(/useChartFlow/);
        expect(SRC).toMatch(/<ChartGloss\b/);
    });
});
