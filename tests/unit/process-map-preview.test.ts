/**
 * The preview a reviewer reads for a PROCESS_MAP proposal (#5053), and the
 * server read that pairs it with the layout boxes approval creates the map at.
 */
import {
    buildProcessMapPreview,
    canonicaliseProposedProcessMap,
    ProposedProcessMapSchema,
} from '@/lib/agentic/process-map-proposal';
import {
    prepareProcessMapApproval,
    previewStoredProcessMap,
} from '@/lib/processes/proposed-map-read';
import { layoutProposedProcessMap } from '@/lib/processes/proposed-map-layout';

function stored(payload: Record<string, unknown>): string {
    return JSON.stringify(canonicaliseProposedProcessMap(ProposedProcessMapSchema.parse(payload)));
}

const MAP = {
    name: 'Vendor onboarding',
    description: 'Due diligence',
    nodes: [
        { nodeKey: 'a', label: 'Intake' },
        { nodeKey: 'b', nodeType: 'decision', label: 'Risk tier?' },
        { nodeKey: 'c', label: 'Security review', subtitle: 'Questionnaire' },
        { nodeKey: 'd', nodeType: 'decision', label: 'Approved?' },
        { nodeKey: 'e', label: 'Orphan step' },
    ],
    edges: [
        { sourceKey: 'a', targetKey: 'b' },
        { sourceKey: 'b', targetKey: 'c', labelOverride: 'High' },
        { sourceKey: 'b', targetKey: 'a', labelOverride: 'Rework' },
        { sourceKey: 'c', targetKey: 'd' },
    ],
};

describe('buildProcessMapPreview', () => {
    const read = previewStoredProcessMap(stored(MAP));
    const preview = read.ok ? read.preview : null;

    it('reads a stored map', () => {
        expect(read.ok).toBe(true);
    });

    it('orders the steps as stored, numbered from 1, with no agent key', () => {
        expect(preview!.steps.map((s) => [s.index, s.key, s.nodeType, s.label, s.subtitle])).toEqual([
            [1, 'n1', 'processStep', 'Intake', null],
            [2, 'n2', 'decision', 'Risk tier?', null],
            [3, 'n3', 'processStep', 'Security review', 'Questionnaire'],
            [4, 'n4', 'decision', 'Approved?', null],
            [5, 'n5', 'processStep', 'Orphan step', null],
        ]);
    });

    it('names each arrow’s ends by number and label', () => {
        expect(preview!.arrows.map((a) => [a.key, a.fromIndex, a.fromLabel, a.toIndex, a.toLabel, a.label])).toEqual([
            ['e1', 1, 'Intake', 2, 'Risk tier?', null],
            ['e2', 2, 'Risk tier?', 3, 'Security review', 'High'],
            ['e3', 2, 'Risk tier?', 1, 'Intake', 'Rework'],
            ['e4', 3, 'Security review', 4, 'Approved?', null],
        ]);
    });

    it('reports isolated steps and decisions with fewer than two exits', () => {
        expect(preview!.notes).toEqual({ isolatedSteps: [5], decisionsWithFewerThanTwoExits: [4] });
    });

    it('carries a box per step, from the server layout, and bounds that contain them all', () => {
        for (const s of preview!.steps) {
            expect(s.box.w).toBe(220);
            expect(s.box.h).toBe(88);
        }
        expect(preview!.bounds.width).toBe(Math.max(...preview!.steps.map((s) => s.box.x + s.box.w)));
        expect(preview!.bounds.height).toBe(Math.max(...preview!.steps.map((s) => s.box.y + s.box.h)));
    });

    it('a one-step map reports no isolated step', () => {
        const one = previewStoredProcessMap(stored({ name: 'One', nodes: [{ nodeKey: 'x', label: 'Only' }], edges: [] }));
        expect(one.ok && one.preview.notes.isolatedSteps).toEqual([]);
    });

    it('throws when a step has no box: the boxes and the map come from one read', () => {
        const map = canonicaliseProposedProcessMap(ProposedProcessMapSchema.parse(MAP));
        expect(() => buildProcessMapPreview(map, {})).toThrow(/no layout box for step 1/);
    });
});

describe('previewStoredProcessMap — what cannot be rendered', () => {
    it.each([
        ['not JSON', '{nope'],
        ['not an object', '"text"'],
        ['zero steps', JSON.stringify({ name: 'x', nodes: [], edges: [] })],
        [
            'a dangling arrow',
            JSON.stringify({ name: 'x', nodes: [{ nodeKey: 'n1', label: 'a' }], edges: [{ sourceKey: 'n1', targetKey: 'n9' }] }),
        ],
        ['agent keys never canonicalised', JSON.stringify(MAP)],
    ])('%s is not ok', (_name, payloadJson) => {
        expect(previewStoredProcessMap(payloadJson).ok).toBe(false);
    });
});

describe('prepareProcessMapApproval — what approval creates', () => {
    it('creates the map at the boxes the reviewer was shown', () => {
        const json = stored(MAP);
        const read = previewStoredProcessMap(json);
        const prepared = prepareProcessMapApproval({ payloadJson: json, hasEdits: false });
        expect(read.ok).toBe(true);
        const shown = read.ok ? read.preview.steps.map((s) => [s.key, s.box.x, s.box.y]) : [];
        expect(prepared.graph.nodes.map((n) => [n.nodeKey, n.posX, n.posY])).toEqual(shown);
    });

    it('emits the PUT-ready DOCUMENT shape: flow edges, no controls, no data, no parent', () => {
        const prepared = prepareProcessMapApproval({ payloadJson: stored(MAP), hasEdits: false });
        expect(prepared.name).toBe('Vendor onboarding');
        expect(prepared.description).toBe('Due diligence');
        expect(prepared.graph.edges.map((e) => e.edgeKey)).toEqual(['e1', 'e2', 'e3', 'e4']);
        for (const e of prepared.graph.edges) {
            expect(e.edgeKind).toBe('flow');
            expect(e.controls).toEqual([]);
        }
        for (const n of prepared.graph.nodes) {
            expect(n.dataJson).toBeNull();
            expect(n.parentNodeKey).toBeNull();
            expect(['processStep', 'decision']).toContain(n.nodeType);
        }
    });

    it('refuses edits, by reason', () => {
        expect(() => prepareProcessMapApproval({ payloadJson: stored(MAP), hasEdits: true })).toThrow(
            expect.objectContaining({ status: 400, details: { reason: 'PROCESS_MAP_PROPOSAL_NOT_EDITABLE' } }),
        );
    });

    it('refuses a stored map that no longer reads, by reason', () => {
        expect(() => prepareProcessMapApproval({ payloadJson: JSON.stringify(MAP), hasEdits: false })).toThrow(
            expect.objectContaining({
                status: 400,
                details: { reason: 'PROCESS_MAP_PROPOSAL_UNREADABLE', unreadable: 'NOT_CANONICAL' },
            }),
        );
    });
});

describe('layoutProposedProcessMap', () => {
    function overlaps(a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean {
        return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    }
    const keys = (n: number) => Array.from({ length: n }, (_, i) => ({ nodeKey: `n${i + 1}` }));

    it.each([
        ['a 40-step chain', keys(40), keys(39).map((n, i) => ({ sourceKey: n.nodeKey, targetKey: `n${i + 2}` }))],
        [
            'a diamond',
            keys(4),
            [
                { sourceKey: 'n1', targetKey: 'n2' },
                { sourceKey: 'n1', targetKey: 'n3' },
                { sourceKey: 'n2', targetKey: 'n4' },
                { sourceKey: 'n3', targetKey: 'n4' },
            ],
        ],
        [
            'a cycle',
            keys(3),
            [
                { sourceKey: 'n1', targetKey: 'n2' },
                { sourceKey: 'n2', targetKey: 'n3' },
                { sourceKey: 'n3', targetKey: 'n1' },
            ],
        ],
        ['isolated steps', keys(5), [{ sourceKey: 'n1', targetKey: 'n2' }]],
    ])('gives %s non-overlapping, finite, integer 220×88 boxes, the same on every call', (_n, nodes, edges) => {
        const boxes = layoutProposedProcessMap(nodes, edges);
        expect(Object.keys(boxes).sort()).toEqual(nodes.map((n) => n.nodeKey).sort());
        const list = Object.values(boxes);
        for (const b of list) {
            expect([b.w, b.h]).toEqual([220, 88]);
            for (const v of [b.x, b.y]) {
                expect(Number.isInteger(v)).toBe(true);
            }
        }
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                expect({ i, j, overlap: overlaps(list[i], list[j]) }).toEqual({ i, j, overlap: false });
            }
        }
        expect(layoutProposedProcessMap(nodes, edges)).toEqual(boxes);
    });
});
