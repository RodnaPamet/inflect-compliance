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

    it('the per-kind automation style and the chip are PORTED (#3093)', () => {
        /*
            ═══ A RETIREMENT, REVERSED BY THE OWNER ═══

            This assertion used to pin the ABSENCE of the per-kind styling, and
            the reasoning it gave was sound as far as it went: `0 maps in
            AUTOMATION mode` in production at the cutover, so the styling was
            decoration for a surface nobody had created.

            The owner decided to port it anyway, which is their call to make —
            the production count argues about PRIORITY and this file had turned
            it into an argument about CORRECTNESS. Recorded here rather than
            quietly swapped, because the previous text is the kind of note a
            later reader would otherwise find contradicted with no explanation.

            ═══ WHAT PORTED, AND WHERE IT LIVES NOW ═══

            Not as `buildAutomationEdgeStyle` — the xyflow renderer had TWO
            dispatches on one field, a variant style and an automation style
            where the second overrode the first on the same read. Here they are
            arms of one `edgeStrokeFor`, because `edgeKind` carries either a
            document variant or an automation kind and never both.

            The CHIP is split: `automationChipKey` is the pure mapping, and the
            HOST resolves the text, because no shape util in this codebase takes
            a translator and the chip loses to a typed label and to controls —
            and `controls` lives on the binding, which the line cannot reach.
        */
        const util = read('src/components/processes/tldraw/ProcessEdgeShapeUtil.tsx');
        const shape = read('src/components/processes/tldraw/process-edge-shape.ts');

        // The chip renders, tagged with the kind that produced it.
        expect(util).toMatch(/data-edge-kind-chip/);
        // Still ONE dispatch, not the xyflow pair.
        expect(util).toMatch(/edgeStrokeFor\(edgeKind\)/);
        expect(util).not.toMatch(/buildAutomationEdgeStyle/);
        expect(util).toMatch(/data-process-edge-label/);

        /*
            The colour must be an INLINE STYLE, not the `stroke` attribute, and
            this is the assertion that pins it: a CSS class beats a presentation
            attribute, so the element's own `stroke-border-emphasis` would keep
            painting while a `stroke="var(--content-error)"` sat there looking
            applied. Pinned in a guard as well as in a rendered test because the
            rendered test reads the computed style and a reader changing this
            line would not necessarily think to run it.
        */
        expect(util).toMatch(/style=\{variantStroke\.stroke \? \{ stroke: variantStroke\.stroke \}/);

        // All six kinds carry a token, and the mapping is total.
        for (const k of [
            'trigger-flow',
            'condition-pass',
            'condition-fail',
            'chain-delay',
            'sla-breach',
            'sla-pass',
        ]) {
            expect(shape).toMatch(new RegExp(`case '${k}':`));
        }
        expect(shape).toMatch(/export function automationChipKey/);
    });

    it('and inferEdgeKind has its consumer back — the live-draw site', () => {
        /*
            The module's own reason for existing: `visual-editor-reachability`
            was written BECAUSE VR-5 was dead code once already. It became dead
            a second time when the xyflow canvas took its `onConnect` call site
            with it, and this is the tldraw equivalent of that call site.

            Asserted in BOTH files deliberately — the sibling guard asserts the
            same consumer from the reachability side. One of the two will be
            edited by someone removing this; two make that visible.
        */
        const arrow = read('src/components/processes/tldraw/arrow-to-edge.ts');
        expect(arrow).toMatch(/inferEdgeKind\(/);
        // In the PURE classifier, not buried in the editor plumbing.
        expect(arrow).toMatch(/edgeKind: inferEdgeKind\(/);
    });
});
