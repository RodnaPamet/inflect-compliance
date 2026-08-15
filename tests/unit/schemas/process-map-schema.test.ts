/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Wave-B coverage — Process Map Zod schemas (previously ~0%).
 *
 * Pure schema unit tests: parse valid + invalid payloads to exercise
 * every field's required/type/enum/min/max branch plus the array caps
 * and defaults on the node / edge / endpoint schemas.
 */
import {
    ProcessMapStatusSchema,
    ProcessNodeInputSchema,
    ProcessEdgeInputSchema,
    CreateProcessMapSchema,
    SaveProcessMapSchema,
} from '@/app-layer/schemas/process-map';

describe('ProcessMapStatusSchema', () => {
    it('accepts each enum member', () => {
        expect(ProcessMapStatusSchema.parse('DRAFT')).toBe('DRAFT');
        expect(ProcessMapStatusSchema.parse('ACTIVE')).toBe('ACTIVE');
        expect(ProcessMapStatusSchema.parse('ARCHIVED')).toBe('ARCHIVED');
    });

    // enum branch — unknown value
    it('rejects an unknown status', () => {
        expect(ProcessMapStatusSchema.safeParse('PUBLISHED').success).toBe(false);
    });
});

describe('ProcessNodeInputSchema', () => {
    it('parses a minimal valid node', () => {
        const r = ProcessNodeInputSchema.parse({
            nodeKey: 'node-1',
            nodeType: 'task',
            label: 'Do thing',
            posX: 10,
            posY: 20,
        });
        expect(r.nodeKey).toBe('node-1');
        // optionals stay undefined when omitted
        expect(r.subtitle).toBeUndefined();
        expect(r.parentNodeKey).toBeUndefined();
    });

    it('accepts nullable optionals explicitly set to null', () => {
        const r = ProcessNodeInputSchema.parse({
            nodeKey: 'n',
            nodeType: 't',
            label: '',
            posX: 0,
            posY: 0,
            subtitle: null,
            parentNodeKey: null,
            dataJson: null,
        });
        expect(r.subtitle).toBeNull();
    });

    // required-field branch
    it('rejects a missing nodeKey', () => {
        expect(
            ProcessNodeInputSchema.safeParse({
                nodeType: 't',
                label: 'x',
                posX: 0,
                posY: 0,
            } as any).success,
        ).toBe(false);
    });

    // min(1) branch
    it('rejects an empty nodeKey', () => {
        expect(
            ProcessNodeInputSchema.safeParse({
                nodeKey: '',
                nodeType: 't',
                label: 'x',
                posX: 0,
                posY: 0,
            }).success,
        ).toBe(false);
    });

    // max(128) branch
    it('rejects an over-long nodeKey', () => {
        expect(
            ProcessNodeInputSchema.safeParse({
                nodeKey: 'a'.repeat(129),
                nodeType: 't',
                label: 'x',
                posX: 0,
                posY: 0,
            }).success,
        ).toBe(false);
    });

    // max(200) branch on label
    it('rejects an over-long label', () => {
        expect(
            ProcessNodeInputSchema.safeParse({
                nodeKey: 'n',
                nodeType: 't',
                label: 'a'.repeat(201),
                posX: 0,
                posY: 0,
            }).success,
        ).toBe(false);
    });

    // finite() branch — wrong type / non-finite numbers
    it('rejects non-finite coordinates', () => {
        expect(
            ProcessNodeInputSchema.safeParse({
                nodeKey: 'n',
                nodeType: 't',
                label: 'x',
                posX: Infinity,
                posY: 0,
            }).success,
        ).toBe(false);
        expect(
            ProcessNodeInputSchema.safeParse({
                nodeKey: 'n',
                nodeType: 't',
                label: 'x',
                posX: 'nope' as any,
                posY: 0,
            }).success,
        ).toBe(false);
    });
});

describe('ProcessEdgeInputSchema', () => {
    it('applies defaults for edgeKind and controls', () => {
        const r = ProcessEdgeInputSchema.parse({
            edgeKey: 'e1',
            sourceKey: 'n1',
            targetKey: 'n2',
        });
        expect(r.edgeKind).toBe('flow'); // default('flow')
        expect(r.controls).toEqual([]); // default([])
    });

    it('parses nested controls array', () => {
        const r = ProcessEdgeInputSchema.parse({
            edgeKey: 'e1',
            sourceKey: 'n1',
            targetKey: 'n2',
            edgeKind: 'gate',
            labelOverride: 'review',
            controls: [
                { controlKey: 'c1', label: 'Control 1', controlId: 'ctl_1' },
                { controlKey: 'c2', label: 'Control 2', controlId: 'ctl_2' },
            ],
        });
        expect(r.controls).toHaveLength(2);
        expect(r.controls[0].controlId).toBe('ctl_1');
        // PR-D — controlId is now REQUIRED (NOT NULL + FK); a null/absent
        // controlId is rejected (see the dedicated case below).
        expect(r.controls[1].controlId).toBe('ctl_2');
    });

    it('rejects a control with no controlId (PR-D — controlId required)', () => {
        expect(
            ProcessEdgeInputSchema.safeParse({
                edgeKey: 'e1',
                sourceKey: 'n1',
                targetKey: 'n2',
                controls: [{ controlKey: 'c1', label: 'x' }],
            }).success,
        ).toBe(false);
    });

    // required-field branch
    it('rejects a missing sourceKey', () => {
        expect(
            ProcessEdgeInputSchema.safeParse({
                edgeKey: 'e1',
                targetKey: 'n2',
            } as any).success,
        ).toBe(false);
    });

    // nested control min(1) branch
    it('rejects an empty controlKey in a nested control', () => {
        expect(
            ProcessEdgeInputSchema.safeParse({
                edgeKey: 'e1',
                sourceKey: 'n1',
                targetKey: 'n2',
                controls: [{ controlKey: '', label: 'x', controlId: 'ctl_1' }],
            }).success,
        ).toBe(false);
    });

    // controls .max(64) branch
    it('rejects more than 64 controls', () => {
        const controls = Array.from({ length: 65 }, (_, i) => ({
            controlKey: `c${i}`,
            label: `Control ${i}`,
            controlId: `ctl_${i}`,
        }));
        expect(
            ProcessEdgeInputSchema.safeParse({
                edgeKey: 'e1',
                sourceKey: 'n1',
                targetKey: 'n2',
                controls,
            }).success,
        ).toBe(false);
    });
});

describe('CreateProcessMapSchema', () => {
    it('parses with only a name', () => {
        const r = CreateProcessMapSchema.parse({ name: 'My map' });
        expect(r.name).toBe('My map');
        expect(r.status).toBeUndefined();
    });

    it('parses with full optional metadata', () => {
        const r = CreateProcessMapSchema.parse({
            name: 'Map',
            description: 'desc',
            status: 'ACTIVE',
            canvasMode: 'AUTOMATION',
        });
        expect(r.canvasMode).toBe('AUTOMATION');
    });

    // required-field branch
    it('rejects a missing name', () => {
        expect(CreateProcessMapSchema.safeParse({} as any).success).toBe(false);
    });

    // min(1) branch
    it('rejects an empty name', () => {
        expect(CreateProcessMapSchema.safeParse({ name: '' }).success).toBe(false);
    });

    // enum branch on canvasMode
    it('rejects an invalid canvasMode', () => {
        expect(
            CreateProcessMapSchema.safeParse({ name: 'm', canvasMode: 'WIZARD' as any })
                .success,
        ).toBe(false);
    });
});

describe('SaveProcessMapSchema', () => {
    it('parses a full-graph save payload', () => {
        const r = SaveProcessMapSchema.parse({
            name: 'Map',
            description: null,
            status: 'DRAFT',
            expectedVersion: 3,
            nodes: [
                { nodeKey: 'n1', nodeType: 'task', label: 'A', posX: 0, posY: 0 },
            ],
            edges: [{ edgeKey: 'e1', sourceKey: 'n1', targetKey: 'n1' }],
        });
        expect(r.nodes).toHaveLength(1);
        // edge default flows through nested schema
        expect(r.edges[0].edgeKind).toBe('flow');
    });

    it('parses with empty graph arrays (nodes/edges required but may be empty)', () => {
        const r = SaveProcessMapSchema.parse({ nodes: [], edges: [] });
        expect(r.nodes).toEqual([]);
        expect(r.edges).toEqual([]);
    });

    // expectedVersion .int().min(1) branches
    it('rejects a non-integer expectedVersion', () => {
        expect(
            SaveProcessMapSchema.safeParse({ nodes: [], edges: [], expectedVersion: 1.5 })
                .success,
        ).toBe(false);
    });

    it('rejects an expectedVersion below 1', () => {
        expect(
            SaveProcessMapSchema.safeParse({ nodes: [], edges: [], expectedVersion: 0 })
                .success,
        ).toBe(false);
    });

    // nodes array required
    it('rejects a missing nodes array', () => {
        expect(SaveProcessMapSchema.safeParse({ edges: [] } as any).success).toBe(false);
    });

    // nodes .max(500) branch
    it('rejects more than 500 nodes', () => {
        const nodes = Array.from({ length: 501 }, (_, i) => ({
            nodeKey: `n${i}`,
            nodeType: 't',
            label: 'x',
            posX: 0,
            posY: 0,
        }));
        expect(SaveProcessMapSchema.safeParse({ nodes, edges: [] }).success).toBe(false);
    });

    // edges .max(1000) branch
    it('rejects more than 1000 edges', () => {
        const edges = Array.from({ length: 1001 }, (_, i) => ({
            edgeKey: `e${i}`,
            sourceKey: 'n1',
            targetKey: 'n2',
        }));
        expect(SaveProcessMapSchema.safeParse({ nodes: [], edges }).success).toBe(false);
    });
});
/**
 * `dataJson` is a free-form slot, and free-form was unbounded.
 *
 * Node and edge COUNTS were capped (500 / 1000) but per-blob size was not, so
 * a map inside every count limit could still carry an arbitrarily large
 * payload — into rows that are rewritten by every autosave AND copied
 * wholesale into a ProcessMapSnapshot. The cost is write amplification on a
 * 3-second debounce rather than one large row.
 *
 * A byte cap rather than a per-nodeType schema: the failure mode is volume,
 * not shape, and one rule covers node, edge and edge-control blobs. The JSON
 * slot exists so payloads can evolve without migrations, which an allowlist
 * schema would spend immediately — and the server writes keys the client does
 * not know about, so a strict shape would break the round trip.
 */
describe('dataJson is size-bounded', () => {
    const node = (dataJson: unknown) => ({
        nodeKey: 'n1',
        nodeType: 'step',
        label: 'Step',
        posX: 0,
        posY: 0,
        dataJson,
    });

    const big = (bytes: number) => ({ blob: 'x'.repeat(bytes) });

    it('accepts a realistic blob', () => {
        expect(ProcessNodeInputSchema.safeParse(node({ colour: 'red', notes: 'ok' })).success).toBe(
            true,
        );
    });

    it.each([undefined, null])('accepts %s — the slot stays optional', (v) => {
        expect(ProcessNodeInputSchema.safeParse(node(v)).success).toBe(true);
    });

    it('rejects a blob over the cap', () => {
        expect(ProcessNodeInputSchema.safeParse(node(big(70 * 1024))).success).toBe(false);
    });

    it('accepts one just under it — the cap is not accidentally tighter than stated', () => {
        expect(ProcessNodeInputSchema.safeParse(node(big(60 * 1024))).success).toBe(true);
    });

    it('rejects an unserialisable blob rather than passing it to Prisma', () => {
        // A cycle throws in JSON.stringify. Letting it through turns a 400
        // into a 500 further down.
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(ProcessNodeInputSchema.safeParse(node(cyclic)).success).toBe(false);
    });

    it('bounds the EDGE blob too, not just nodes', () => {
        const edge = {
            edgeKey: 'e1',
            sourceKey: 'n1',
            targetKey: 'n2',
            dataJson: big(70 * 1024),
        };
        expect(ProcessEdgeInputSchema.safeParse(edge).success).toBe(false);
    });

    it('bounds the EDGE-CONTROL blob too — the slot easiest to forget', () => {
        const edge = {
            edgeKey: 'e1',
            sourceKey: 'n1',
            targetKey: 'n2',
            controls: [
                { controlKey: 'c1', label: 'C', controlId: 'id1', dataJson: big(70 * 1024) },
            ],
        };
        expect(ProcessEdgeInputSchema.safeParse(edge).success).toBe(false);
    });
});
