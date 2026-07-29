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

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

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
    it('an inspector edit is classified substantive', () => {
        // `updateNodeData` reaches onNodesChange as a `replace` change. Falling
        // through to `default: false` is what made label / subtitle / size /
        // linked-entity edits neither autosaved nor undoable.
        const classifier = CANVAS.slice(
            CANVAS.indexOf('const isSubstantiveNodeChange'),
            CANVAS.indexOf('const isSubstantiveEdgeChange'),
        );
        expect(classifier).toMatch(/case "replace":[\s\S]*?return true;/);
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
