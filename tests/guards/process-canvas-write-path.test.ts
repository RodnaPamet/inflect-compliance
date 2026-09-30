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

const CANVAS = read('src/components/processes/PersistedProcessCanvas.tsx');
const SERIALIZER = read('src/lib/processes/serialize-graph.ts');

describe('one serialiser, used by every writer', () => {
    it('the canvas builds no node payload of its own', () => {
        // `nodeKey: n.id || \`node-…\`` is how the projection mints a key — the
        // signature line of a hand-written copy. Deliberately narrow: the
        // canvas legitimately declares `nodeKey: string` in the type of the
        // LOAD response, which is a different direction of travel.
        expect(CANVAS).not.toMatch(/nodeKey:\s*n\.id/);
        expect(SERIALIZER).toMatch(/nodeKey:\s*n\.id/);
    });

    it('the shared module is the only place the label fallback is chosen', () => {
        // The literal that used to be baked into rename + duplicate. It belongs
        // to the taxonomy, and the serialiser must read it from there.
        expect(CANVAS).not.toMatch(/["']Untitled step["']\s*[,;)]/);
        expect(SERIALIZER).toMatch(/meta\.defaultLabel/);
        expect(SERIALIZER).toMatch(/parentNodeKey: nodeParent\(n\)/);
    });

    it('save, rename and duplicate all call serializeGraphForSave', () => {
        const calls = CANVAS.match(/serializeGraphForSave\(nodes, edges\)/g) ?? [];
        expect(calls.length).toBeGreaterThanOrEqual(3);
    });
});

describe('every full write carries the optimistic-concurrency guard', () => {
    /** Body of a `const <name> = useCallback(async () => { … }, [deps]);`. */
    function callbackBody(name: string): string {
        const start = CANVAS.indexOf(`const ${name} = useCallback(`);
        if (start === -1) throw new Error(`not found: ${name}`);
        // Up to the next top-level `const <x> = useCallback(` or `const <x> = `.
        const rest = CANVAS.slice(start + 10);
        const next = rest.search(/\n    const \w+ = /);
        return next === -1 ? rest : rest.slice(0, next);
    }

    it.each(['handleSave', 'handleRenameCommit'])(
        '%s sends expectedVersion and handles the 409',
        (name) => {
            const body = callbackBody(name);
            expect(body).toMatch(/expectedVersion: loadedMap\.version/);
            expect(body).toMatch(/surfaceVersionConflict\(/);
        },
    );
});

describe('every edit path marks dirty and is undoable', () => {
    // WHAT MOVED, AND WHY THIS ASSERTION CHANGED SHAPE (#2961).
    //
    // This used to slice the canvas between `const isSubstantiveNodeChange` and
    // `const isSubstantiveEdgeChange` and assert the `replace` arm returned
    // true. Both predicates now live in `lib/processes/canvas-changes-xyflow.ts`,
    // so both `indexOf` anchors returned -1 and the slice was the empty string —
    // which is why the assertion was a `toMatch` and not a `not.toMatch`. It
    // FAILED rather than passing vacuously, which is the only reason the move
    // was visible at all. A name-to-name slice is the shape CLAUDE.md warns
    // about; it is not re-created below.
    //
    // The CLASSIFICATION itself is now behavioural, in
    // `tests/unit/processes/canvas-changes.test.ts` — including the node/edge
    // asymmetry on `replace`, with a mutation proof for each direction. What a
    // unit test on the adapter CANNOT see is whether the host still calls it, so
    // that is what this guard keeps: the wiring, per handler, paired.
    // Two tests rather than one `it.each`, because the pattern has to be a
    // regex LITERAL: a `new RegExp(mapper)` built from the table row would be
    // un-analysable to the #2246 Class C ratchet, which CAPS skips rather than
    // ignoring them. Bound to each handler's own declaration so the pairing is
    // asserted — a whole-file match would pass if the node handler classified
    // with the EDGE mapper.
    //
    // `declarationOf`, NOT `braceBlockAfter`. The first draft used the latter
    // and it returned 29,118 characters — from `onNodesChange` straight through
    // `onEdgesChange` and `onConnect`. Every assertion below still passed,
    // because `history.push({ nodes, edges })` and `autosave.markDirty()` occur
    // in those SIBLINGS too. Deleting the push from the node handler was a
    // mutation that stayed green. `declarationOf` returns 589 characters and
    // that same mutation reddens. The window, not the needle, was the defect.
    it('onNodesChange classifies through the node mapper', () => {
        const body = declarationOf(CANVAS, 'onNodesChange');
        expect(body).toMatch(
            /batchIsSubstantive\(\s*changes\.map\(classifyXyflowNodeChange\)/,
        );
        // The classification still gates BOTH consequences, which is what the
        // original defect broke.
        expect(body).toMatch(/history\.push\(\{ nodes, edges \}\)/);
        expect(body).toMatch(/autosave\.markDirty\(\)/);
    });

    it('onEdgesChange classifies through the edge mapper', () => {
        const body = declarationOf(CANVAS, 'onEdgesChange');
        expect(body).toMatch(
            /batchIsSubstantive\(\s*changes\.map\(classifyXyflowEdgeChange\)/,
        );
        expect(body).toMatch(/history\.push\(\{ nodes, edges \}\)/);
        expect(body).toMatch(/autosave\.markDirty\(\)/);
    });

    it('the host names no engine change type of its own', () => {
        // The point of the adapter: exactly one file knows xyflow's change
        // vocabulary. A `case "replace":` back in the host means somebody
        // re-inlined a predicate beside the adapter call.
        expect(CANVAS).not.toMatch(/case ["']replace["']:/);
    });

    it.each(['onDrop', 'handleProximityCommit'])(
        '%s pushes history and marks dirty',
        (name) => {
            const start = CANVAS.indexOf(`const ${name} = useCallback(`);
            expect(start).toBeGreaterThan(-1);
            const rest = CANVAS.slice(start);
            const end = rest.search(/\n    const \w+ = /);
            const body = end === -1 ? rest : rest.slice(0, end);
            expect(body).toMatch(/history\.push\(\{ nodes, edges \}\)/);
            expect(body).toMatch(/autosave\.markDirty\(\)/);
        },
    );
});
