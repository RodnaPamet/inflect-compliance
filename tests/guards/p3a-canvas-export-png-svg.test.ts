/**
 * Epic P3-PR-A — Canvas export (PNG / SVG) ratchet.
 *
 * Brief gap #2 🟠 "Export / Print" — pre-P3 the only way to put a
 * process map in an audit pack was a browser screenshot. P3-PR-A
 * wires html-to-image + xyflow's fit-to-bounds helpers into a
 * dropdown menu mounted in the document bar's action group.
 *
 * The chain:
 *
 *   1. `src/lib/processes/canvas-export.ts` owns the export
 *      mechanics (`exportCanvasAsPng`, `exportCanvasAsSvg`,
 *      fit-to-content transform). Filename sanitisation, the
 *      theme-derived background and the download anchor moved to
 *      `canvas-export-shared.ts` when the tldraw path arrived —
 *      engine-agnostic, so shared rather than duplicated.
 *   2. `<CanvasExportMenu>` mounts a `<Popover>` trigger with two
 *      items; each fires the corresponding helper.
 *   3. `<CanvasDocumentBar>` accepts an `exportSlot` ReactNode so
 *      the canvas can pass the menu without breaking the bar's
 *      "owns no state" decomposition contract.
 *   4. `<PersistedProcessCanvas>` mounts the menu via the
 *      `exportSlot` prop, threading a ref to the
 *      `[data-process-canvas]` wrapper + the live nodes + the
 *      active map's name.
 *
 * Locks each link so a future refactor that drops one fails CI.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
// Applied here rather than per assertion so a new `expect(read(...))` inherits
// it. String literals are KEPT: masking them would silently empty assertions
// that harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike (re-derived per file, not assumed from the directory), so
// `codeOf` is the right lexer and no language split is needed.
import { codeOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), "utf8"));

describe("Epic P3-PR-A — canvas export (PNG / SVG)", () => {
    describe("Export helpers module", () => {
        /*
            ═══ RE-POINTED, AND THE MECHANISM CHANGED UNDER IT (#3079) ═══

            Every assertion below has a real counterpart on the tldraw path —
            the capability is the same — but three of them described an
            xyflow RECIPE that no longer exists, and those are rewritten rather
            than re-pathed. The module being read explains why in its own
            docblock: xyflow had to hand a DOM node to `html-to-image`, while
            "tldraw does all three itself — `editor.toImage()` and
            `editor.getSvgString()` take shapes and return finished bytes".

            So the viewport walk, the `getNodesBounds`/`getViewportForBounds`
            fit, and the `html-to-image` import are not regressions to flag.
            They were the price of exporting a DOM subtree, and the successor
            does not pay it. What the assertions have to keep pinning is the
            PROPERTY each of them was protecting, which is where this rewrite
            spends its effort.

            Two assertions read `canvas-export-shared.ts` and are untouched:
            #3061 moved `safeFilename` and `resolveBackground` there precisely
            so this cutover would not need a second copy.
        */
        const src = read("src/lib/processes/tldraw-canvas-export.ts");
        const shared = read("src/lib/processes/canvas-export-shared.ts");

        it("exports both PNG + SVG helpers with the canonical signature", () => {
            expect(src).toMatch(
                /export async function exportTldrawCanvasAsPng\(/,
            );
            expect(src).toMatch(
                /export async function exportTldrawCanvasAsSvg\(/,
            );
        });

        it("declares the canonical options shape — an EDITOR, not a DOM node", () => {
            // The shape change that follows from the mechanism change. xyflow
            // needed `canvasEl: HTMLElement` plus `nodes: Node[]` because
            // `html-to-image` rasterises an element and the bounds had to be
            // computed separately. tldraw needs the editor and nothing else:
            // it owns both the shapes and the geometry.
            expect(src).toMatch(
                /interface TldrawCanvasExportOptions \{[\s\S]{0,400}editor:\s*Editor;[\s\S]{0,600}mapName:\s*string;/,
            );
        });

        it("exports the CURRENT PAGE's shapes, not the whole store", () => {
            /*
                The property the xyflow "walks down to the viewport child"
                assertion was really protecting: capture the graph, and ONLY
                the graph that is on screen.

                There it meant excluding the Controls overlay and Background
                siblings, which would have put a zoom strip into an evidence
                artefact. Here the equivalent mistake is `store.allRecords()`,
                which spans every page — the module's docblock calls the
                `getCurrentPageShapes()` choice deliberate for that reason.
                Same requirement, different thing to get wrong.
            */
            // Bound to the collector rather than read whole-file: the needle
            // should name the one function that chooses the shape set, and a
            // whole-file read is what the Class D ratchet counts as
            // un-analysable — it cannot tell which construct the claim is about.
            expect(functionBodyOf(src, "shapesToExport")).toMatch(
                /editor\.getCurrentPageShapes\(\)/,
            );
            expect(src).not.toMatch(/store\.allRecords\(\)/);
        });

        it("hands the shapes to tldraw's own exporters, adding no second rasteriser", () => {
            /*
                Replaces "imports html-to-image's toPng + toSvg" and "computes
                a fit-to-content viewport via xyflow's helpers".

                The property both protected: the artefact must be the whole
                graph at a sane scale, not the user's current zoom. tldraw's
                `getSvgString(shapes, …)` / `toImage(shapes, …)` take the
                shapes and do the fitting, so the assertion worth keeping is
                that this module delegates rather than re-deriving a viewport —
                and that `html-to-image` has NOT been reintroduced alongside,
                which would mean two rasterisers disagreeing about bounds.
            */
            expect(functionBodyOf(src, "exportTldrawCanvasAsSvg")).toMatch(
                /editor\.getSvgString\(shapes,/,
            );
            // `toImage` sits in `rasterise`, the shared raster step both the PNG
            // download and the clipboard copy go through — not in the PNG export
            // itself. Binding to the function that actually calls it is the
            // point of binding at all.
            expect(functionBodyOf(src, "rasterise")).toMatch(/editor\.toImage\(shapes,/);
            // This one stays whole-file on purpose: it is an assertion about the
            // MODULE's imports, which is not a construct.
            expect(src).not.toMatch(/from ["']html-to-image["']/);
        });

        it("sanitises the download filename + caps it at 60 chars", () => {
            // Unchanged. `safeFilename` moved to `canvas-export-shared.ts`
            // when the tldraw path arrived (#3061), because a second copy
            // would mean two answers to "what is a legal export filename".
            expect(shared).toMatch(/replace\(\/\[\^a-z0-9\]\+\/g/);
            expect(shared).toMatch(/\.slice\(0,\s*60\)/);
        });

        it("and the tldraw path still USES the shared helpers", () => {
            // The teeth for both relocated assertions, carried over verbatim
            // in intent: without this edge the two checks above pass against a
            // module nobody calls, and this file could mint its own filenames
            // while the shared one sat there correct and unused. `no-unused-
            // vars` is not configured here, so an unreferenced import would
            // not catch it.
            //
            // Bound to ONE function, for the reason the original gave: the
            // needles occur several times file-wide and would otherwise be
            // satisfied by any survivor.
            expect(src).toMatch(/from '@\/lib\/processes\/canvas-export-shared'/);
            const svgExport = functionBodyOf(src, "exportTldrawCanvasAsSvg");
            expect(svgExport).toMatch(/resolveBackground\(\)/);
            expect(svgExport).toMatch(/downloadDataUrl\(/);
            expect(svgExport).toMatch(/safeFilename\(/);
        });

        it("resolves the background colour from the active [data-theme]", () => {
            // Also in `canvas-export-shared.ts` — see the filename note. The
            // export path's USE of it is locked by the test above.
            expect(shared).toMatch(/document\.documentElement/);
            expect(shared).toMatch(/getAttribute\(["']data-theme["']\)/);
        });
    });

    describe("TldrawCanvasExportMenu component", () => {
        /*
            Re-pointed from `CanvasExportMenu` (#3079). The successor's own
            docblock says "same five actions, same testids, same i18n keys,
            same busy/toast behaviour" — and the testids are PREFIXED
            (`tldraw-export-*` rather than `canvas-export-*`), so the claim is
            true of the behaviour and not of the strings. Verified each below
            rather than taken from that sentence.
        */
        const src = read("src/components/processes/TldrawCanvasExportMenu.tsx");

        it("exports the component + accepts an editor + mapName", () => {
            // `editor` where the xyflow menu took `canvasEl` + `nodes`: the
            // same substitution the helper module made, for the same reason.
            expect(src).toMatch(/export function TldrawCanvasExportMenu/);
            expect(src).toMatch(/editor:\s*Editor \| null/);
            expect(src).toMatch(/mapName:\s*string/);
        });

        it("imports the export helpers from the tldraw export module", () => {
            expect(src).toMatch(
                /from\s*["']@\/lib\/processes\/tldraw-canvas-export["']/,
            );
        });

        it("renders the items + the trigger with canonical testids", () => {
            // PREFIXED, so this is not a free re-path: the ids are different
            // strings for the same affordances.
            // LITERAL needles, not `new RegExp(\`…${id}\`)`. An interpolated
            // needle is invisible to the Class D analyser — it counts such an
            // assertion as a blind spot, because an ambiguous needle can hide
            // behind a template. Three lines beat a loop the ratchet cannot read.
            expect(src).toMatch(/data-testid="tldraw-export-trigger"/);
            expect(src).toMatch(/data-testid="tldraw-export-png"/);
            expect(src).toMatch(/data-testid="tldraw-export-svg"/);
        });

        it("disables the menu items while a render is in flight", () => {
            // Double-clicks must not queue two downloads. The busy flag is
            // the same mechanism; the TRIGGER's gate differs — the xyflow one
            // read `!canvasEl`, and this one has no DOM node to test, so the
            // editor's absence is what stands in. Asserted where it lives
            // rather than restated here: `tldraw-export-menu.test.tsx` mounts
            // the component and checks the trigger's disabled states against
            // a real editor, which is a stronger check than a regex.
            expect(src).toMatch(/\bbusy,\s*setBusy\b/);
            expect(src).toMatch(/disabled=\{busy\}/);
        });

        it("surfaces export errors via the canonical useToast hook", () => {
            expect(src).toMatch(
                /import\s*\{[\s\S]{0,200}useToast[\s\S]{0,200}\}\s*from\s*["']@\/components\/ui\/hooks["']/,
            );
            expect(src).toMatch(/toast\.error\(/);
        });
    });

    describe("CanvasDocumentBar — accepts the exportSlot prop", () => {
        const src = read("src/components/processes/CanvasDocumentBar.tsx");

        it("declares exportSlot on the props interface", () => {
            expect(src).toMatch(/exportSlot\?:\s*import\(["']react["']\)\.ReactNode;/);
        });

        it("the bar renders {exportSlot} in the action group", () => {
            expect(src).toMatch(/\{exportSlot\}/);
        });
    });

    describe("TldrawProcessWorkspace — wires the export menu", () => {
        /*
            Re-pointed from `PersistedProcessCanvas` (#3079), and one assertion
            is GONE rather than moved, which is the interesting part.

            The xyflow host had to hold a `ref` to its own wrapper and pass
            `canvasEl={canvasWrapperRef.current}` into the menu, because
            `html-to-image` rasterises a DOM element. Two of the four tests
            here existed to pin that ref and its attachment point — and
            `ref.current` read during render is a classic stale-null, which is
            why they were worth pinning.

            tldraw hands over the editor instead, so there is no ref, no
            attachment point, and no stale-null to guard. Asserting the absence
            of a wrapper ref would be asserting that nobody reintroduced a
            mechanism nothing needs; what is worth keeping is the conditional.
        */
        const src = read("src/components/processes/TldrawProcessWorkspace.tsx");

        it("imports the export menu", () => {
            expect(src).toMatch(
                /import\s*\{\s*TldrawCanvasExportMenu\s*\}\s*from\s*["']@\/components\/processes\/TldrawCanvasExportMenu["']/,
            );
        });

        it("passes the menu into the bar's exportSlot when a map is active", () => {
            // Conditional on `activeId && activeProcess` — the menu has
            // nothing meaningful to export on the empty state, and
            // `activeProcess.name` below would throw on null. Carried over
            // unchanged, because the hazard is unchanged.
            expect(src).toMatch(
                /exportSlot=\{[\s\S]{0,120}activeId\s*&&\s*activeProcess[\s\S]{0,120}<TldrawCanvasExportMenu/,
            );
            expect(src).toMatch(/mapName=\{activeProcess\.name\}/);
        });

        it("hands over the EDITOR, not a DOM node", () => {
            // The substitution that removed the ref. A regression back to a
            // wrapper element would be a regression to the stale-null the two
            // retired assertions guarded.
            expect(src).toMatch(/<TldrawCanvasExportMenu[\s\S]{0,80}editor=\{editor\}/);
            expect(src).not.toMatch(/canvasEl=/);
        });
    });
});
