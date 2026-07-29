/**
 * `serializeGraphForSave` — the ONE projection of a live canvas into the
 * SaveProcessMap PUT body.
 *
 * ── Why these assertions ────────────────────────────────────────────
 *
 * The projection used to exist in three hand-written copies inside
 * `PersistedProcessCanvas` (save / rename / duplicate), and the copies had
 * drifted apart in exactly two ways. Both are pinned below:
 *
 *   1. rename omitted `parentNodeKey`, so blurring a renamed map re-parented
 *      every node to root and DISSOLVED every group server-side;
 *   2. rename + duplicate hardcoded the label fallback `"Untitled step"`, so an
 *      unlabelled decision node was persisted as a "step".
 *
 * Lives under tests/rendered (the jsdom project) because the module's
 * dependency chain reaches xyflow component modules.
 */
import type { Node, Edge } from '@xyflow/react';
import { serializeGraphForSave } from '@/lib/processes/serialize-graph';
import { NODE_TAXONOMY } from '@/components/processes/node-taxonomy';

function node(over: Partial<Node> & { id: string }): Node {
    return {
        type: 'processStep',
        position: { x: 0, y: 0 },
        data: {},
        ...over,
    } as Node;
}

describe('serializeGraphForSave — group containment', () => {
    it('carries parentNodeKey through, so a grouped node stays grouped', () => {
        // The rename bug in one assertion: without this field the server
        // re-parents every node to root on the next full write.
        const out = serializeGraphForSave(
            [
                node({ id: 'g1', type: 'group' }),
                node({ id: 'n1', parentId: 'g1' } as Partial<Node> & { id: string }),
            ],
            [],
        );
        expect(out.nodes.find((n) => n.nodeKey === 'n1')!.parentNodeKey).toBe('g1');
    });

    it('maps a root-level node to parentNodeKey null, not undefined', () => {
        // `undefined` would be dropped by JSON.stringify, which reads to the
        // server as "field absent" rather than "explicitly no parent".
        const out = serializeGraphForSave([node({ id: 'n1' })], []);
        expect(out.nodes[0].parentNodeKey).toBeNull();
        expect(JSON.parse(JSON.stringify(out)).nodes[0]).toHaveProperty('parentNodeKey');
    });

    it('treats an empty-string parentId as no parent', () => {
        const out = serializeGraphForSave(
            [node({ id: 'n1', parentId: '' } as Partial<Node> & { id: string })],
            [],
        );
        expect(out.nodes[0].parentNodeKey).toBeNull();
    });
});

describe('serializeGraphForSave — label fallback comes from the taxonomy', () => {
    it.each(Object.keys(NODE_TAXONOMY))(
        'an unlabelled %s node falls back to its own defaultLabel',
        (kind) => {
            const out = serializeGraphForSave([node({ id: 'n1', type: kind })], []);
            expect(out.nodes[0].label).toBe(
                NODE_TAXONOMY[kind as keyof typeof NODE_TAXONOMY].defaultLabel,
            );
        },
    );

    it('never emits the hardcoded "Untitled step" for a non-step kind', () => {
        // The literal that used to be baked into rename + duplicate. It is a
        // legitimate value for the STEP kind only.
        const kinds = Object.keys(NODE_TAXONOMY).filter((k) => k !== 'processStep');
        const out = serializeGraphForSave(
            kinds.map((k, i) => node({ id: `n${i}`, type: k })),
            [],
        );
        expect(out.nodes.map((n) => n.label)).not.toContain('Untitled step');
    });

    it('prefers an explicit label over the fallback', () => {
        const out = serializeGraphForSave(
            [node({ id: 'n1', data: { label: 'Approve invoice' } })],
            [],
        );
        expect(out.nodes[0].label).toBe('Approve invoice');
    });

    it('falls back to the step default when the node type is unrecognised', () => {
        const out = serializeGraphForSave([node({ id: 'n1', type: 'not-a-kind' })], []);
        expect(out.nodes[0].nodeType).toBe('processStep');
    });
});

describe('serializeGraphForSave — the rest of the projection', () => {
    it('synthesises stable keys for nodes and edges with no id', () => {
        const out = serializeGraphForSave(
            [node({ id: '' })],
            [{ id: '', source: 'a', target: 'b' } as Edge],
        );
        expect(out.nodes[0].nodeKey).toBe('node-1');
        expect(out.edges[0].edgeKey).toBe('edge-1');
    });

    it('carries position, subtitle and dataJson', () => {
        const out = serializeGraphForSave(
            [
                node({
                    id: 'n1',
                    position: { x: 12, y: 34 },
                    data: { subtitle: 'sub', size: 'lg', linkedEntityId: 'ctrl-1' },
                }),
            ],
            [],
        );
        expect(out.nodes[0]).toMatchObject({ posX: 12, posY: 34, subtitle: 'sub' });
        expect(out.nodes[0].dataJson).toMatchObject({
            size: 'lg',
            linkedEntityId: 'ctrl-1',
        });
    });

    it('emits null dataJson when a node carries nothing worth persisting', () => {
        const out = serializeGraphForSave([node({ id: 'n1', data: { label: 'x' } })], []);
        expect(out.nodes[0].dataJson).toBeNull();
    });

    it('defaults an unrecognised edge variant to "flow"', () => {
        const out = serializeGraphForSave(
            [],
            [{ id: 'e1', source: 'a', target: 'b', data: { variant: 'nonsense' } } as Edge],
        );
        expect(out.edges[0].edgeKind).toBe('flow');
    });

    it('keeps a string edge label and nulls a non-string one', () => {
        const out = serializeGraphForSave(
            [],
            [
                { id: 'e1', source: 'a', target: 'b', label: 'yes' } as Edge,
                { id: 'e2', source: 'a', target: 'b' } as Edge,
            ],
        );
        expect(out.edges[0].labelOverride).toBe('yes');
        expect(out.edges[1].labelOverride).toBeNull();
    });
});
