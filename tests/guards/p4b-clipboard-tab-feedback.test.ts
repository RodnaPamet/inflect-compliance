/**
 * Epic P4-PR-B — Clipboard + Tab-to-create + connection-rejection
 * feedback ratchet.
 *
 * Closes the brief's #6, #7, and #8 (🟠 + 🟡) gaps in one PR:
 *
 *   #6 — Copy / Paste / Duplicate nodes
 *   #7 — Keyboard node creation (Tab from selection)
 *   #8 — Connection-rejection visual feedback
 *
 * The chain:
 *
 *   1. `src/lib/processes/canvas-clipboard.ts` — module-scope
 *      clipboard helper. `copyToClipboard`, `pasteFromClipboard`,
 *      `hasClipboard`, with id re-keying + position offset on
 *      paste.
 *   2. `<PersistedProcessCanvas>` — three handlers (copy / paste
 *      / duplicate-selection) + Tab-to-create + a transient
 *      `rejectedSource` state that triggers the rejection
 *      animation via a className projection on the matched node.
 *   3. `globals.css` — `canvas-connection-shake` keyframes +
 *      `prefers-reduced-motion` variant.
 *
 * Each link has the others as backstops.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
// #2246 Class A — comments are masked at the READ SEAM, so an assertion cannot
// be satisfied by a comment instead of the code it names. Every read in this
// file is TypeScript/TSX, re-derived rather than assumed, so `codeOf` is the
// only masker needed here.
import { codeOf } from '../helpers/source-blocks';

const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const read = (rel: string) => codeOf(readRaw(rel));

describe("Epic P4-PR-B — clipboard + Tab + connection-rejection", () => {
    describe("Clipboard helper module", () => {
        const src = read("src/lib/processes/canvas-clipboard.ts");

        it("exports the canonical 4-function API", () => {
            for (const fn of [
                "copyToClipboard",
                "pasteFromClipboard",
                "hasClipboard",
                "clearClipboard",
            ]) {
                expect(src).toMatch(
                    new RegExp(`export function ${fn}\\b`),
                );
            }
        });

        it("captures only INTERNAL edges (both endpoints in the selection)", () => {
            // External edges (one endpoint outside the selection)
            // would dangle after paste — drop them on copy.
            expect(src).toMatch(
                /selectedIds\.has\(e\.source\)\s*&&\s*selectedIds\.has\(e\.target\)/,
            );
        });

        it("re-keys node ids on paste so a double-paste produces two copies", () => {
            // The id-map → endpoint-rewrite pattern is the
            // canonical safe-paste shape. Anchor the map +
            // both `idMap.set` (per node) and `idMap.get`
            // (per edge endpoint).
            expect(src).toMatch(/idMap\s*=\s*new Map<string,\s*string>/);
            expect(src).toMatch(/for \(const n of CLIPBOARD\.nodes\) idMap\.set/);
            expect(src).toMatch(/idMap\.get\(e\.source\)/);
            expect(src).toMatch(/idMap\.get\(e\.target\)/);
        });

        it("offsets pasted positions so the new copies are visually distinguishable", () => {
            expect(src).toMatch(/PASTE_OFFSET\s*=\s*\d+/);
            expect(src).toMatch(/n\.position\.x\s*\+\s*PASTE_OFFSET/);
            expect(src).toMatch(/n\.position\.y\s*\+\s*PASTE_OFFSET/);
        });

        it("re-maps parentId only when the parent was also copied (else drops it)", () => {
            // Otherwise a pasted group child orphans onto the
            // root layer pointing at a non-existent parent.
            expect(src).toMatch(
                /idMap\.has\(\(n as \{ parentId\?: string \}\)\.parentId!\)/,
            );
        });
    });

    describe("PersistedProcessCanvas — handlers + shortcuts", () => {
        const src = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );

        it("imports the clipboard helper trio", () => {
            expect(src).toMatch(
                /import\s*\{[\s\S]{0,400}copyToClipboard[\s\S]{0,200}hasClipboard[\s\S]{0,200}pasteFromClipboard[\s\S]{0,100}\}\s*from\s*["']@\/lib\/processes\/canvas-clipboard["']/,
            );
        });

        it("declares handleCopy / handlePaste / handleDuplicateSelection / handleTabCreate", () => {
            for (const handler of [
                "handleCopy",
                "handlePaste",
                "handleDuplicateSelection",
                "handleTabCreate",
            ]) {
                expect(src).toMatch(
                    new RegExp(`const ${handler}\\s*=\\s*useCallback`),
                );
            }
        });

        it("wires shortcuts for mod+c / mod+v / mod+d / tab", () => {
            expect(src).toMatch(/useKeyboardShortcut\(["']mod\+c["']/);
            expect(src).toMatch(/useKeyboardShortcut\(["']mod\+v["']/);
            expect(src).toMatch(/useKeyboardShortcut\(["']mod\+d["']/);
            expect(src).toMatch(/useKeyboardShortcut\(["']tab["']/);
        });

        it("paste handler pushes history + spread-deselects existing nodes", () => {
            // Spread + selected:false deselects the original
            // selection so the pasted nodes are the new selection.
            expect(src).toMatch(
                /history\.push\(\{\s*nodes,\s*edges\s*\}\)[\s\S]{0,200}\.\.\.nds\.map\(\(n\)\s*=>\s*\(\{\s*\.\.\.n,\s*selected:\s*false\s*\}\)\)/,
            );
        });

        it("Tab-create mints a connected sibling with a flow edge", () => {
            // Locks both the new node + the new edge shape.
            expect(src).toMatch(
                /newEdge:\s*Edge\s*=\s*\{[\s\S]{0,400}variant:\s*["']flow["']/,
            );
            expect(src).toMatch(
                /source:\s*source\.id,\s*target:\s*newId/,
            );
        });

        it("connection-rejection: isValidConnection sets rejectedSource on each reject path", () => {
            // The reject helper takes three reasons; each path
            // must call it.
            expect(src).toMatch(
                /reject\s*=\s*\(reason:\s*["']self["']\s*\|\s*["']duplicate["']\s*\|\s*["']annotation["']\)/,
            );
            expect(src).toMatch(/if \(src === tgt\) return reject\(["']self["']\)/);
            expect(src).toMatch(/return reject\(["']duplicate["']\)/);
            expect(src).toMatch(/return reject\(["']annotation["']\)/);
        });

        it("rejection animation flag clears after 600ms via setTimeout", () => {
            expect(src).toMatch(
                /setTimeout\(\(\)\s*=>\s*setRejectedSource\(null\),\s*600\)/,
            );
        });

        it("rejected-source projects as a `canvas-rejected` className on the matching node", () => {
            // The ReactFlow nodes prop maps the rejected source's
            // className so the CSS rule (which targets
            // `.react-flow__node.canvas-rejected`) fires.
            expect(src).toMatch(
                /n\.id === rejectedSource[\s\S]{0,300}canvas-rejected/,
            );
        });
    });

    describe("globals.css — shake animation respecting reduced-motion", () => {
        const src = read("src/app/globals.css");

        it("declares both keyframe sets (full shake + reduced fallback)", () => {
            expect(src).toMatch(/@keyframes canvas-connection-shake \{/);
            expect(src).toMatch(/@keyframes canvas-connection-shake-reduced \{/);
        });

        it("targets the canvas-rejected className on react-flow nodes", () => {
            expect(src).toMatch(
                /\.react-flow__node\.canvas-rejected/,
            );
        });

        it("wraps the reduced-motion rule in the prefers-reduced-motion query", () => {
            expect(src).toMatch(
                /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
            );
        });
    });
});
