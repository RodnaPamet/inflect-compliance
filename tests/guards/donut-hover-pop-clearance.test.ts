/**
 * DonutChart — hover-pop clearance guard.
 *
 * On hover the active segment translates radially outward by
 * `CHART_HOVER_POP_DISTANCE` (4px). The SVG viewBox is sized to the
 * donut diameter, so if the resting `outerRadius` reaches the viewBox
 * edge, the popped arc gets clipped — the same class of bug the
 * MiniAreaChart bottom-padding fix (#753) closed for the trend curve.
 *
 * The fix pulls the resting outer radius IN by the pop distance so the
 * popped edge stays inside the box:
 *
 *     outerRadius = size / 2 - CHART_HOVER_POP_DISTANCE - 1
 *
 * Locked here so a future "make the donut bigger" tweak that drops the
 * pop reserve (e.g. back to `(size - 2) / 2`) re-surfaces the clipping
 * and fails CI instead. Lowering the reserve needs to come paired with
 * a different anti-clip mechanism (e.g. an overflow-visible SVG).
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const SRC = path.resolve(
    __dirname,
    '../../src/components/ui/DonutChart.tsx',
);

function read(): string {
    return codeOf(fs.readFileSync(SRC, 'utf-8'));
}

describe('DonutChart hover-pop clearance', () => {
    it('reserves the hover-pop distance in the resting outer radius', () => {
        const src = read();
        // outerRadius must subtract CHART_HOVER_POP_DISTANCE so the
        // popped arc edge lands inside the viewBox.
        expect(src).toMatch(
            /outerRadius\s*=\s*size\s*\/\s*2\s*-\s*CHART_HOVER_POP_DISTANCE/,
        );
        // And the constant must actually be imported from the motion
        // layer (not redefined to a smaller local value).
        expect(src).toMatch(
            /import\s*\{[^}]*\bCHART_HOVER_POP_DISTANCE\b[^}]*\}\s*from\s*['"]@\/components\/ui\/charts\/chart-motion['"]/,
        );
    });

    it('does NOT regress to the clipping `(size - 2) / 2` radius', () => {
        const src = read();
        expect(src).not.toMatch(/outerRadius\s*=\s*\(\s*size\s*-\s*2\s*\)\s*\/\s*2/);
    });
});
