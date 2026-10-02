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
import { codeOf, cssCodeOf } from '../helpers/source-blocks';

const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const read = (rel: string) => codeOf(readRaw(rel));
// #2727 — CSS through the CSS masker, not the TypeScript one. See
// p6b-touch-mobile for the same correction and why it matters.
const readCss = (rel: string) => cssCodeOf(readRaw(rel));

describe("Epic P4-PR-B — clipboard + Tab + connection-rejection", () => {
    describe("Clipboard — NATIVE here, so the app wires none", () => {
        /*
            ═══ RETIRED WITH A REASON, NOT DELETED (#3079) ═══

            `lib/processes/canvas-clipboard.ts` exported a four-function API and
            this block pinned four properties of it: capture only INTERNAL edges,
            re-key node ids so a double-paste makes two copies, offset pasted
            positions, and re-map `parentId` only when the parent came too.

            Every one of those is a property of a clipboard IMPLEMENTATION, and
            the app only had an implementation because xyflow ships none. tldraw
            ships clipboard actions natively — `'paste'` and `'copy-as'` are
            registered action ids in the package — so the host wires nothing and
            the editor handles mod+c / mod+v / mod+d itself.

            That is why this is a retirement rather than a port: re-implementing
            the four properties on top of an editor that already has them is the
            same mistake `arrow-to-edge.ts` warns about for proximity binding —
            buying tldraw's UX "for nothing".

            ═══ WHAT IS GENUINELY LOST: TAB-CREATE ═══

            Tab minting a connected sibling with a flow edge was an APP feature,
            not a clipboard one, and it has no tldraw equivalent. It is recorded
            in its own assertion below rather than folded into this note,
            because unlike the clipboard it is a capability reduction.
        */
        it("the app wires no shape-level clipboard, because the editor owns it", () => {
            const workspace = read("src/components/processes/TldrawProcessWorkspace.tsx");
            // The palette's `duplicate` is a DOCUMENT duplicate — it copies the
            // whole map via the document bar, not the selection. Worth pinning
            // so the two are not confused by the next reader.
            expect(workspace).toMatch(/duplicate:\s*bar\.handlers\.handleDuplicate/);
            // And no hand-rolled selection clipboard crept back in.
            expect(workspace).not.toMatch(/handleCopy|handlePaste|handleDuplicateSelection/);
        });

        it("Tab-create is UNPORTED — a capability reduction, on the record", () => {
            /*
                Tab minted a sibling node already connected by a flow edge: the
                fastest way to build a chain without touching the mouse. Nothing
                on this host does it.

                NOT covered by tldraw's native clipboard, and not by the
                drill-down or the command palette either — it is a distinct
                gesture. Recorded here because the alternative is that it
                vanishes with the file that implemented it and nobody knows it
                existed.

                TO RESTORE: the pieces are present. `arrow-to-edge.ts` can mint
                an edge between two node keys, and the palette-drop path already
                creates a node at a point — so this is a keyboard handler
                composing two existing operations, not new machinery.
            */
            const workspace = read("src/components/processes/TldrawProcessWorkspace.tsx");
            const canvas = read("src/components/processes/TldrawProcessCanvas.tsx");
            expect(workspace).not.toMatch(/handleTabCreate/);
            expect(canvas).not.toMatch(/handleTabCreate/);
        });

        it("connection rejection TELLS the user why, where it used to shake", () => {
            /*
                Replaces three assertions: `isValidConnection` setting
                `rejectedSource`, the 600ms `setTimeout` clearing the flag, and
                the `canvas-rejected` className projecting onto the node.

                All three described a SHAKE — an animation saying "no" without
                saying why. The xyflow host paired it with a toast carrying the
                reason (the gap analysis had asked for a tooltip, which has no
                stable hover host once the rejection lands).

                On this host the toast is the whole feedback, wired in #3086,
                and it is strictly more informative: five distinct reasons,
                localised, collapsed onto one toast id so a run of misclicks is
                one message. The shake is unported; what it communicated is not.
            */
            const host = read("src/components/processes/TldrawProcessMap.tsx");
            expect(host).toMatch(/onEdgeRefused=\{handleEdgeRefused\}/);
            expect(host).toMatch(/toast\.warning\(text,\s*\{\s*id:\s*REFUSAL_TOAST_ID\s*\}\)/);
        });
    });

    describe("globals.css — the shake rules are now DEAD", () => {
        // `cssCodeOf`, not `readRaw`: the stylesheet carries a prose comment above
        // these very rules explaining what the shake is for, and a raw read lets
        // that comment satisfy the assertion. #2246 Class A counts a raw read as
        // an offender for exactly this reason.
        const css = readCss("src/app/globals.css");

        it("still selects .react-flow__node, which the process canvas no longer renders", () => {
            /*
                Not a passing test pretending to be one — a deliberate record of
                leftover CSS.

                The keyframes and the reduced-motion fallback are still in
                `globals.css`, and their selector is
                `[data-process-canvas="true"] .react-flow__node.canvas-rejected`.
                The process canvas is tldraw now and renders no
                `.react-flow__node`, so these rules match nothing.

                They are left in place rather than removed in this diff for one
                reason: `GraphExplorer` and the bow-tie canvas still render
                React Flow, and whether a shake belongs on THOSE surfaces is a
                question for whoever owns them — deleting the keyframes would
                decide it silently. The dead selector is asserted so the
                decision stays visible.

                TO RESOLVE: either re-point the selector at a surface that still
                has React Flow nodes, or delete the three rules together with
                the `canvas-rejected` className that nothing sets.
            */
            expect(css).toMatch(/\.react-flow__node\.canvas-rejected/);
            // And nothing sets the className any more, which is what makes the
            // rules dead rather than merely unused by one host.
            const canvasSrcs = [
                read("src/components/processes/TldrawProcessCanvas.tsx"),
                read("src/components/processes/TldrawProcessMap.tsx"),
                read("src/components/processes/TldrawProcessWorkspace.tsx"),
            ];
            for (const src of canvasSrcs) expect(src).not.toMatch(/canvas-rejected/);
        });

        it("the reduced-motion fallback is still paired with the full keyframes", () => {
            // Kept from the original: whatever happens to these rules, the
            // accessible variant must not be the one that gets dropped.
            expect(css).toMatch(/@media\s*\(prefers-reduced-motion/);
        });
    });
});
