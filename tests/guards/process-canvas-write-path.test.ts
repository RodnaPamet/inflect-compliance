/**
 * The process canvas has ONE graph serialiser and every write path uses it —
 * with the concurrency guard, the undo stack and the autosave debounce.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * `PersistedProcessCanvas` had three hand-written copies of the same
 * projection, one per writer, and they had drifted:
 *
 *   - `handleRenameCommit` omitted `parentNodeKey`, so blurring a renamed map
 *     PUT every node re-parented to root and DISSOLVED every group;
 *   - rename and duplicate hardcoded the label fallback `"Untitled step"`;
 *   - rename omitted `expectedVersion`, so the one write users think of as
 *     "just metadata" silently clobbered a concurrent editor with no 409 path.
 *
 * Separately, three edit paths wrote through the raw state setters and so
 * skipped BOTH the undo stack and autosave: inspector edits (via a `replace`
 * change that `isSubstantiveNodeChange` classified as noise), palette drops,
 * and proximity auto-binds. The UI meanwhile told the user "Click off the field
 * or press Enter to save the edit."
 *
 * All of these are the same shape — a second (or third) copy of something that
 * has to agree with the first. Behavioural tests cover what the serialiser
 * PRODUCES (`tests/rendered/serialize-graph-for-save.test.ts`); this file
 * covers what cannot be observed from its output: that nobody wrote a fourth
 * copy, and that each write path is wired.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf, declarationOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const CANVAS = read('src/components/processes/TldrawProcessWorkspace.tsx');
const SERIALIZER = read('src/components/processes/tldraw/serializer.ts');

/*
    ═══ RE-POINTED WHOLESALE (#3079) ═══

    This file's subject was `PersistedProcessCanvas` — a 2500-line component
    that held three hand-written copies of one projection plus every write path
    inline. The defects it was written for were all "a second copy that has to
    agree with the first": rename omitting `parentNodeKey` and dissolving every
    group, rename omitting `expectedVersion` and clobbering a concurrent editor,
    two writers hardcoding the same label fallback.

    On this host there is no such component. The projection is
    `serializeEditorCanvas(editor)` in `tldraw/editor-canvas.ts`, and the writers
    are three separate modules that each call it. So the "no fourth copy"
    property is still exactly the right thing to guard — there are now MORE
    callers, which makes it more valuable, not less.

    Two things deliberately NOT re-asserted here:

      • `expectedVersion` + the 409 path. That moved to `tldraw-save.ts` and is
        asserted by `p1-optimistic-concurrency.test.ts`, which re-points to the
        same three files. Two guards reading one file is how a contract ends up
        asserted where nobody looks when it moves.
      • `handleProximityCommit`. Proximity auto-bind was DROPPED from scope by
        the owner on #3078 — tldraw's own arrow targeting supersedes it — so
        there is no handler to wire and nothing to guard.
*/
describe('one serialiser, used by every writer', () => {
    const SERIALIZER = read('src/components/processes/tldraw/editor-canvas.ts');
    const ROWS = read('src/components/processes/tldraw/serializer.ts');
    const WRITERS = [
        'src/lib/processes/use-tldraw-document-bar.ts',
        'src/lib/processes/use-tldraw-canvas-autosave.ts',
    ] as const;

    it('every writer routes through serializeEditorCanvas, none builds its own rows', () => {
        // The core property, and it has MORE teeth here than it did: three
        // modules now share the projection where one component used to hold
        // three copies of it.
        for (const w of WRITERS) {
            expect(read(w)).toMatch(/serializeEditorCanvas\(editor\)/);
        }
        // And the signature of a hand-written copy: minting a nodeKey. Only the
        // row builder may do that.
        for (const w of WRITERS) {
            expect(read(w)).not.toMatch(/nodeKey:/);
        }
        expect(ROWS).toMatch(/nodeKey:\s*s\.props\.nodeKey/);
    });

    it('the key comes off the SHAPE PROP, never off the shape id', () => {
        /*
            The tldraw-specific version of the same hazard, and the one both
            shape modules warn about: a node that came from a row has a derived
            id, but a node the user DREW has a random one and its key lives only
            in its props. A projection reading the id would work until the first
            drawn node, then mint a key like `shape:abc123`.
        */
        expect(ROWS).not.toMatch(/nodeKey:\s*s\.id/);
        expect(ROWS).toMatch(/nodeKey:\s*s\.props\.nodeKey/);
    });

    it('the diff snapshot uses the SAME projection as the save', () => {
        // The fourth copy that nearly existed: the diff needs the live canvas
        // as rows, and a bespoke projection for it would drift from what the
        // save sends — making the diff describe a document the server never
        // received.
        expect(read('src/components/processes/TldrawProcessWorkspace.tsx')).toMatch(
            /toDiffSnapshot\(serializeEditorCanvas\(editor\)\.rows\)/,
        );
    });
});

describe('every edit path marks dirty, through one classifier', () => {
    /*
        WHAT MOVED AND WHY THE SHAPE CHANGED.

        xyflow pushed per-item change ARRAYS through `onNodesChange` /
        `onEdgesChange`, so the guard asserted each handler called its own
        mapper — and asserted them paired, because a node handler using the
        edge mapper would classify correctly-looking nonsense.

        tldraw has no change arrays. The store emits one diff, and
        `classifyTldrawStoreDiff` answers for the whole of it, so there is one
        call site and no pairing to get wrong. The asymmetry the xyflow mappers
        had on `replace` does not exist either.

        The property that survives is the one that mattered: an edit that
        bypasses the classifier does not mark dirty, and autosave never fires —
        which is how inspector edits, palette drops and proximity binds were all
        silently unsaved while the UI said "press Enter to save the edit".
    */
    const CANVAS = read('src/components/processes/TldrawProcessCanvas.tsx');

    it('the canvas classifies the store diff through the shared adapter', () => {
        expect(CANVAS).toMatch(
            /import\s*\{\s*classifyTldrawStoreDiff\s*\}\s*from\s*['"]@\/lib\/processes\/canvas-changes-tldraw['"]/,
        );
        expect(CANVAS).toMatch(/classifyTldrawStoreDiff\(/);
    });

    it('and a substantive verdict is what calls onDirty — not every store tick', () => {
        /*
            Both halves matter. Without the classifier the canvas would mark
            dirty on camera moves and selection changes, and autosave would PUT
            the map on every pan. Without `onDirty` being called at all, a real
            edit is never saved.

            `onDirtyRef` rather than the prop directly: the handler is installed
            once on mount, so a captured prop would be the one from the first
            render forever — the stale-closure shape that made the xyflow
            version's dep arrays load-bearing.
        */
        expect(CANVAS).toMatch(/onDirtyRef\.current/);
        expect(CANVAS).toMatch(/onDirtyRef\.current\s*=\s*onDirty/);
    });
});
