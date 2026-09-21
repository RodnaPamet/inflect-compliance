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

    it('ProcessTypedNode paints the overlay from context (not a tenant hook)', () => {
        const src = read('src/components/processes/ProcessTypedNode.tsx');
        expect(src).toMatch(/useNodeOverlayStatus/);
        expect(src).toMatch(/overlayClass/);
        // must NOT call the tenant SWR poll per node
        expect(src).not.toMatch(/useCanvasExecutionOverlay/);
    });
});
