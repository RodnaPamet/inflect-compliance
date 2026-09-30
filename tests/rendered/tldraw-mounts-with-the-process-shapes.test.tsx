/**
 * @jest-environment jsdom
 *
 * tldraw mounts, registers our shape layer, and renders the watermark.
 *
 * ── What this is the first test of ───────────────────────────────────
 *
 * The shape layer (#2994), the binding layer (#2998) and the serializer
 * (#3009) all shipped unit-tested against **plain objects** — correct as far
 * as it goes, and never once exercised by a live editor. #2961's surface swap
 * begins by mounting one, so this is the test that says the pieces fit
 * together at all.
 *
 * Three claims, in increasing order of what they'd cost to discover later:
 *
 *   1. The editor **mounts and finishes initialising**. Four jsdom shims stand
 *      behind that; see `tests/helpers/tldraw-jsdom.ts` for which and why.
 *   2. The editor **accepts our custom shape type** and can create a shape
 *      from a real row's props. A `ShapeUtil` whose validators disagree with
 *      the serializer's output is rejected at `createShapes` time, and no
 *      amount of plain-object unit testing surfaces that.
 *   3. The **watermark renders**. This is a licence property, not a cosmetic
 *      one — see below.
 *
 * ── Why the watermark assertion is the important one ─────────────────
 *
 * tldraw's terms flip at 4.0.0. This repo pins `^3.15.6` (#2988, held below
 * 4.0.0 by #3000) precisely because 3.x permits commercial use **with the
 * watermark and no licence key**. That decision is what let the migration
 * proceed without procurement — so "the watermark actually renders" is the
 * condition the whole position rests on, and until now it had only ever been
 * read off the licence text.
 *
 * Hiding it would be an unlicensed-use finding in a compliance product. The
 * assertion is cheap; discovering it from a vendor is not.
 *
 * ── What a green run here does NOT prove ─────────────────────────────
 *
 * jsdom has no `HTMLCanvasElement.prototype.getContext`, so every measurement
 * tldraw takes from a real canvas is absent. This file answers mount,
 * registration and wiring questions only. Geometry, hit-testing and anything
 * visual belong in Playwright. Said explicitly because a mounted editor
 * invites more trust than this environment has earned.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

// Before the tldraw import, not in a hook: the licence manager reaches for
// `fetch` during module evaluation.
installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import { Tldraw, type Editor } from 'tldraw';

import { ProcessEdgeBindingUtil } from '@/components/processes/tldraw/ProcessEdgeBindingUtil';
import { ProcessNodeShapeUtil } from '@/components/processes/tldraw/ProcessNodeShapeUtil';
import {
    PROCESS_NODE_DEFAULT_H,
    PROCESS_NODE_DEFAULT_W,
    PROCESS_NODE_SHAPE_TYPE,
    nodeKeyFromShapeId,
    shapeIdForNodeKey,
} from '@/components/processes/tldraw/process-node-shape';

/** One row, as the repository hands it back: every optional resolved to null. */
const ROW = {
    nodeKey: 'n1',
    nodeType: 'processStep',
    label: 'Receive invoice',
    subtitle: 'AP team',
    parentNodeKey: null,
    dataJson: null,
};

async function mountEditor(): Promise<{ container: HTMLElement; editor: Editor }> {
    let editor: Editor | undefined;
    let container!: HTMLElement;
    await act(async () => {
        ({ container } = render(
            // tldraw measures its container; jsdom reports zero, which is fine
            // for every claim below but is why nothing here asserts geometry.
            <div style={{ width: 800, height: 600 }}>
                <Tldraw
                    shapeUtils={[ProcessNodeShapeUtil]}
                    bindingUtils={[ProcessEdgeBindingUtil]}
                    onMount={(e) => {
                        editor = e;
                    }}
                />
            </div>,
        ));
    });
    if (!editor) throw new Error('onMount never fired — the editor did not initialise');
    return { container, editor };
}

describe('the editor mounts with our shape layer registered', () => {
    it('finishes initialising rather than sitting in its loading state', async () => {
        const { container } = await mountEditor();
        // `.tl-loading` is present while the store is still coming up, so its
        // ABSENCE is the discriminator — a mounted-but-stuck editor renders
        // plenty of `tl-` nodes and would pass a bare element count.
        expect(container.querySelector('.tl-loading')).toBeNull();
        expect(container.querySelector('.tl-container')).not.toBeNull();
    });

    it('knows our custom shape type', async () => {
        const { editor } = await mountEditor();
        // Registration, not merely "the array was passed": `getShapeUtil`
        // throws for a type the editor has never heard of.
        expect(editor.getShapeUtil(PROCESS_NODE_SHAPE_TYPE)).toBeDefined();
    });

    it('accepts a shape built from a real row, validators and all', async () => {
        const { editor } = await mountEditor();
        const id = shapeIdForNodeKey(ROW.nodeKey);

        // If `processNodeShapeProps` disagreed with this shape — a missing
        // nullable, a number where a string is declared — `createShapes`
        // throws here. That is the failure plain-object unit tests cannot see,
        // because they never run tldraw's validators.
        act(() => {
            editor.createShapes([
                {
                    id: id as never,
                    type: PROCESS_NODE_SHAPE_TYPE,
                    x: 0,
                    y: 0,
                    props: {
                        w: PROCESS_NODE_DEFAULT_W,
                        h: PROCESS_NODE_DEFAULT_H,
                        ...ROW,
                    },
                },
            ]);
        });

        const stored = editor.getShape(id as never);
        expect(stored).toBeDefined();
        expect(stored?.type).toBe(PROCESS_NODE_SHAPE_TYPE);

        // The stored id must resolve BACK to the row's nodeKey, which is what
        // makes the store → rows direction work at all.
        //
        // Deliberately via `nodeKeyFromShapeId` — the INVERSE — and not by
        // comparing against `shapeIdForNodeKey(...)` again. The first draft did
        // the latter and it was a tautology: both sides came from the same
        // function, so mutating it moved expected and actual together and the
        // assertion held. Measured — that mutation left all five tests green.
        expect(nodeKeyFromShapeId(String(stored?.id))).toBe(ROW.nodeKey);
    });

    it('rejects a shape whose props violate the validators', async () => {
        const { editor } = await mountEditor();
        // Teeth for the test above: if creation accepted anything, that test
        // would pass without the validators doing any work. `w` is declared
        // `T.nonZeroNumber`.
        expect(() =>
            editor.createShapes([
                {
                    id: shapeIdForNodeKey('bad') as never,
                    type: PROCESS_NODE_SHAPE_TYPE,
                    x: 0,
                    y: 0,
                    props: { w: 0, h: PROCESS_NODE_DEFAULT_H, ...ROW },
                },
            ]),
        ).toThrow();
    });
});

describe('the watermark — the licence condition 3.x ships under', () => {
    it('renders, with no licence key configured', async () => {
        // #2988 pins ^3.15.6 and #3000 holds dependabot below 4.0.0 because
        // 3.x permits commercial use WITH the watermark and no key. If this
        // ever goes absent, the pin stops being sufficient and that is a
        // licence question, not a UI one.
        const { container } = await mountEditor();
        expect(container.querySelector('[class*="watermark"]')).not.toBeNull();
    });
});
