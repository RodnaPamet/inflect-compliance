/**
 * The process-node shape's contract with the row it represents.
 *
 * Three claims, and each is load-bearing for a different reason:
 *
 *   1. A `nodeKey` maps to a shape id deterministically and reversibly, so a
 *      load/save cycle with no user edit reproduces the same ids. Get this
 *      wrong and every diff shows the whole graph as changed, which is the
 *      failure #2960 calls out by name.
 *
 *   2. Every kind in the taxonomy resolves to itself, and a kind this build has
 *      never seen resolves to something rather than throwing. `nodeType` is
 *      `z.string()` on the wire, not an enum, so an unknown value is a case the
 *      product can actually be in — and a canvas that refuses to open is worse
 *      than one that draws a plain box.
 *
 *   3. Exactly two kinds carry no handles, and WHICH two is asserted by name.
 *      Deriving the set from the taxonomy alone would make this test agree with
 *      whatever the data said, including a mistake; naming them makes a change
 *      to that set a review question.
 */
import {
    PROCESS_NODE_SHAPE_TYPE,
    nodeKeyFromShapeId,
    shapeIdForNodeKey,
} from '@/components/processes/tldraw/process-node-shape';
import {
    metaForNodeType,
    nodeTypeHasHandles,
} from '@/components/processes/tldraw/ProcessNodeShapeUtil';
import {
    NODE_TAXONOMY,
    NODE_TAXONOMY_ORDER,
    type ProcessNodeKind,
} from '@/components/processes/node-taxonomy';

/** Keys a real map plausibly contains, including awkward ones. */
const KEYS = ['n1', 'node-1', 'step_a', 'Payroll run', 'a:b:c', 'ünïcode', '0'];

describe('shape id ↔ nodeKey', () => {
    it('is deterministic — the same key always yields the same id', () => {
        for (const k of KEYS) {
            expect(shapeIdForNodeKey(k)).toBe(shapeIdForNodeKey(k));
        }
    });

    it('is reversible — the id carries the key intact', () => {
        for (const k of KEYS) {
            expect(nodeKeyFromShapeId(shapeIdForNodeKey(k))).toBe(k);
        }
    });

    it('is injective — distinct keys never collide', () => {
        const ids = KEYS.map(shapeIdForNodeKey);
        expect(new Set(ids).size).toBe(new Set(KEYS).size);
    });

    it('returns null for an id this mapping did not produce', () => {
        // A shape the user DREW has a random id and no recoverable key — the
        // caller must read `props.nodeKey`. Returning a plausible-looking
        // string here would hand back a key that names no row.
        expect(nodeKeyFromShapeId('binding:abc')).toBeNull();
        expect(nodeKeyFromShapeId('shape:')).toBeNull();
        expect(nodeKeyFromShapeId('')).toBeNull();
    });

    it('the shape type is the discriminator the serializer expects', () => {
        expect(PROCESS_NODE_SHAPE_TYPE).toBe('process-node');
    });
});

describe('nodeType resolves through the taxonomy', () => {
    it('covers EVERY kind the taxonomy declares — the population control', () => {
        // Iterating a hardcoded list would silently stop covering a kind added
        // later. This ranges over the taxonomy itself, and asserts the count so
        // a kind appearing or vanishing is visible rather than absorbed.
        const kinds = Object.keys(NODE_TAXONOMY) as ProcessNodeKind[];
        expect(kinds.length).toBe(12);
        expect(new Set(NODE_TAXONOMY_ORDER).size).toBeLessThanOrEqual(kinds.length);

        for (const kind of kinds) {
            expect(metaForNodeType(kind).id).toBe(kind);
        }
    });

    it('degrades an unknown kind instead of throwing', () => {
        for (const unknown of ['notAKind', 'processStep2', '', 'PROCESSSTEP']) {
            expect(() => metaForNodeType(unknown)).not.toThrow();
        }
        // And specifically NOT to `processStep`: an unrecognised kind is
        // exactly the case where we do not know it is a flow participant, so
        // the stand-in is the quietest kind that is still a node.
        expect(metaForNodeType('notAKind').id).toBe('external');
    });

    it('never returns a meta whose id disagrees with a real kind', () => {
        // The fallback must itself be a taxonomy member, or downstream lookups
        // keyed on `meta.id` would miss.
        expect(Object.keys(NODE_TAXONOMY)).toContain(metaForNodeType('notAKind').id);
    });
});

describe('handles are per-kind', () => {
    /** Named, not derived — see the header. */
    const EXPECTED_HANDLELESS: ProcessNodeKind[] = ['annotation', 'group'];

    it('exactly annotation and group carry no handles', () => {
        const handleless = (Object.keys(NODE_TAXONOMY) as ProcessNodeKind[])
            .filter((k) => !NODE_TAXONOMY[k].hasHandles)
            .sort();
        expect(handleless).toEqual([...EXPECTED_HANDLELESS].sort());
    });

    it('the util agrees with the taxonomy for every kind', () => {
        for (const kind of Object.keys(NODE_TAXONOMY) as ProcessNodeKind[]) {
            expect(nodeTypeHasHandles(kind)).toBe(NODE_TAXONOMY[kind].hasHandles);
        }
    });

    it('an unknown kind is treated as edge-capable', () => {
        // It falls back to `external`, which has handles. A node we cannot
        // identify should not silently lose its edges on load — that would
        // turn an unrecognised kind into data loss on the next save.
        expect(nodeTypeHasHandles('notAKind')).toBe(true);
    });
});

describe('the shape vocabulary stays small', () => {
    it('is two shapes over twelve kinds, and only annotation is a note', () => {
        // The taxonomy argues for this explicitly ("limiting the shape language
        // keeps the canvas from looking like a sticker sheet"), and it is the
        // reason ONE parameterised util is the right design. If this grows, the
        // one-util decision deserves re-examination.
        const kinds = Object.keys(NODE_TAXONOMY) as ProcessNodeKind[];
        const notes = kinds.filter((k) => NODE_TAXONOMY[k].shape === 'note');
        expect(notes).toEqual(['annotation']);
        expect(new Set(kinds.map((k) => NODE_TAXONOMY[k].shape))).toEqual(
            new Set(['rect', 'note']),
        );
    });
});
