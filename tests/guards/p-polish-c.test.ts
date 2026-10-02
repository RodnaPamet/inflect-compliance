/**
 * PR-C polish — Structural ratchet for force-directed layout via
 * elkjs. Locks the wiring across three concerns:
 *
 *   1. Dependency. `elkjs` is in `package.json` `dependencies`
 *      (not devDependencies — the layout runs in the browser).
 *   2. Helper. `computeForceLayout(nodes, edges, nodeIdsFilter?)`
 *      lives in `canvas-auto-layout.ts`, dynamically imports
 *      `elkjs/lib/elk.bundled.js` (so the ~600KB bundle ships
 *      only when used), and routes through the shared
 *      `finaliseSubsetPositions` helper for centroid preservation.
 *   3. Wire. The canvas exposes `handleAutoLayoutForce(selectionOnly)`
 *      and two new command-palette entries
 *      ("arrange-force" / "arrange-force-selection").
 *
 * Why structural: ELK is an async dependency added in one PR.
 * A future refactor could silently revert any link (drop the dep,
 * inline-import the bundle, drop the menu entry) without breaking
 * surface behaviour at first glance.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf-8");

describe("PR-C polish — force-directed layout via elkjs", () => {
    describe("1. Dependency", () => {
        it("elkjs is in production dependencies (not devDependencies)", () => {
            const pkg = JSON.parse(read("package.json")) as {
                dependencies: Record<string, string>;
                devDependencies: Record<string, string>;
            };
            expect(pkg.dependencies.elkjs).toBeDefined();
            expect(pkg.devDependencies?.elkjs).toBeUndefined();
        });
    });

    describe("2. Helper", () => {
        const src = () => read("src/lib/processes/canvas-auto-layout.ts");

        it("exports computeForceLayout as an async function", () => {
        // The parameter types are STRUCTURAL (`LayoutNode` / `LayoutEdge`),
        // deliberately naming no engine. This module is pure graph layout and
        // read only six fields; taking `Node[]` from `@xyflow/react` meant
        // phase 4 would have deleted auto-layout along with the renderer, and
        // tldraw has no equivalent. xyflow's own `Node` / `Edge` remain
        // assignable, which is why every behavioural suite here passed
        // unchanged across the port.
            expect(src()).toMatch(
                /export async function computeForceLayout\(\s*nodes:\s*readonly LayoutNode\[\],\s*edges:\s*readonly LayoutEdge\[\],\s*nodeIdsFilter\?:\s*ReadonlySet<string>,?\s*\):\s*Promise<AutoLayoutResult>/,
            );
        });

        it("dynamically imports elkjs to keep the static bundle slim", () => {
            // Static `import ... from "elkjs"` would put the ~600KB
            // bundle in the initial chunk; the dynamic `await
            // import(...)` defers it.
            expect(src()).toMatch(
                /await import\("elkjs\/lib\/elk\.bundled\.js"\)/,
            );
            expect(src()).not.toMatch(
                /^import [^{]*from "elkjs"/m,
            );
        });

        it("uses ELK's force algorithm with the documented iteration count", () => {
            const s = src();
            expect(s).toMatch(/"elk\.algorithm":\s*"force"/);
            expect(s).toMatch(/"elk\.force\.iterations":/);
        });

        it("routes through finaliseSubsetPositions for centroid preservation", () => {
            // Both `computeAutoLayout` AND `computeForceLayout`
            // should call the same helper so selection-only mode
            // behaves identically across the two engines.
            const s = src();
            expect(s).toMatch(/function finaliseSubsetPositions\b/);
            // Two call sites — once from dagre, once from force.
            const calls = s.match(/finaliseSubsetPositions\(/g) ?? [];
            expect(calls.length).toBeGreaterThanOrEqual(3); // 1 decl + 2 calls
        });

        it("skips annotation nodes (parity with dagre)", () => {
            // The same convention the dagre helper holds — floating
            // tags don't participate in flow algorithms.
            const s = src();
            const forceStart = s.indexOf("export async function computeForceLayout");
            expect(forceStart).toBeGreaterThan(-1);
            const forceBody = s.slice(forceStart);
            expect(forceBody).toMatch(/kind === "annotation"/);
            expect(forceBody).toMatch(/continue;/);
        });
    });

    describe("3. Force-layout host + palette wire", () => {
        /*
            Re-pointed (#3079). The elkjs helper above is untouched — it lives
            in `canvas-auto-layout.ts`, which survived because it imports dagre
            and elk, not xyflow.

            The wire moved the same way auto-layout's did (see
            `p4a-auto-layout-dagre.test.ts` for the full note): the host module
            applies, the command builder declares, the workspace supplies the
            action. `handleAutoLayoutForce` as an inline `useCallback` is gone
            with the component that declared it.

            The ORDERING invariant the third assertion protected is the one
            worth carrying across, and it is kept below: the await must complete
            before anything is written, or a slow layout leaves the canvas half
            moved. Asserted structurally now rather than by comparing two
            `indexOf` results — the host awaits into a destructured result and
            then writes, so there is no window in which a partial apply is
            expressible.
        */
        const host = () => read("src/components/processes/tldraw/auto-layout-host.ts");
        const commands = () => read("src/lib/processes/canvas-command-groups.ts");
        const workspace = () =>
            read("src/components/processes/TldrawProcessWorkspace.tsx");

        it("the host imports computeForceLayout alongside computeAutoLayout", () => {
            expect(host()).toMatch(
                /import\s*\{[\s\S]*?\bcomputeAutoLayout\b[\s\S]*?\bcomputeForceLayout\b[\s\S]*?\}\s*from\s*['"]@\/lib\/processes\/canvas-auto-layout['"]/,
            );
        });

        it("runForceLayout is async, because elk is", () => {
            expect(host()).toMatch(/export async function runForceLayout\(/);
        });

        it("AWAITS the layout before applying any position", () => {
            // The ordering invariant, preserved. A write that started before
            // the await resolved would leave the canvas half-moved — and elk
            // is the slow path, so the window would be real rather than
            // theoretical.
            const h = host();
            const awaitIdx = h.indexOf('await computeForceLayout');
            const applyIdx = h.indexOf('applyLayout', awaitIdx);
            expect(awaitIdx).toBeGreaterThan(-1);
            expect(applyIdx).toBeGreaterThan(awaitIdx);
        });

        it("the command palette has both force-layout entries", () => {
            const c = commands();
            expect(c).toMatch(/id:\s*['"]arrange-force['"]/);
            expect(c).toMatch(/id:\s*['"]arrange-force-selection['"]/);
            expect(c).toMatch(/actions\.arrangeForce\(['"]all['"]\)/);
            expect(c).toMatch(/actions\.arrangeForce\(['"]selection['"]\)/);
            // The selection variant must require 2+ selected — arranging one
            // node against itself is a no-op the palette should not offer.
            const sel = c.match(
                /id:\s*['"]arrange-force-selection['"][\s\S]{0,400}?onSelect:[\s\S]{0,120}/,
            );
            expect(sel).not.toBeNull();
            expect(c).toMatch(/selectionCount < 2|arrangeSelectionDisabled/);
        });

        it("and the workspace supplies the action", () => {
            // Teeth: the builder omits a command whose action is absent, so an
            // unwired `arrangeForce` would silently remove both entries.
            expect(workspace()).toMatch(/arrangeForce:\s*\(scope\)\s*=>/);
            expect(workspace()).toMatch(/runForceLayout\(editor,\s*scope\)/);
        });
    });
});
