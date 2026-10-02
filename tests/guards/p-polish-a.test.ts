/**
 * PR-A polish — Structural ratchet for the four micro-polish items
 * shipped together:
 *
 *   1. `connectionMode={ConnectionMode.Loose}` is wired on the
 *      ReactFlow root in `PersistedProcessCanvas`. The xyflow
 *      default is 'strict'; loose mode lets the user retrace a
 *      connection in either direction.
 *   2. `handleInspectorUpdate` no longer uses
 *      `setNodes(prev => prev.map(...))` — it routes through
 *      xyflow v12's `updateNodeData` hook so the render scope
 *      shrinks to the touched node.
 *   3. The `isValidConnection` reject path surfaces a
 *      human-readable reason via `toast.warning(...)`. The
 *      mapping table lives at module scope (`REJECT_MESSAGES`)
 *      so the strings are findable, lintable, and locked here.
 *   4. `computeAutoLayout` accepts an optional `nodeIdsFilter`,
 *      and the canvas exposes `Auto-arrange selection (LR/TB)`
 *      command-palette entries gated on `selectionCount >= 2`.
 *
 * Why structural: each item is a small targeted change across
 * the canvas surface; the natural regression risk is a future
 * refactor silently reverting one ("we don't need loose
 * connections anymore", "let's roll the updateNodeData path
 * back through setNodes for symmetry"). Locking each surface
 * keeps the polish accumulating monotonically.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf-8");

describe("PR-A polish — canvas micro-polish wiring", () => {
    const canvas = () =>
        read("src/components/processes/TldrawProcessWorkspace.tsx");
    const layout = () => read("src/lib/processes/canvas-auto-layout.ts");

    describe("1. Loose connection targeting — NATIVE here", () => {
        /*
            Retired as a record (#3079). `ConnectionMode.Loose` let the user
            start a drag from either end of a handle instead of hitting a
            precise dot — an xyflow configuration flag, and the whole point of
            it was targeting tolerance.

            tldraw gives that natively and more: `arrow-to-edge.ts`'s docblock
            records that `arrowTargetState` carries `snapDistance`, `snap` and
            `precise`, and `HandleSnaps.nearestShape` finds the target. There is
            no flag to set, so there is nothing to assert about setting one.

            What IS worth keeping is that the app did not REPLACE that UX with a
            hand-rolled one — the module's own note is that reimplementing
            proximity would buy tldraw's targeting "for nothing".
        */
        it("the arrow conversion relies on tldraw's own targeting, not a reimplementation", () => {
            const arrow = read("src/components/processes/tldraw/arrow-to-edge.ts");
            // It converts arrows that tldraw ALREADY bound; it does not compute
            // its own nearest-shape or snap distance.
            expect(arrow).toMatch(/getBindingsInvolvingShape\(/);
            expect(arrow).not.toMatch(/snapDistance\s*[:=]\s*\d/);
        });
    });

    describe("2. The inspector write path", () => {
        /*
            Re-pointed. `updateNodeData` was xyflow's targeted-write API, and
            the assertion existed because the ALTERNATIVE — `setNodes` with a
            map over every node — rewrites the whole array to change one field,
            which loses unrelated in-flight state.

            tldraw's equivalent is `editor.updateShape`, which takes one id and
            a partial. The property is the same: write the field, touch nothing
            else. The adapter also marks a history stopping point per commit so
            one inspector edit is one undo, which the xyflow version got from
            its own stack.
        */
        const adapter = () => read("src/lib/processes/use-tldraw-selection.ts");

        it("writes through updateShape, not a whole-collection replace", () => {
            expect(adapter()).toMatch(/editor\.updateShape\(\{\s*id,/);
            expect(adapter()).not.toMatch(/setNodes\(/);
        });

        it("marks ONE history stopping point per inspector commit", () => {
            // So an inspector edit is one undo rather than none or several.
            expect(adapter()).toMatch(
                /editor\.markHistoryStoppingPoint\(\);[\s\S]{0,120}editor\.updateShape\(/,
            );
        });
    });

    describe("3. Reject reason toast", () => {
        /*
            Re-pointed to the tldraw host, where it was wired by #3086 — and
            that wiring is the reason this block is interesting rather than
            mechanical. `TldrawProcessCanvas` had carried an `onEdgeRefused`
            prop since #3067 with nothing supplying it, so every refusal went
            nowhere: the user drew a connector, it quietly stopped being an
            edge, and the only feedback was that it did not look like one.

            The xyflow decisions were copied deliberately: `toast.warning`
            rather than `error` (a refusal is the product working), and ONE
            shared toast id so a run of misclicks collapses into a single
            toast. Both asserted below, because both were nearly lost.
        */
        const host = () => read("src/components/processes/TldrawProcessMap.tsx");

        it("a message table covers every refusal code, as a total map", () => {
            // `Record<EdgeRefusal['code'], string>` makes a missing arm a TYPE
            // error rather than a toast reading "undefined". The tldraw
            // validator refuses FIVE things where xyflow refused three.
            expect(host()).toMatch(
                /Record<EdgeRefusal\[['"]code['"]\],\s*string>/,
            );
            for (const key of ['rejectSelf', 'rejectDuplicate', 'rejectAnnotation',
                               'rejectGroup', 'rejectUnknownNode']) {
                expect(host()).toMatch(new RegExp(`t\\(['"]${key}['"]\\)`));
            }
        });

        it("fires toast.warning with ONE shared id, not an error per misclick", () => {
            expect(host()).toMatch(/toast\.warning\(text,\s*\{\s*id:\s*REFUSAL_TOAST_ID\s*\}\)/);
            expect(host()).toMatch(/REFUSAL_TOAST_ID\s*=\s*['"]canvas-connection-rejected['"]/);
        });

        it("and the canvas actually supplies the channel", () => {
            // The teeth. The prop existed for two PRs with no supplier; a
            // message table nobody calls is the same bug in a new place.
            expect(host()).toMatch(/onEdgeRefused=\{handleEdgeRefused\}/);
        });
    });

    describe("4. Selection-only auto-layout", () => {
        it("computeAutoLayout exposes a fourth `nodeIdsFilter` parameter", () => {
            expect(layout()).toMatch(
                /export function computeAutoLayout\(\s*nodes:[\s\S]*?direction:[\s\S]*?nodeIdsFilter\?:/,
            );
        });
        it("computeAutoLayout preserves the selection centroid", () => {
            // The centroid-translation branch lives inside the
            // `if (nodeIdsFilter && participatingIds.size > 0)`
            // arm. Locking the presence of both the dx/dy
            // computation AND the application loop ensures the
            // translation step can't silently regress.
            const src = layout();
            expect(src).toMatch(/before\.x\s*\/\s*before\.count/);
            expect(src).toMatch(/after\.x\s*\/\s*after\.count/);
            expect(src).toMatch(/positions\[id\]\.x\s*\+\s*dx/);
        });
        it("the host derives the selection filter, and the palette offers both scopes", () => {
            // Re-pointed: `handleAutoLayoutSelection` was an inline callback on
            // the xyflow component. The host takes a `scope` instead and
            // resolves it to `selectedNodeIds(editor)` — the same
            // `nodeIdsFilter` the helper above still accepts, which is why the
            // helper's own assertions are untouched.
            const host = read("src/components/processes/tldraw/auto-layout-host.ts");
            expect(host).toMatch(/scope === ['"]selection['"] \? selectedNodeIds\(editor\) : undefined/);
            const commands = read("src/lib/processes/canvas-command-groups.ts");
            expect(commands).toMatch(/id:\s*['"]arrange-lr['"]/);
            expect(commands).toMatch(/arrange-selection|arrangeForce\(['"]selection['"]\)/);
        });

    });
});
