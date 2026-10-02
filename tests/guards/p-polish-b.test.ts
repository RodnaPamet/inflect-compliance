/**
 * PR-B polish — Structural ratchet for the two items shipped:
 *
 *   1. Copy canvas as image to clipboard via `ClipboardItem`.
 *      Helper at `src/lib/processes/canvas-export.ts`; menu item
 *      at `src/components/processes/TldrawCanvasExportMenu.tsx`.
 *   2. Collapsible group nodes — chevron toggle in the group's
 *      title sticker flips `data.collapsed`, shrinks the xyflow
 *      bbox to `COLLAPSED_GROUP_W/H`, and sets `hidden: true` on
 *      every descendant. Renderer at
 *      `src/components/processes/ProcessTypedNode.tsx`.
 *
 * Why structural: the clipboard path is a one-call surface but
 * easy to silently drop ("we don't need the menu item, the toast
 * is enough"); the group toggle is split across three concerns
 * (xyflow setNodes, descendant walk, style flip) that a future
 * refactor could reduce to "just flip the data flag" without the
 * geometry + hidden cascade.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf-8");

describe("PR-B polish — clipboard copy + collapsible groups", () => {
    describe("1. Clipboard copy", () => {
        const helper = () => read("src/lib/processes/tldraw-canvas-export.ts");
        /**
         * The engine-free half. `canCopyImageToClipboard` lives here because it
         * is a browser feature check, and because both export menus need it —
         * reading it out of the xyflow module was the last thing that made
         * `canvas-export.ts` load-bearing for the tldraw canvas.
         */
        const sharedHelper = () =>
            read("src/lib/processes/canvas-export-shared.ts");
        const menu = () =>
            read("src/components/processes/TldrawCanvasExportMenu.tsx");

        it("exports copyTldrawCanvasToClipboard from canvas-export", () => {
            expect(helper()).toMatch(
                /export async function copyTldrawCanvasToClipboard/,
            );
        });

        it("uses navigator.clipboard.write + ClipboardItem", () => {
            const src = helper();
            expect(src).toMatch(/navigator\.clipboard\.write\(\[/);
            // Quote-agnostic: the two eras ship different prettier configs, and a
            // guard that pins a quote style is pinning formatting, not behaviour.
            expect(src).toMatch(/new ClipboardItem\(\{[\s\S]{0,40}['"]image\/png['"]/);
        });

        it("feature-detects clipboard support (throws on unsupported)", () => {
            // Guarding `navigator.clipboard?.write` AND
            // `typeof ClipboardItem === ["\']undefined["\']` catches both
            // older Safari and Firefox builds.
            const src = helper();
            expect(src).toMatch(/navigator\.clipboard\?\.write/);
            expect(src).toMatch(/typeof ClipboardItem === ["\']undefined["\']/);
        });

        it("exports canCopyImageToClipboard for the menu's visibility gate", () => {
            // Reads the SHARED module, not the xyflow one. The function moved
            // there because it is a browser feature check with no engine in it,
            // and because the tldraw export menu imported it across that seam —
            // the last thing making `canvas-export.ts` load-bearing for the new
            // canvas. The assertion is the same; only its subject moved.
            expect(sharedHelper()).toMatch(
                /export function canCopyImageToClipboard\(\)/,
            );
        });

        it("TldrawCanvasExportMenu wires the new item gated by canCopyImageToClipboard", () => {
            const src = menu();
            expect(src).toMatch(/canCopyImageToClipboard/);
            expect(src).toMatch(/copyTldrawCanvasToClipboard/);
            expect(src).toMatch(/data-testid="tldraw-export-clipboard"/);
            // Localised via next-intl — assert the key wiring + the
            // English catalog value rather than the inline literal.
            expect(src).toMatch(/t\(['"]copyAsImage['"]\)/);
            const en = require("../../messages/en.json");
            expect(en.automation.exportMenu.copyAsImage).toBe("Copy as image");
            // The menu's `run` callback must handle the new "clipboard" kind
            // alongside the existing four. On this host the union is a NAMED
            // type rather than an inline annotation, and quoted with single
            // quotes — so the needle matches the alias and is quote-agnostic.
            // Pinning either detail would be pinning formatting.
            expect(src).toMatch(
                /type TldrawExportKind\s*=\s*['"]png['"]\s*\|\s*['"]svg['"]\s*\|\s*['"]pdf['"]\s*\|\s*['"]evidence['"]\s*\|\s*['"]clipboard['"]/,
            );
        });

        it("clipboard run path emits a success toast", () => {
            const src = menu();
            // Find the clipboard branch within `run(...)` and scope
            // to it via the NEXT `else if` (the PDF branch is the
            // structural neighbour and won't move under it).
            // Located by regex rather than `indexOf` of a quoted literal: the
            // two hosts quote differently, and an `indexOf` that misses
            // returns -1, which the `toBeGreaterThan(-1)` below would catch —
            // but only after the slice had already been taken from 0.
            const startMatch = /kind === ['"]clipboard['"]/.exec(src);
            expect(startMatch).not.toBeNull();
            const start = startMatch!.index;
            const endMatch = /else if \(kind === ['"]pdf['"]/.exec(src.slice(start));
            expect(endMatch).not.toBeNull();
            const body = src.slice(start, start + endMatch!.index);
            expect(body).toMatch(/copyTldrawCanvasToClipboard\(/);
            expect(body).toMatch(/toast\.success/);
        });
    });

    describe("2. Collapsible groups — RETIRED, on the record", () => {
        /*
            ═══ WHY THIS IS SIX ASSERTIONS REPLACED BY ONE ═══

            Collapsible group nodes lived entirely in `ProcessTypedNode.tsx` —
            `GroupNodeChrome`, a chevron toggle, `COLLAPSED_GROUP_W/H`, and a
            handler that shrank the node and flipped its descendants' `hidden`
            flags. None of it ported to the tldraw node shape.

            Retired rather than deleted, for the reason `vr5-chain-edges` gives
            at length: this epic's sibling guards exist BECAUSE features here
            have been dead code before, and silence is how that recurs.

            ═══ THREE MEASUREMENTS, AND THE THIRD IS THE ONE THAT MATTERS ═══

            1. It was NEVER PERSISTED. The xyflow renderer's own comment says
               "the save serialiser intentionally drops `collapsed`" — so this
               was session-only view state by design, not data. Nothing stored
               is being hidden by its absence.

            2. Production has **0 group nodes** (5 ProcessNode rows, none of
               type `group`). Collapse had nothing to collapse.

            3. The NEED it served is ported, differently and arguably better.
               #3085 and #3088 shipped drill-down: double-clicking a group
               scopes the canvas to that group's children and a breadcrumb
               shows the trail. Collapsing hid a group's contents in place;
               drilling in shows only them. Both answer "this sub-process is
               cluttering the map", and the tldraw host answers it.

            ═══ WHAT WOULD HAVE TO CHANGE ═══

            A user wanting a group's contents hidden WITHOUT leaving the
            top-level view — collapse and drill-down are not the same gesture,
            and the first group node in production is when the difference stops
            being theoretical. At that point reach for `getShapeVisibility`,
            which already filters by scope for the drill-down.
        */
        const nodeUtil = () =>
            read("src/components/processes/tldraw/ProcessNodeShapeUtil.tsx");

        it("is absent from the tldraw node shape, and the successor gesture is present", () => {
            // The absence, asserted so it cannot drift into "somebody probably
            // did it".
            expect(nodeUtil()).not.toMatch(/GroupNodeChrome/);
            expect(nodeUtil()).not.toMatch(/data\.collapsed/);
            // And the replacement capability, so this is a substitution on the
            // record rather than a hole. Drill-down is a canvas-level scope
            // filter, not node chrome, which is why it lives elsewhere.
            const canvas = read("src/components/processes/TldrawProcessCanvas.tsx");
            expect(canvas).toMatch(/getShapeVisibility=\{getShapeVisibility\}/);
            expect(canvas).toMatch(/onEnterGroup/);
        });
    });
});
