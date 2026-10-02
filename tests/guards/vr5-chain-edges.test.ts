/**
 * VR-5 — visual chain edges ratchet.
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

describe('VR-5 — chain edges', () => {
    it('the edge-kind inference module exists with the 6 automation kinds', () => {
        const p = 'src/lib/processes/edge-kind-inference.ts';
        expect(exists(p)).toBe(true);
        const src = read(p);
        for (const k of [
            'trigger-flow',
            'condition-pass',
            'condition-fail',
            'chain-delay',
            'sla-breach',
            'sla-pass',
        ]) {
            expect(src).toMatch(new RegExp(k));
        }
        expect(src).toMatch(/export function inferEdgeKind/);
    });

    it('the per-kind automation style + chip are UNPORTED, on the record', () => {
        /*
            ═══ A RETIREMENT, NOT A DELETION (#3079) ═══

            `buildAutomationEdgeStyle` and `data-edge-kind-chip` lived only in
            `components/processes/ProcessEdge.tsx`, the xyflow edge renderer.
            On an AUTOMATION map that gave each semantic edge kind a distinct
            stroke plus a label chip so — per that file's own docblock — "the
            workflow graph reads without opening any node". The tldraw edge
            draws every automation edge identically.

            Deleting this test was the obvious move and the wrong one. The
            sibling guard `visual-editor-reachability` exists BECAUSE VR-5 was
            dead code once already; replacing a reachability claim with silence
            is precisely how that recurs.

            ═══ THE NUMBER THAT MAKES IT TOLERABLE ═══

            Read against production at the cutover: **0 maps in AUTOMATION
            mode** (1 ProcessMap total, 3 ProcessEdge rows). So the styling is
            decoration for a surface nobody has created, and porting it would
            be building a renderer for zero rows.

            ═══ WHAT WOULD HAVE TO CHANGE ═══

            The first AUTOMATION map. The tldraw edge already reads `edgeKind`
            for the flow/conditional/reference strokes (#3090) and `label` for
            the caption (#3093), so the port is a third arm on an existing
            branch plus the chip — not new machinery.

            Asserted as an ABSENCE so the state cannot drift silently into
            "somebody probably did it".
        */
        const util = read(
            'src/components/processes/tldraw/ProcessEdgeShapeUtil.tsx',
        );
        expect(util).not.toMatch(/buildAutomationEdgeStyle/);
        expect(util).not.toMatch(/data-edge-kind-chip/);
        // The variant + label arms it DOES have, so this is a narrow absence
        // rather than "the edge renderer is empty".
        expect(util).toMatch(/edgeStrokeFor\(edgeKind\)/);
        expect(util).toMatch(/data-process-edge-label/);
    });
});
