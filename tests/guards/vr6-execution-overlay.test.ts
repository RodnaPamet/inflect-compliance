/**
 * VR-6 — live execution overlay ratchet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('VR-6 — execution overlay', () => {
    it('run-mode context + overlay module exist', () => {
        expect(exists('src/lib/processes/run-mode-context.tsx')).toBe(true);
        expect(exists('src/lib/processes/canvas-execution-overlay.tsx')).toBe(true);
    });

    it('the overlay is distributed via context (no per-node tenant SWR)', () => {
        const src = read('src/lib/processes/canvas-execution-overlay.tsx');
        expect(src).toMatch(/CanvasOverlayProvider/);
        expect(src).toMatch(/useNodeOverlayStatus/);
        expect(src).toMatch(/refreshInterval/);
    });

    it('the per-node overlay paint is UNPORTED, on the record', () => {
        /*
            A retirement on the same terms as VR-5's (see
            `vr5-chain-edges.test.ts` for the full reasoning).

            `useNodeOverlayStatus` and `overlayClass` were read by
            `ProcessTypedNode.tsx`, the xyflow node renderer.
            `lib/processes/canvas-execution-overlay.tsx` is now referenced by
            nothing but itself, and `ProcessNodeShapeUtil` paints no overlay.

            The overlay shows per-node RUN state, which needs an AUTOMATION map
            to run. Production has **0** of them, so there is nothing to
            overlay.

            The original assertion's most interesting half is kept and INVERTED
            below: it insisted the node must not call the tenant SWR poll
            per-node, because one request per node is how a 500-node map
            melts. That constraint is the part worth carrying forward to
            whoever ports this — so it is asserted of the successor now, where
            it holds trivially, rather than lost with the file that motivated
            it.
        */
        const util = read(
            'src/components/processes/tldraw/ProcessNodeShapeUtil.tsx',
        );
        expect(util).not.toMatch(/useNodeOverlayStatus/);
        // The constraint that outlives the feature: never a per-node poll.
        expect(util).not.toMatch(/useCanvasExecutionOverlay/);
    });
});
