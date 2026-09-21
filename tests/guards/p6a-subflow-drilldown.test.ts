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
            expect(src).toMatch(
                /export function filterByDrillScope\(\s*nodes:\s*Node\[\],\s*edges:\s*Edge\[\],\s*groupId:\s*string \| null,?\s*\):\s*DrillFilterResult/,
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

    describe("PersistedProcessCanvas — wires drill-down end-to-end", () => {
        const src = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );

        it("imports the hook + helpers + breadcrumb", () => {
            expect(src).toMatch(
                /import\s*\{\s*CanvasDrillBreadcrumb\s*\}\s*from\s*["']\.\/CanvasDrillBreadcrumb["']/,
            );
            expect(src).toMatch(
                /import\s*\{\s*useCanvasDrillStack\s*\}\s*from\s*["']@\/lib\/processes\/use-canvas-drill-stack["']/,
            );
            expect(src).toMatch(
                /import\s*\{[\s\S]{0,200}buildDrillBreadcrumbs[\s\S]{0,200}filterByDrillScope[\s\S]{0,100}\}\s*from\s*["']@\/lib\/processes\/canvas-drill-filter["']/,
            );
        });

        it("uses the hook + threads currentGroupId into the ReactFlow nodes prop", () => {
            expect(src).toMatch(/const drill = useCanvasDrillStack\(\)/);
            // The nodes prop branches on currentGroupId.
            expect(src).toMatch(
                /drill\.currentGroupId\s*\?\s*filterByDrillScope\(\s*nodes,\s*edges,\s*drill\.currentGroupId,?\s*\)\.visibleNodes/,
            );
        });

        it("double-clicking a group node enters the drill", () => {
            // The handler reads node.data.kind; only group nodes
            // trigger drill.enter().
            expect(src).toMatch(
                /onNodeDoubleClick=\{[\s\S]{0,400}kind === ["']group["'][\s\S]{0,200}drill\.enter\(node\.id\)/,
            );
        });

        it("mounts the breadcrumb with the canonical trail builder", () => {
            expect(src).toMatch(
                /<CanvasDrillBreadcrumb[\s\S]{0,400}trail=\{buildDrillBreadcrumbs\(drill\.stack,\s*nodes\)\}/,
            );
        });

        it("breadcrumb jump truncates the stack to the target depth", () => {
            // Depth 0 → reset to root; deeper → pop until length
            // === depth.
            expect(src).toMatch(/depth === 0[\s\S]{0,100}drill\.reset\(\)/);
            expect(src).toMatch(/drill\.stack\.length - depth/);
        });
    });
});
