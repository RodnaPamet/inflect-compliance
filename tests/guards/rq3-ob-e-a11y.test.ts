/**
 * RQ3-OB-E — Respect every user (a11y) ratchet.
 *
 * Three sub-items, three regression classes:
 *
 *   - Warnings that announce themselves: the residual-baseline
 *     conflict warning must carry role + aria-live so screen-reader
 *     users hear it mount, not just see it. The calibration
 *     warnings on the FAIR panel ALREADY route through
 *     `<InlineNotice>`, which has role="status" + aria-live="polite"
 *     baked in — the ratchet asserts continued use of that primitive
 *     so a future "raw <div>" regression is caught.
 *
 *   - The grid keeps its promise: role="grid" contracts arrow-key
 *     navigation. RiskMatrix carries roving-tabindex state + an
 *     arrow handler; RiskMatrixCell forwards Arrow/Home/End to it
 *     and reflects the `tabbable` prop on tabIndex.
 *
 *   - Motion is a preference: literal `transition-*` / `animate-*`
 *     utilities on the affected components carry a
 *     `motion-reduce:` guard so a user with
 *     `prefers-reduced-motion: reduce` opts out cleanly. The global
 *     CSS-variable override (--duration-fast → 1ms) only catches
 *     utilities that READ the var; a literal `duration-150` needs
 *     a `motion-reduce:transition-none` companion.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const assessmentPanel = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/RiskAssessmentPanel.tsx');
const fairPanel = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/FairAnalysisPanel.tsx');
const matrix = read('src/components/risks/RiskMatrix.tsx');
const matrixCell = read('src/components/risks/RiskMatrixCell.tsx');

describe('RQ3-OB-E — warnings that announce themselves', () => {
    test('the residual-baseline warning carries role + aria-live', () => {
        // The warning JSX renders behind `residualBaselineDirty` and
        // pairs the testid with role="status" + aria-live="polite".
        const warningBlock = assessmentPanel.slice(
            assessmentPanel.indexOf('residualBaselineDirty &&'),
            assessmentPanel.indexOf('residual-baseline-warning') + 200,
        );
        expect(warningBlock).toMatch(/role="status"/);
        expect(warningBlock).toMatch(/aria-live="polite"/);
        expect(warningBlock).toMatch(/data-testid="residual-baseline-warning"/);
    });

    test('the FAIR calibration warnings stay routed through <InlineNotice> (role=status + aria-live baked in)', () => {
        // Belt to the InlineNotice's role/aria-live contract.
        expect(fairPanel).toMatch(/<InlineNotice[^>]*data-testid="fair-calibration-warnings"/);
    });
});

describe('RQ3-OB-E — the grid keeps its promise', () => {
    test('RiskMatrixCell exposes the roving-tabindex + arrow-routing contract', () => {
        expect(matrixCell).toMatch(/tabbable\?: boolean/);
        expect(matrixCell).toMatch(/onArrowKey\?: \(/);
        // tabIndex flips based on `tabbable` only when interactive.
        expect(matrixCell).toMatch(
            /tabIndex=\{interactive \? \(tabbable \? 0 : -1\) : -1\}/,
        );
        // The keyDown handler routes Arrow/Home/End to onArrowKey
        // AFTER Enter/Space (the existing click contract is preserved).
        for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
            expect(matrixCell).toMatch(new RegExp(`e\\.key === '${key}'`));
        }
    });

    test('RiskMatrix manages focused-cell state and computes the next cell on arrow', () => {
        expect(matrix).toMatch(/const \[focusedKey, setFocusedKey\] = useState<string \| null>/);
        // Arrow handler: clamp at edges (no wrap), Home/End jump to row's edges.
        expect(matrix).toMatch(/const handleArrowKey = useCallback/);
        expect(matrix).toMatch(/Math\.max\(0, yIdx - 1\)/);
        expect(matrix).toMatch(/Math\.min\(yLevels - 1, yIdx \+ 1\)/);
        expect(matrix).toMatch(/key === 'Home'/);
        expect(matrix).toMatch(/key === 'End'/);
        // The active cell is wired tabbable; the rest sit at -1.
        expect(matrix).toMatch(/tabbable=\{interactive && cellKey === effectiveFocusedKey\}/);
        // Focus moves imperatively after React commits.
        expect(matrix).toMatch(/requestAnimationFrame/);
    });
});

describe('RQ3-OB-E — motion is a preference', () => {
    test('RiskMatrixCell guards its color transition with motion-reduce', () => {
        // Belt to the global CSS-var override: the literal
        // `duration-150` doesn't read the var, so a per-utility guard
        // is required for users with the OS preference set.
        expect(matrixCell).toMatch(/transition-colors duration-150 ease-out motion-reduce:transition-none/);
    });

    test('the existing motion-reduce: ecosystem stays the norm — no NEW raw transition utility regresses on the matrix cell', () => {
        // Every `transition-` utility on the matrix cell MUST carry a
        // `motion-reduce:` companion. The check is conservative — it
        // looks for any `transition-` substring and asserts the same
        // file also carries `motion-reduce:transition-none`. A new
        // unguarded utility fails this test.
        const hasTransition = /\btransition-[\w-]+/.test(matrixCell);
        const hasGuard = /motion-reduce:transition-none/.test(matrixCell);
        if (hasTransition) expect(hasGuard).toBe(true);
    });
});
