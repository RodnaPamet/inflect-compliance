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
import { codeOf } from '../helpers/source-blocks';

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
            expect(src).toMatch(
                /export function computeAutoLayout\(\s*nodes:\s*Node\[\],\s*edges:\s*Edge\[\],\s*direction:\s*AutoLayoutDirection,\s*nodeIdsFilter\?:\s*ReadonlySet<string>,?\s*\):\s*AutoLayoutResult/,
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
            expect(src).toMatch(/continue;/);
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

    describe("PersistedProcessCanvas — handler + command-palette wire", () => {
        const src = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );

        it("imports the helper + the type", () => {
            expect(src).toMatch(
                /import\s*\{[\s\S]{0,300}computeAutoLayout[\s\S]{0,200}AutoLayoutDirection[\s\S]{0,100}\}\s*from\s*["']@\/lib\/processes\/canvas-auto-layout["']/,
            );
        });

        it("declares handleAutoLayout with history push + autosave mark", () => {
            // The handler MUST push the current layout to history
            // before mutating so undo restores the hand-placed
            // positions. Mark dirty so autosave fires.
            expect(src).toMatch(
                /const handleAutoLayout\s*=\s*useCallback\([\s\S]{0,1000}history\.push\(\{\s*nodes,\s*edges\s*\}\)[\s\S]{0,400}computeAutoLayout\(nodes,\s*edges,\s*direction\)[\s\S]{0,400}autosave\.markDirty\(\)/,
            );
        });

        it("applies positions via setNodes preserving every other field", () => {
            // The spread {...n, position} pattern preserves data,
            // selected, style, etc. A refactor that returns a fresh
            // node would drop those.
            expect(src).toMatch(
                /positions\[n\.id\]\s*\?\s*\{\s*\.\.\.n,\s*position:\s*positions\[n\.id\]\s*\}/,
            );
        });

        it("emits node.move so the change-event consumers see the layout swap", () => {
            expect(src).toMatch(
                /changeEmitter\.emit\(["']node\.move["'][\s\S]{0,300}Object\.keys\(positions\)/,
            );
        });

        it("the command palette has a Layout group with both directions", () => {
            // The palette group heading is localized.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const en = require('../../messages/en.json');
            expect(en.automation.canvas.groupLayout).toBe('Layout');
            expect(src).toMatch(/heading:\s*t\("groupLayout"\)/);
            expect(src).toMatch(/id:\s*["']arrange-lr["']/);
            expect(src).toMatch(/id:\s*["']arrange-tb["']/);
            expect(src).toMatch(/handleAutoLayout\(["']LR["']\)/);
            expect(src).toMatch(/handleAutoLayout\(["']TB["']\)/);
        });

        it("commands disable when no nodes / canvas is busy", () => {
            // Empty canvas shouldn't offer the command; saving/
            // loading shouldn't either.
            expect(src).toMatch(
                /disabled:\s*nodes\.length === 0 \|\| saving \|\| loading/,
            );
        });
    });
});
