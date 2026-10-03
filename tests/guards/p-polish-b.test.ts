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

import { codeOf } from "../helpers/source-blocks";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
/*
    MASKED AT THE READ SEAM — #2246 Class A, applied when #3079 re-pointed this
    file onto the tldraw hosts.

    These reads were raw. That was survivable while the subject was one
    2500-line component nobody was editing; it is not survivable now, because
    the surviving modules carry long explanatory docblocks — several of which
    name the very symbols these assertions match. On a raw read "delete the code,
    keep the note explaining it" is a green diff, and on a `.not.toMatch` the
    mirror image: a comment mentioning a forbidden token fails a guard whose
    code is fine.

    At the SEAM rather than per assertion, so a new `expect(read(...))` inherits
    it. String literals are KEPT — masking them would silently empty assertions
    that harvest testids and i18n keys from source.
*/
const read = (p: string) => codeOf(readFileSync(path.join(ROOT, p), "utf-8"));

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
            flags. None of it ported to the tldraw node shape — until #3117.

            ═══ A RETIREMENT, REVERSED BY THE OWNER (2026-10-02) ═══

            This asserted the ABSENCE on three measurements, and the honest part
            is that all three were TRUE and two of them still are:

            1. It was NEVER PERSISTED. The xyflow renderer's own comment says
               "the save serialiser intentionally drops `collapsed`" — session
               view state by design. Still true of xyflow, and it is why #3117
               was larger than a port: the persistence half had to be built, not
               moved.

            2. Production has **0 group nodes**. Still true.

            3. The need was arguably served by drill-down (#3085, #3088).

            The owner decided to port it anyway, after VR-5 (#3112) and VR-6
            (#3123). Measurement 3 is the one that bent: collapse and drill-down
            are NOT the same gesture, which this text already said — drilling in
            leaves the top-level view, collapse hides a group in place — and the
            old note named the first group node as when that stops being
            theoretical. An owner decision got there first.

            ═══ IT TOOK THE ROUTE THIS NOTE PREDICTED ═══

            "At that point reach for `getShapeVisibility`, which already filters
            by scope for the drill-down." That is exactly what happened, with one
            thing the prediction missed: collapse cannot be expressed THROUGH the
            drill scope. `visibleNodeKeys` returns null at root meaning "no
            filtering", and a fold's main case is at root; returning a set there
            would have switched the predicate out of its null fast path, which is
            what keeps stickies and frames visible. So folding one group at root
            would have hidden every annotation on the map. Two independent
            reasons to hide need two inputs — `collapsedHiddenKeys` carries the
            second, and `drill-scope-host.ts` says so at length.
        */
        const nodeUtil = () =>
            read("src/components/processes/tldraw/ProcessNodeShapeUtil.tsx");

        it("is PORTED to the tldraw node shape, and drill-down still coexists", () => {
            const util = nodeUtil();
            const host = read("src/components/processes/tldraw/drill-scope-host.ts");
            const canvas = read("src/components/processes/TldrawProcessCanvas.tsx");

            // The affordance, and the state it reads. Not `GroupNodeChrome` —
            // that was xyflow's component, and the collapsed group's shrunken
            // footprint is deliberately NOT ported: the tldraw node renders at a
            // fixed size it does not read from the row (#2961), so a smaller
            // folded box would be a second renderer decision with nowhere to
            // persist its geometry.
            // Bounded with the paren (#2728): an unbounded declaration needle
            // also matches `GroupFoldToggleWrapper`, so it names a declaration
            // without saying where it ends.
            expect(util).toMatch(/function GroupFoldToggle\(/);
            expect(util).toMatch(/isCollapsedFromDataJson\(/);
            // `dataJson.collapsed`, NOT xyflow's `data.collapsed` — a different
            // path on a different engine, and the old needle would have passed
            // against the new code while naming nothing.
            expect(host).toMatch(/collapsed\?:\s*unknown/);
            expect(host).toMatch(/export function collapsedHiddenKeys/);

            /*
                ═══ A SOURCE ASSERTION, BECAUSE THE BEHAVIOUR IS UNREACHABLE ═══

                `stopEventPropagation` on pointer-down is what lets the click
                reach the button at all: without it tldraw claims the gesture and
                drags the shape instead. It is pinned HERE rather than in a
                rendered test because jsdom cannot show it — `fireEvent.click`
                dispatches straight at the element and never goes through
                tldraw's pointer handling, so removing the guard leaves every
                rendered assertion green. Measured, not assumed: that mutation
                survived 17 of 17.

                So this is the honest coverage available, and the limitation is
                recorded rather than papered over with a test that would pass
                either way.
            */
            expect(util).toMatch(/onPointerDown=\{stopEventPropagation\}/);

            // And the fold MERGES into dataJson. The payload already carries
            // `size`, `linkedEntityId` and `ruleId`; a whole-value write drops
            // them. Asserted behaviourally too, through the chevron itself —
            // driving it through a merging test helper left this mutation green.
            expect(util).toMatch(/dataJson: \{ \.\.\.\(prev \?\? \{\}\), collapsed: !collapsed \}/);

            // Drill-down is unchanged and still coexists: two gestures, two
            // mechanisms, one visibility predicate.
            expect(canvas).toMatch(/getShapeVisibility=\{getShapeVisibility\}/);
            expect(canvas).toMatch(/onEnterGroup\?:\s*\(nodeKey: string\) => void/);
        });
    });
});
