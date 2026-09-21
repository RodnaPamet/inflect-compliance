/**
 * PR-B polish — Structural ratchet for the two items shipped:
 *
 *   1. Copy canvas as image to clipboard via `ClipboardItem`.
 *      Helper at `src/lib/processes/canvas-export.ts`; menu item
 *      at `src/components/processes/CanvasExportMenu.tsx`.
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
        const helper = () => read("src/lib/processes/canvas-export.ts");
        const menu = () =>
            read("src/components/processes/CanvasExportMenu.tsx");

        it("exports copyCanvasAsImageToClipboard from canvas-export", () => {
            expect(helper()).toMatch(
                /export async function copyCanvasAsImageToClipboard/,
            );
        });

        it("uses navigator.clipboard.write + ClipboardItem", () => {
            const src = helper();
            expect(src).toMatch(/navigator\.clipboard\.write\(\[/);
            expect(src).toMatch(/new ClipboardItem\(\{[\s\S]*?"image\/png"/);
        });

        it("feature-detects clipboard support (throws on unsupported)", () => {
            // Guarding `navigator.clipboard?.write` AND
            // `typeof ClipboardItem === "undefined"` catches both
            // older Safari and Firefox builds.
            const src = helper();
            expect(src).toMatch(/navigator\.clipboard\?\.write/);
            expect(src).toMatch(/typeof ClipboardItem === "undefined"/);
        });

        it("exports canCopyImageToClipboard for the menu's visibility gate", () => {
            expect(helper()).toMatch(
                /export function canCopyImageToClipboard\(\)/,
            );
        });

        it("CanvasExportMenu wires the new item gated by canCopyImageToClipboard", () => {
            const src = menu();
            expect(src).toMatch(/canCopyImageToClipboard/);
            expect(src).toMatch(/copyCanvasAsImageToClipboard/);
            expect(src).toMatch(/data-testid="canvas-export-clipboard"/);
            // Localised via next-intl — assert the key wiring + the
            // English catalog value rather than the inline literal.
            expect(src).toMatch(/t\("copyAsImage"\)/);
            const en = require("../../messages/en.json");
            expect(en.automation.exportMenu.copyAsImage).toBe("Copy as image");
            // The menu's `run` callback must handle the new
            // "clipboard" kind alongside the existing four.
            expect(src).toMatch(
                /kind:\s*"png"\s*\|\s*"svg"\s*\|\s*"pdf"\s*\|\s*"evidence"\s*\|\s*"clipboard"/,
            );
        });

        it("clipboard run path emits a success toast", () => {
            const src = menu();
            // Find the clipboard branch within `run(...)` and scope
            // to it via the NEXT `else if` (the PDF branch is the
            // structural neighbour and won't move under it).
            const start = src.indexOf('kind === "clipboard"');
            expect(start).toBeGreaterThan(-1);
            const end = src.indexOf('else if (kind === "pdf"', start);
            expect(end).toBeGreaterThan(start);
            const body = src.slice(start, end);
            expect(body).toMatch(/copyCanvasAsImageToClipboard\(/);
            expect(body).toMatch(/toast\.success/);
        });
    });

    describe("2. Collapsible groups", () => {
        const node = () =>
            read("src/components/processes/ProcessTypedNode.tsx");

        it("imports useReactFlow + Nucleo's ChevronRight (rotated 90° for the expanded state)", () => {
            const src = node();
            expect(src).toMatch(
                /import\s*\{[\s\S]*?\buseReactFlow\b[\s\S]*?\}\s*from\s*"@xyflow\/react"/,
            );
            // Nucleo doesn't ship ChevronDown today — we rotate
            // ChevronRight via `rotate-90` instead of pulling
            // lucide back into the canvas (locked by no-lucide).
            expect(src).toMatch(
                /import\s*\{\s*ChevronRight\s*\}\s*from\s*"@\/components\/ui\/icons\/nucleo\/chevron-right"/,
            );
            // The renderer chooses rotation by collapsed state.
            expect(src).toMatch(
                /const chevronRotation = collapsed \? "" : "rotate-90"/,
            );
        });

        it("declares the collapsed-group geometry constants", () => {
            const src = node();
            expect(src).toMatch(/const COLLAPSED_GROUP_W\s*=\s*\d+/);
            expect(src).toMatch(/const COLLAPSED_GROUP_H\s*=\s*\d+/);
        });

        it("GroupNodeChrome subcomponent exists with a chevron toggle button", () => {
            const src = node();
            expect(src).toMatch(/function GroupNodeChrome\b/);
            expect(src).toMatch(/data-testid="group-collapse-toggle"/);
        });

        it("toggle handler shrinks style + flips descendants' hidden flag", () => {
            const src = node();
            const start = src.indexOf("const toggleCollapsed");
            expect(start).toBeGreaterThan(-1);
            const end = src.indexOf("[id, collapsed, setNodes]", start);
            expect(end).toBeGreaterThan(start);
            const body = src.slice(start, end);
            // The handler must do all three things:
            //   (a) walk descendants via parentId chains,
            //   (b) flip data.collapsed on the group itself,
            //   (c) set style.width/height to COLLAPSED_GROUP_*
            //       (collapsing) or back to data.width/height
            //       (expanding),
            //   (d) flip `hidden` on every descendant.
            expect(body).toMatch(/parentId/);
            expect(body).toMatch(/data:\s*\{\s*\.\.\.prevData,\s*collapsed:\s*nextCollapsed/);
            expect(body).toMatch(/COLLAPSED_GROUP_W/);
            expect(body).toMatch(/COLLAPSED_GROUP_H/);
            expect(body).toMatch(/hidden:\s*nextCollapsed/);
        });

        it("the renderer reads data.collapsed + branches on it", () => {
            const src = node();
            expect(src).toMatch(
                /collapsed = \(nodeData as \{ collapsed\?: boolean \}\)\.collapsed === true/,
            );
            // Two `data-process-node-collapsed` paths — one for the
            // pill (true) and one for the dashed container (false).
            expect(src).toMatch(/data-process-node-collapsed="true"/);
            expect(src).toMatch(/data-process-node-collapsed="false"/);
        });

        it("toggle handler stops propagation + prevents default", () => {
            // Without these, the chevron click would also trigger
            // xyflow selection + the canvas's double-click drill
            // (a stray rapid double-click pattern).
            const src = node();
            expect(src).toMatch(/event\.stopPropagation\(\)/);
            expect(src).toMatch(/event\.preventDefault\(\)/);
        });
    });
});
