/**
 * Epic P6-PR-A — Sub-flow drill-down ratchet.
 *
 * Closes the brief's #10 🟡 "Sub-Flow Drill-Down" gap. Pre-P6
 * groups were flat containers; every node lived on the root
 * surface regardless of nesting. Drill-down lets the user
 * double-click a group to enter it; only that group's
 * descendants render, the rest of the graph hides, and a
 * breadcrumb shows where they are.
 *
 * The chain:
 *
 *   1. `useCanvasDrillStack` — navigation hook (push, pop,
 *      reset, Escape-binding).
 *   2. `filterByDrillScope` — pure filter that narrows the
 *      visible nodes + edges to the current scope.
 *   3. `buildDrillBreadcrumbs` — trail builder using the live
 *      nodes for display labels.
 *   4. `<CanvasDrillBreadcrumb>` — renders the trail; hides at
 *      root.
 *   5. `<PersistedProcessCanvas>` — wires it all: filter the
 *      nodes prop, mount the breadcrumb, handle the
 *      `onNodeDoubleClick` enter.
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

describe("Epic P6-PR-A — sub-flow drill-down", () => {
    describe("useCanvasDrillStack hook", () => {
        const src = read("src/lib/processes/use-canvas-drill-stack.ts");

        it("exports the hook with the canonical state shape", () => {
            expect(src).toMatch(
                /export function useCanvasDrillStack\(\):\s*CanvasDrillState/,
            );
            expect(src).toMatch(
                /interface CanvasDrillState \{[\s\S]{0,400}stack:\s*string\[\];[\s\S]{0,200}currentGroupId:\s*string \| null;[\s\S]{0,200}enter:[\s\S]{0,200}exit:[\s\S]{0,200}reset:/,
            );
        });

        it("Escape pops one level via the shared useKeyboardShortcut registry", () => {
            // Direct `document.addEventListener("keydown")` would
            // trip the `keyboard-shortcut-conventions` guardrail
            // — the shared hook is the canonical route.
            expect(src).toMatch(/useKeyboardShortcut\(["']escape["']/);
            expect(src).not.toMatch(
                /document\.addEventListener\(["']keydown["']/,
            );
        });

        it("Escape handler disables at root (stack empty)", () => {
            // The hook's `enabled: stack.length > 0` guard skips
            // the binding so other Escape consumers keep working.
            expect(src).toMatch(/enabled:\s*stack\.length > 0/);
        });
    });

    describe("filterByDrillScope helper", () => {
        const src = read("src/lib/processes/canvas-drill-filter.ts");

        it("exports the canonical signature", () => {
            // GENERIC over the node/edge types, naming no renderer. The
            // function filters and hands the SAME objects back, so a fixed
            // structural return type would strip whatever the caller passed —
            // which is why this is a type parameter and not a `DrillNode[]`.
            // The constraint says what is read; the parameter preserves what
            // came in.
            expect(src).toMatch(
                /export function filterByDrillScope<\s*N extends DrillNode,\s*E extends DrillEdge\s*>\(\s*nodes:\s*N\[\],\s*edges:\s*E\[\],\s*groupId:\s*string \| null,?\s*\):\s*DrillFilterResult<N, E>/,
            );
        });

        it("returns the full graph unchanged at root (groupId === null)", () => {
            // Anchor on the early-return branch — the filter
            // must NOT mutate or copy the root case.
            expect(src).toMatch(
                /if \(groupId === null\)[\s\S]{0,200}return\s*\{\s*visibleNodes:\s*nodes,\s*visibleEdges:\s*edges\s*\}/,
            );
        });

        it("narrows to children whose parentId matches the scope", () => {
            expect(src).toMatch(/parentId === groupId/);
        });

        it("visible edges = both endpoints visible", () => {
            expect(src).toMatch(
                /visibleIds\.has\(e\.source\)\s*&&\s*visibleIds\.has\(e\.target\)/,
            );
        });
    });

    describe("buildDrillBreadcrumbs trail builder", () => {
        const src = read("src/lib/processes/canvas-drill-filter.ts");

        it("starts the trail with a root row + walks the stack", () => {
            expect(src).toMatch(/export function buildDrillBreadcrumbs/);
            // The root row is the first entry — id null, label
            // "All" (or the caller-provided override).
            expect(src).toMatch(/id:\s*null,\s*label:\s*rootLabel/);
            // Each stack entry contributes one breadcrumb row.
            expect(src).toMatch(/for \(const groupId of stack\)/);
        });

        it("falls back to 'Group' when the node has no label", () => {
            expect(src).toMatch(/["']Group["']/);
        });
    });

    describe("CanvasDrillBreadcrumb component", () => {
        const src = read(
            "src/components/processes/CanvasDrillBreadcrumb.tsx",
        );

        it("renders nothing at root (single crumb in trail)", () => {
            expect(src).toMatch(/trail\.length <= 1/);
            expect(src).toMatch(/return null;/);
        });

        it("each crumb gets the canonical testid + depth attribute", () => {
            expect(src).toMatch(/data-testid="canvas-drill-crumb"/);
            expect(src).toMatch(/data-depth=\{idx\}/);
        });

        it("wraps the trail in a nav landmark labelled 'Drill-down trail'", () => {
            // "Drill-down trail" is localized — assert catalog value + key ref.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const en = require('../../messages/en.json');
            expect(en.automation.breadcrumb.trailAria).toBe('Drill-down trail');
            expect(src).toMatch(/aria-label=\{t\("trailAria"\)\}/);
        });
    });

    describe("TldrawProcessWorkspace — wires drill-down end-to-end", () => {
        /*
            ═══ RE-POINTED, AND THE SCOPE MECHANISM IS DIFFERENT (#3079) ═══

            The CAPABILITY is intact and the hook and breadcrumb are literally
            the same modules — both are engine-free and were reused rather than
            ported, which is also what preserved Escape-pops-a-level.

            What changed is how the scope reaches the canvas, and the difference
            is worth stating because the xyflow version is not expressible here.
            There, `filterByDrillScope(...).visibleNodes` was handed to the
            `nodes` prop: the renderer was given a filtered ARRAY. tldraw has no
            such prop — the store IS the document — so filtering the input would
            mean deleting shapes. The scope is applied through
            `getShapeVisibility` instead, which hides without removing.

            That distinction is load-bearing and asserted on its own below: a
            canvas that filtered its store would make drilling in and
            autosaving delete every node outside the group.

            The enter gesture also moved layer: the canvas owns it (it has to
            hit-test, because `TLClickEventInfo` carries no shape) and reports
            upward, so the workspace supplies `onEnterGroup` rather than
            handling a double-click itself.
        */
        const src = read("src/components/processes/TldrawProcessWorkspace.tsx");
        const canvas = read("src/components/processes/TldrawProcessCanvas.tsx");

        it("imports the hook + helpers + breadcrumb", () => {
            // `@/` alias rather than a relative path — house style on this host.
            expect(src).toMatch(
                /import\s*\{\s*CanvasDrillBreadcrumb\s*\}\s*from\s*["']@\/components\/processes\/CanvasDrillBreadcrumb["']/,
            );
            expect(src).toMatch(
                /import\s*\{\s*useCanvasDrillStack\s*\}\s*from\s*["']@\/lib\/processes\/use-canvas-drill-stack["']/,
            );
            // `drillTrail` wraps `buildDrillBreadcrumbs` with the editor's own
            // node list, so the workspace imports the wrapper. The pure builder
            // is still asserted directly in the describes above.
            expect(src).toMatch(
                /import\s*\{\s*drillTrail\s*\}\s*from\s*["']@\/components\/processes\/tldraw\/drill-scope-host["']/,
            );
        });

        it("uses the hook and threads currentGroupId to the canvas", () => {
            expect(src).toMatch(/const drill = useCanvasDrillStack\(\)/);
            expect(src).toMatch(/drillGroupId=\{drill\.currentGroupId\}/);
            expect(src).toMatch(/onEnterGroup=\{drill\.enter\}/);
        });

        it("scopes by HIDING, never by filtering the store", () => {
            /*
                The assertion that replaces "threads currentGroupId into the
                ReactFlow nodes prop", and the one that matters most.

                tldraw's store is the document, so a host that filtered its
                shapes to the drill scope would make drilling in and
                autosaving DELETE every node outside the group. The scope is a
                visibility predicate instead.
            */
            expect(canvas).toMatch(/getShapeVisibility=\{getShapeVisibility\}/);
            expect(canvas).toMatch(/shapeVisibilityForScope\(/);
        });

        it("double-clicking a group node enters the drill", () => {
            // On the CANVAS, which is where the gesture can hit-test — the
            // event carries no shape. Gated to `nodeType === 'group'`, because
            // double-clicking a step is how tldraw starts label editing.
            expect(canvas).toMatch(/nodeType !== ['"]group['"]/);
            expect(canvas).toMatch(/onEnterGroupRef\.current\?\./);
        });

        it("mounts the breadcrumb with the canonical trail builder", () => {
            expect(src).toMatch(
                /<CanvasDrillBreadcrumb[\s\S]{0,200}trail=\{editor \? drillTrail\(editor, drill\.stack\) : \[\]\}/,
            );
        });

        it("breadcrumb jump truncates the stack to the target depth", () => {
            // Unchanged arithmetic, deliberately: depth 0 resets, deeper pops
            // `stack.length - depth`. Same expression as the xyflow host had,
            // so if it is wrong it is wrong in one place.
            expect(src).toMatch(/depth === 0[\s\S]{0,100}drill\.reset\(\)/);
            expect(src).toMatch(/drill\.stack\.length - depth/);
        });
    });
});
