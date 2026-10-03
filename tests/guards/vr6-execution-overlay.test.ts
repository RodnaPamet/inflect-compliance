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

    it('the per-node overlay paint is PORTED (#3115)', () => {
        /*
            ═══ A RETIREMENT, REVERSED BY THE OWNER ═══

            This asserted the ABSENCE of the per-node paint, on the same terms as
            VR-5's retirement: the overlay shows per-node RUN state, which needs
            an AUTOMATION map, and production has 0 of them.

            The owner decided to port all three retired capabilities after VR-5's
            port went in (#3112). Recorded rather than quietly swapped: the
            production count is an argument about PRIORITY, and a guard asserting
            an absence had turned it into an argument about CORRECTNESS.

            ═══ WHAT THE PORT ACTUALLY WAS ═══

            Wiring, not building. Every piece survived the cutover in
            `lib/processes/canvas-execution-overlay.tsx` — the pure reducer, the
            pure status→class map, the provider and the context read — and the
            live-executions route was already serving. Two wires were missing:
            the workspace did not mount the provider, and the node util did not
            read the context.

            ═══ THE CONSTRAINT THAT OUTLIVED THE FEATURE ═══

            The original assertion's most interesting half was that the node must
            NOT subscribe per-node, because one request per node is how a
            500-node map melts. That is kept below, now asserted of a renderer
            that really does paint an overlay — where it is a live constraint
            rather than a trivially-true one.
        */
        const util = read('src/components/processes/tldraw/ProcessNodeShapeUtil.tsx');
        const workspace = read('src/components/processes/TldrawProcessWorkspace.tsx');

        // The node reads the CONTEXT…
        expect(util).toMatch(/useNodeOverlayStatus\(/);
        expect(util).toMatch(/overlayClassFor\(/);
        // …and the workspace provides it, gated so the poll cannot run on a
        // document map. `enabled={isRunMode}` and not `enabled` bare: an
        // unconditional mount polls every 3s on every map in production.
        expect(workspace).toMatch(/<CanvasOverlayProvider enabled=\{isRunMode\}>/);

        // THE CONSTRAINT THAT SURVIVES: never a per-node subscription.
        expect(util).not.toMatch(/useCanvasExecutionOverlay/);
        expect(util).not.toMatch(/useTenantSWR/);
        expect(util).not.toMatch(/refreshInterval/);

        /*
            And the id is NARROWED, not cast. `dataJson` is the opaque
            passthrough (#2960), so a row whose `ruleId` is a number would be a
            render-time crash on the canvas if this read it as a string.
        */
        expect(util).toMatch(/export function ruleIdFromDataJson/);
        expect(util).toMatch(/typeof id === 'string'/);
    });
});
