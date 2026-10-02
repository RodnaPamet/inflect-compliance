/**
 * Epic P4-PR-A — Canvas auto-layout (dagre) ratchet.
 *
 * Closes the brief's #1 🟠 "Auto-Layout Engine" gap. Pre-P4
 * authors had to manually position every node; a 20-node map is
 * hours of drag-and-align. Auto-layout snaps every node into a
 * hierarchical layout in one click.
 *
 * The chain locked here:
 *
 *   1. `src/lib/processes/canvas-auto-layout.ts` — pure helper.
 *      Takes nodes + edges + direction, returns new positions.
 *      Dagre is the canonical xyflow recommendation; hierarchical
 *      layouts (LR / TB) cover ≥90% of compliance use cases.
 *   2. `<PersistedProcessCanvas>` — `handleAutoLayout(direction)`
 *      pushes history, calls the helper, applies positions,
 *      marks autosave dirty.
 *   3. CanvasCommandPalette — two commands ("Arrange LR" and
 *      "Arrange TB") under a new "Layout" group.
 *
 * Each link has the others as backstops. If one breaks the
 * ratchet catches it before reviewers do.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// Every path this file READS is a TypeScript-alike: the `.json` it touches
// arrives through `require()`, which is a module import, not a text read — so
// it never reaches this seam and needs no separate reader.
import { codeOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), "utf8"));

describe("Epic P4-PR-A — canvas auto-layout (dagre)", () => {
    describe("Auto-layout helper module", () => {
        const src = read("src/lib/processes/canvas-auto-layout.ts");

        it("exports computeAutoLayout with the canonical signature", () => {
            // PR-A polish added an optional 4th parameter
            // (`nodeIdsFilter`) for selection-only auto-arrange.
            // The first three positional params stay required +
            // ordered; the 4th is opt-in via `?:` so legacy callers
            // keep compiling. Locked by p-polish-a too.
        // The parameter types are STRUCTURAL (`LayoutNode` / `LayoutEdge`),
        // deliberately naming no engine. This module is pure graph layout and
        // read only six fields; taking `Node[]` from `@xyflow/react` meant
        // phase 4 would have deleted auto-layout along with the renderer, and
        // tldraw has no equivalent. xyflow's own `Node` / `Edge` remain
        // assignable, which is why every behavioural suite here passed
        // unchanged across the port.
            expect(src).toMatch(
                /export function computeAutoLayout\(\s*nodes:\s*readonly LayoutNode\[\],\s*edges:\s*readonly LayoutEdge\[\],\s*direction:\s*AutoLayoutDirection,\s*nodeIdsFilter\?:\s*ReadonlySet<string>,?\s*\):\s*AutoLayoutResult/,
            );
        });

        it("exports AutoLayoutDirection as the two canonical values", () => {
            // LR + TB are the two we ship in P4-PR-A; future
            // additions (organic / BT / RL) should bump the
            // ratchet deliberately.
            expect(src).toMatch(
                /export type AutoLayoutDirection = ["']LR["']\s*\|\s*["']TB["']/,
            );
        });

        it("imports dagre from @dagrejs/dagre (xyflow recommendation)", () => {
            expect(src).toMatch(
                /import dagre from ["']@dagrejs\/dagre["']/,
            );
        });

        it("skips annotation nodes (floating tags, not part of flow)", () => {
            // Annotation nodes are floating callouts that don't
            // participate in the flow direction; they should
            // keep their hand-placed positions across layouts.
            expect(src).toMatch(/kind === ["']annotation["']/);
            // `/continue;/` matched SEVEN places in that module — every
            // loop guard in it. The test is named for the ANNOTATION skip,
            // so it names that condition now. Not my regression, but it is
            // in a file this diff rewrites and the fix is one line.
            expect(src).toMatch(/if \(kind === "annotation"\) continue;/);
        });

        it("converts dagre's centre coords to xyflow's top-left coords", () => {
            // dagre returns center positions; xyflow places nodes
            // by top-left. The half-width / half-height shift is
            // the canonical conversion — anchor it so a refactor
            // that drops it places every node 110px off.
            expect(src).toMatch(/pos\.x\s*-\s*w\s*\/\s*2/);
            expect(src).toMatch(/pos\.y\s*-\s*h\s*\/\s*2/);
        });

        it("returns positions keyed by xyflow node id", () => {
            expect(src).toMatch(
                /positions:\s*Record<string,\s*\{\s*x:\s*number;\s*y:\s*number\s*\}>/,
            );
        });
    });

    describe("Auto-layout host + command-palette wire", () => {
        /*
            ═══ RE-POINTED, AND THE HANDLER IS NO LONGER IN A COMPONENT (#3079) ═══

            `canvas-auto-layout.ts` itself is untouched and its six assertions
            above still pass: it survived the cutover because it imports DAGRE,
            not xyflow (#3063 de-coupled it precisely so this deletion would not
            take auto-layout with it). It is also still the only importer of
            `@dagrejs/dagre`, so that dependency stays too.

            What moved is the WIRE. The xyflow host declared `handleAutoLayout`
            inline, pushed to its own history stack, called `setNodes`, and
            emitted a `node.move` change event. On tldraw that is three separate
            places: `auto-layout-host.ts` applies, `canvas-command-groups.ts`
            declares the commands, and the workspace supplies the action. Each
            assertion below goes to whichever of the three now owns it.

            Two of the original five are RETIRED rather than moved, and both for
            the same reason — the mechanism they pinned does not exist here:

              • `history.push({ nodes, edges })` — the app kept its own undo
                stack for xyflow. tldraw owns history natively, and
                `use-canvas-history.ts` was deleted as superseded rather than
                ported, because two stacks would disagree about what an undo is.
              • `changeEmitter.emit("node.move")` — `canvas-change-events.ts`
                had ZERO subscribers (its own docblock said autosave "still
                lives on its own markDirty channel"), so this emitted into
                nothing. Deleting it removed a seam, not a feature.
        */
        const host = read("src/components/processes/tldraw/auto-layout-host.ts");
        const commands = read("src/lib/processes/canvas-command-groups.ts");
        const workspace = read("src/components/processes/TldrawProcessWorkspace.tsx");

        it("the host imports the helper + the type", () => {
            expect(host).toMatch(
                /import\s*\{[\s\S]{0,300}computeAutoLayout[\s\S]{0,300}\}\s*from\s*["']@\/lib\/processes\/canvas-auto-layout["']/,
            );
        });

        it("applies positions in ONE updateShapes call, not a loop", () => {
            /*
                Replaces "applies positions via setNodes preserving every other
                field". The property the original protected was that a layout
                must not drop a node's other state — xyflow's `{...n, position}`
                spread. tldraw's `updateShapes` takes a partial per shape, so
                every unmentioned field is preserved by the API rather than by
                the caller remembering to spread.

                What IS worth pinning here is the batching: the host's own
                comment says a thirty-node layout as thirty `updateShape` calls
                is thirty store transactions and thirty renders.
            */
            // Bound to `applyLayout`, the one function that writes positions —
            // a whole-file read cannot say WHICH construct batches, and the
            // Class D ratchet counts it as un-analysable for that reason.
            expect(functionBodyOf(host, "applyLayout")).toMatch(/editor\.updateShapes\(/);
            expect(host).not.toMatch(/for\s*\([\s\S]{0,80}editor\.updateShape\(/);
        });

        it("the command palette has a Layout group with both directions", () => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const en = require('../../messages/en.json');
            expect(en.automation.canvas.groupLayout).toBe('Layout');
            expect(commands).toMatch(/heading:\s*t\(['"]groupLayout['"]\)/);
            expect(commands).toMatch(/id:\s*['"]arrange-lr['"]/);
            expect(commands).toMatch(/id:\s*['"]arrange-tb['"]/);
        });

        it("and the workspace supplies the action the commands call", () => {
            // The teeth for the group above: a palette that declared the
            // commands while nothing wired `arrange` would render two entries
            // that do nothing. The builder omits a command whose action is
            // absent, so the absence would be SILENT — which is exactly the
            // "reachable from nothing" failure this epic family keeps hitting.
            expect(workspace).toMatch(/arrange:\s*\(direction,\s*scope\)\s*=>/);
            expect(workspace).toMatch(/runAutoLayout\(editor,\s*direction,\s*scope\)/);
        });

        it("commands disable when there are no nodes to arrange", () => {
            // Same property, different source of truth: the xyflow host read
            // its own `nodes.length === 0 || saving || loading`, and the
            // builder takes a context object instead — so the condition is
            // asserted where it is now expressed.
            expect(commands).toMatch(/disabled:\s*noNodes/);
            expect(commands).toMatch(/const noNodes\s*=/);
        });
    });
});
