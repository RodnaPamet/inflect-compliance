/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Wave coverage — ProcessMapRepository (graph-replace repo, previously
 * ~31% branches).
 *
 * Every method takes an explicit `db: PrismaTx` param (no
 * runInTenantContext, no audit emitter), so we drive each method with a
 * fake `db` whose model methods are jest.fn() returning canned values,
 * then assert on the where/orderBy/take/data passed to Prisma plus the
 * not-found / throw / concurrency branches.
 */

import { ProcessMapRepository } from '@/app-layer/repositories/ProcessMapRepository';
import { makeRequestContext } from '../../helpers/make-context';
import { Prisma } from '@prisma/client';

const ctx = makeRequestContext('ADMIN');

// Each fn typed with (...args: any[]) so mock.calls[0][0] is `any` —
// keeps tsc --noEmit (stricter than ts-jest) happy when we index calls.
function freshDb() {
    return {
        processMap: {
            findMany: jest.fn((..._args: any[]) => Promise.resolve([] as any[])),
            findFirst: jest.fn((..._args: any[]) => Promise.resolve(null as any)),
            create: jest.fn((..._args: any[]) => Promise.resolve(null as any)),
            updateMany: jest.fn((..._args: any[]) =>
                Promise.resolve({ count: 1 } as any),
            ),
        },
        processNode: {
            deleteMany: jest.fn((..._args: any[]) =>
                Promise.resolve({ count: 0 } as any),
            ),
            createMany: jest.fn((..._args: any[]) =>
                Promise.resolve({ count: 0 } as any),
            ),
            findMany: jest.fn((..._args: any[]) => Promise.resolve([] as any[])),
        },
        processEdge: {
            deleteMany: jest.fn((..._args: any[]) =>
                Promise.resolve({ count: 0 } as any),
            ),
            create: jest.fn((..._args: any[]) =>
                Promise.resolve({ id: 'edge-1' } as any),
            ),
        },
        processEdgeControl: {
            createMany: jest.fn((..._args: any[]) =>
                Promise.resolve({ count: 0 } as any),
            ),
            findMany: jest.fn((..._args: any[]) => Promise.resolve([] as any[])),
        },
        // Default: every referenced control resolves as owned by this tenant, so
        // the pre-existing replaceGraph tests are unaffected. Tests that exercise
        // the ownership guard override this with an explicit resolution.
        control: {
            findMany: jest.fn((args: any) =>
                Promise.resolve(
                    ((args?.where?.id?.in ?? []) as string[]).map((id) => ({ id })),
                ),
            ),
        },
        processMapSnapshot: {
            create: jest.fn((..._args: any[]) => Promise.resolve({ id: 's1' } as any)),
            findMany: jest.fn((..._args: any[]) => Promise.resolve([] as any[])),
            findFirst: jest.fn((..._args: any[]) => Promise.resolve(null as any)),
        },
    };
}

let db: ReturnType<typeof freshDb>;

beforeEach(() => {
    jest.clearAllMocks();
    db = freshDb();
});

describe('ProcessMapRepository.list', () => {
    it('filters by tenant + not-deleted, orders by updatedAt desc, and maps _count', async () => {
        db.processMap.findMany.mockResolvedValueOnce([
            {
                id: 'm1',
                name: 'Onboarding',
                description: 'd',
                status: 'DRAFT',
                version: 2,
                canvasMode: 'DOCUMENT',
                createdAt: new Date('2026-01-01'),
                updatedAt: new Date('2026-01-02'),
                _count: { nodes: 3, edges: 5 },
            },
        ]);

        const out = await ProcessMapRepository.list(db as any, ctx);

        const arg = db.processMap.findMany.mock.calls[0][0];
        expect(arg.where).toEqual({ tenantId: ctx.tenantId, deletedAt: null });
        expect(arg.orderBy).toEqual([{ updatedAt: 'desc' }]);
        // _count flattening branch
        expect(out[0].nodeCount).toBe(3);
        expect(out[0].edgeCount).toBe(5);
        expect(out[0].id).toBe('m1');
    });

    it('returns empty array when no rows', async () => {
        const out = await ProcessMapRepository.list(db as any, ctx);
        expect(out).toEqual([]);
    });
});

describe('ProcessMapRepository.getByIdWithGraph', () => {
    it('returns null not-found branch', async () => {
        db.processMap.findFirst.mockResolvedValueOnce(null);
        const out = await ProcessMapRepository.getByIdWithGraph(
            db as any,
            ctx,
            'missing',
        );
        expect(out).toBeNull();
        const arg = db.processMap.findFirst.mock.calls[0][0];
        expect(arg.where).toEqual({
            id: 'missing',
            tenantId: ctx.tenantId,
            deletedAt: null,
        });
    });

    it('maps the found graph (nodes/edges/controls includes)', async () => {
        db.processMap.findFirst.mockResolvedValueOnce({
            id: 'm1',
            name: 'n',
            description: null,
            status: 'PUBLISHED',
            version: 4,
            createdAt: new Date('2026-01-01'),
            updatedAt: new Date('2026-01-02'),
            nodes: [{ nodeKey: 'a' }],
            edges: [{ edgeKey: 'e1', controls: [] }],
        });
        const out = await ProcessMapRepository.getByIdWithGraph(db as any, ctx, 'm1');
        expect(out).not.toBeNull();
        expect(out!.id).toBe('m1');
        expect(out!.nodes).toHaveLength(1);
        expect(out!.edges).toHaveLength(1);
    });
});

describe('ProcessMapRepository.setCanvasMode', () => {
    it('returns true when a row matched', async () => {
        db.processMap.updateMany.mockResolvedValueOnce({ count: 1 });
        const ok = await ProcessMapRepository.setCanvasMode(
            db as any,
            ctx,
            'm1',
            'AUTOMATION',
        );
        expect(ok).toBe(true);
        const arg = db.processMap.updateMany.mock.calls[0][0];
        expect(arg.where).toEqual({
            id: 'm1',
            tenantId: ctx.tenantId,
            deletedAt: null,
        });
        expect(arg.data).toEqual({ canvasMode: 'AUTOMATION' });
    });

    it('returns false when no row matched (count 0)', async () => {
        db.processMap.updateMany.mockResolvedValueOnce({ count: 0 });
        const ok = await ProcessMapRepository.setCanvasMode(
            db as any,
            ctx,
            'm1',
            'DOCUMENT',
        );
        expect(ok).toBe(false);
    });
});

describe('ProcessMapRepository.create', () => {
    it('applies all explicit fields', async () => {
        db.processMap.create.mockResolvedValueOnce({
            id: 'c1',
            name: 'Named',
            description: 'desc',
            status: 'PUBLISHED',
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        const out = await ProcessMapRepository.create(db as any, ctx, {
            name: 'Named',
            description: 'desc',
            status: 'ACTIVE',
            canvasMode: 'AUTOMATION',
            createdByUserId: 'u9',
        });
        const arg = db.processMap.create.mock.calls[0][0];
        expect(arg.data.description).toBe('desc');
        expect(arg.data.status).toBe('ACTIVE');
        expect(arg.data.canvasMode).toBe('AUTOMATION');
        expect(out.nodes).toEqual([]);
        expect(out.edges).toEqual([]);
    });

    it('applies defaults for the optional fields (?? branches)', async () => {
        db.processMap.create.mockResolvedValueOnce({
            id: 'c2',
            name: 'Bare',
            description: null,
            status: 'DRAFT',
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await ProcessMapRepository.create(db as any, ctx, {
            name: 'Bare',
            createdByUserId: 'u1',
        });
        const arg = db.processMap.create.mock.calls[0][0];
        expect(arg.data.description).toBeNull();
        expect(arg.data.status).toBe('DRAFT');
        expect(arg.data.canvasMode).toBe('DOCUMENT');
    });
});

// Helpers for replaceGraph payloads.
function node(over: Partial<any> = {}): any {
    return {
        nodeKey: 'n1',
        nodeType: 'task',
        label: 'Node',
        subtitle: null,
        posX: 0,
        posY: 0,
        parentNodeKey: null,
        dataJson: undefined,
        ...over,
    };
}
function edge(over: Partial<any> = {}): any {
    return {
        edgeKey: 'e1',
        sourceKey: 'n1',
        targetKey: 'n1',
        edgeKind: 'flow',
        labelOverride: null,
        dataJson: undefined,
        controls: [],
        ...over,
    };
}

describe('ProcessMapRepository.replaceGraph — structural validation', () => {
    it('throws on edge with unknown source nodeKey', async () => {
        await expect(
            ProcessMapRepository.replaceGraph(db as any, ctx, 'm1', {
                nodes: [node({ nodeKey: 'n1' })],
                edges: [edge({ sourceKey: 'ghost', targetKey: 'n1' })],
            }),
        ).rejects.toThrow(/unknown source nodeKey ghost/);
    });

    it('throws on edge with unknown target nodeKey', async () => {
        await expect(
            ProcessMapRepository.replaceGraph(db as any, ctx, 'm1', {
                nodes: [node({ nodeKey: 'n1' })],
                edges: [edge({ sourceKey: 'n1', targetKey: 'ghost' })],
            }),
        ).rejects.toThrow(/unknown target nodeKey ghost/);
    });

    it('throws on node that references itself as parentNodeKey', async () => {
        await expect(
            ProcessMapRepository.replaceGraph(db as any, ctx, 'm1', {
                nodes: [node({ nodeKey: 'n1', parentNodeKey: 'n1' })],
                edges: [],
            }),
        ).rejects.toThrow(/references itself as parentNodeKey/);
    });

    it('throws on node with unknown parentNodeKey', async () => {
        await expect(
            ProcessMapRepository.replaceGraph(db as any, ctx, 'm1', {
                nodes: [node({ nodeKey: 'n1', parentNodeKey: 'nope' })],
                edges: [],
            }),
        ).rejects.toThrow(/unknown parentNodeKey nope/);
    });

    it('allows a node with null parentNodeKey (continue branch)', async () => {
        db.processMap.findFirst.mockResolvedValueOnce(null); // short-circuit after validation
        const out = await ProcessMapRepository.replaceGraph(db as any, ctx, 'm1', {
            nodes: [node({ nodeKey: 'n1', parentNodeKey: null })],
            edges: [],
        });
        expect(out).toBeNull();
    });
});

describe('ProcessMapRepository.replaceGraph — existence + concurrency', () => {
    it('returns null when the map does not exist', async () => {
        db.processMap.findFirst.mockResolvedValueOnce(null);
        const out = await ProcessMapRepository.replaceGraph(db as any, ctx, 'm1', {
            nodes: [],
            edges: [],
        });
        expect(out).toBeNull();
    });

    it('throws staleData up-front when expectedVersion mismatches', async () => {
        db.processMap.findFirst.mockResolvedValueOnce({ id: 'm1', version: 7 });
        await expect(
            ProcessMapRepository.replaceGraph(db as any, ctx, 'm1', {
                nodes: [],
                edges: [],
                expectedVersion: 3,
            }),
        ).rejects.toMatchObject({ details: { currentVersion: 7 } });
        // deletes never ran
        expect(db.processEdge.deleteMany).not.toHaveBeenCalled();
    });

    it('throws staleData when the conditional bump loses the race (count 0)', async () => {
        db.processMap.findFirst
            .mockResolvedValueOnce({ id: 'm1', version: 5 }) // existence check
            .mockResolvedValueOnce({ version: 6 }); // post-race refresh
        db.processMap.updateMany.mockResolvedValueOnce({ count: 0 });
        await expect(
            ProcessMapRepository.replaceGraph(db as any, ctx, 'm1', {
                nodes: [],
                edges: [],
                expectedVersion: 5,
            }),
        ).rejects.toMatchObject({ details: { currentVersion: 6 } });
        // updateMany where includes the version predicate (expectedVersion set)
        const arg = db.processMap.updateMany.mock.calls[0][0];
        expect(arg.where.version).toBe(5);
    });

    it('falls back to existing.version when the post-race refresh row is null', async () => {
        db.processMap.findFirst
            .mockResolvedValueOnce({ id: 'm1', version: 9 }) // existence
            .mockResolvedValueOnce(null); // post-race refresh missing
        db.processMap.updateMany.mockResolvedValueOnce({ count: 0 });
        await expect(
            ProcessMapRepository.replaceGraph(db as any, ctx, 'm1', {
                nodes: [],
                edges: [],
                expectedVersion: 9,
            }),
        ).rejects.toMatchObject({ details: { currentVersion: 9 } });
    });
});

describe('ProcessMapRepository.replaceGraph — happy path', () => {
    it('deletes children, inserts nodes/edges/controls, bumps version, snapshots, and re-reads', async () => {
        // existence check, then final getByIdWithGraph re-read
        db.processMap.findFirst
            .mockResolvedValueOnce({ id: 'm1', version: 2 })
            .mockResolvedValueOnce({
                id: 'm1',
                name: 'After',
                description: 'd',
                status: 'PUBLISHED',
                version: 3,
                createdAt: new Date(),
                updatedAt: new Date(),
                nodes: [],
                edges: [],
            });
        db.processEdge.create.mockResolvedValueOnce({ id: 'edge-99' });
        db.processMap.updateMany.mockResolvedValueOnce({ count: 1 });

        const out = await ProcessMapRepository.replaceGraph(db as any, ctx, 'm1', {
            name: 'After',
            description: 'd',
            status: 'ACTIVE',
            expectedVersion: 2,
            nodes: [
                node({ nodeKey: 'n1', subtitle: 'sub', dataJson: { a: 1 } }),
                node({ nodeKey: 'n2', parentNodeKey: 'n1', dataJson: undefined }),
            ],
            edges: [
                edge({
                    edgeKey: 'e1',
                    sourceKey: 'n1',
                    targetKey: 'n2',
                    labelOverride: 'L',
                    dataJson: { x: 1 },
                    controls: [
                        {
                            controlKey: 'c1',
                            label: 'Ctl',
                            controlId: 'ctrl-1',
                            dataJson: { y: 2 },
                        },
                    ],
                }),
            ],
        });

        expect(db.processEdge.deleteMany).toHaveBeenCalled();
        expect(db.processNode.deleteMany).toHaveBeenCalled();
        // nodes.length > 0 branch
        expect(db.processNode.createMany).toHaveBeenCalled();
        const nodeData = db.processNode.createMany.mock.calls[0][0].data;
        // dataJson present vs undefined branches
        expect(nodeData[0].dataJson).toEqual({ a: 1 });
        expect(nodeData[1].dataJson).toBe(Prisma.JsonNull);

        // edge created with id used for controls
        const ctrlArg = db.processEdgeControl.createMany.mock.calls[0][0];
        expect(ctrlArg.data[0].edgeId).toBe('edge-99');

        // version bump with name/description/status set branches
        const bumpData = db.processMap.updateMany.mock.calls[0][0].data;
        expect(bumpData.name).toBe('After');
        expect(bumpData.description).toBe('d');
        expect(bumpData.status).toBe('ACTIVE');
        expect(bumpData.version).toEqual({ increment: 1 });

        // snapshot created at newVersion = existing.version + 1
        const snapArg = db.processMapSnapshot.create.mock.calls[0][0];
        expect(snapArg.data.version).toBe(3);

        expect(out).not.toBeNull();
        expect(out!.id).toBe('m1');
    });

    it('coerces explicit null dataJson to Prisma.JsonNull on node/edge/control (?? second arm)', async () => {
        db.processMap.findFirst
            .mockResolvedValueOnce({ id: 'm1', version: 1 })
            .mockResolvedValueOnce({
                id: 'm1',
                name: 'x',
                description: null,
                status: 'DRAFT',
                version: 2,
                createdAt: new Date(),
                updatedAt: new Date(),
                nodes: [],
                edges: [],
            });
        db.processEdge.create.mockResolvedValueOnce({ id: 'edge-7' });
        db.processMap.updateMany.mockResolvedValueOnce({ count: 1 });

        await ProcessMapRepository.replaceGraph(db as any, ctx, 'm1', {
            nodes: [node({ nodeKey: 'n1', dataJson: null })],
            edges: [
                edge({
                    sourceKey: 'n1',
                    targetKey: 'n1',
                    dataJson: null,
                    controls: [
                        {
                            controlKey: 'c1',
                            label: 'C',
                            controlId: null,
                            dataJson: null,
                        },
                    ],
                }),
            ],
        });

        // node dataJson null → Prisma.JsonNull
        expect(db.processNode.createMany.mock.calls[0][0].data[0].dataJson).toBe(
            Prisma.JsonNull,
        );
        // edge dataJson null → Prisma.JsonNull
        expect(db.processEdge.create.mock.calls[0][0].data.dataJson).toBe(
            Prisma.JsonNull,
        );
        // control dataJson null → Prisma.JsonNull
        expect(
            db.processEdgeControl.createMany.mock.calls[0][0].data[0].dataJson,
        ).toBe(Prisma.JsonNull);
        // snapshot payload coerces control dataJson null via ?? null
        const snap = db.processMapSnapshot.create.mock.calls[0][0].data.graphJson;
        expect(snap.edges[0].controls[0].dataJson).toBeNull();
    });

    it('omits version predicate + metadata edits when expectedVersion/name/etc omitted (last-write-wins, empty nodes, no controls)', async () => {
        db.processMap.findFirst
            .mockResolvedValueOnce({ id: 'm1', version: null }) // version null → newVersion = 0 + 1
            .mockResolvedValueOnce({
                id: 'm1',
                name: 'x',
                description: null,
                status: 'DRAFT',
                version: 1,
                createdAt: new Date(),
                updatedAt: new Date(),
                nodes: [],
                edges: [],
            });
        db.processMap.updateMany.mockResolvedValueOnce({ count: 1 });

        await ProcessMapRepository.replaceGraph(db as any, ctx, 'm1', {
            // no name/description/status, no expectedVersion
            nodes: [node({ nodeKey: 'n1' })], // single node so the edge validates
            edges: [edge({ sourceKey: 'n1', targetKey: 'n1', controls: [] })], // controls.length === 0 → control createMany skipped
        });

        // single node → createMany IS called (nodes.length > 0 branch)
        expect(db.processNode.createMany).toHaveBeenCalled();
        // edge created but no controls → control createMany skipped
        expect(db.processEdge.create).toHaveBeenCalled();
        expect(db.processEdgeControl.createMany).not.toHaveBeenCalled();

        const arg = db.processMap.updateMany.mock.calls[0][0];
        // no version predicate (last-write-wins)
        expect(arg.where.version).toBeUndefined();
        // metadata edits omitted
        expect(arg.data.name).toBeUndefined();
        expect(arg.data.description).toBeUndefined();
        expect(arg.data.status).toBeUndefined();
        expect(arg.data.version).toEqual({ increment: 1 });

        // newVersion = (null ?? 0) + 1 = 1
        expect(db.processMapSnapshot.create.mock.calls[0][0].data.version).toBe(1);
    });
});

describe('ProcessMapRepository.replaceGraph — edge controlId ownership', () => {
    /** Existence check + the final getByIdWithGraph re-read. */
    function primeMap() {
        db.processMap.findFirst
            .mockResolvedValueOnce({ id: 'm1', version: 1 })
            .mockResolvedValueOnce({
                id: 'm1',
                name: 'x',
                description: null,
                status: 'DRAFT',
                version: 2,
                createdAt: new Date(),
                updatedAt: new Date(),
                nodes: [],
                edges: [],
            });
        db.processEdge.create.mockResolvedValue({ id: 'edge-1' });
        db.processMap.updateMany.mockResolvedValueOnce({ count: 1 });
    }

    function graphWithControlIds(ids: (string | null)[]) {
        return {
            nodes: [node({ nodeKey: 'n1' })],
            edges: [
                edge({
                    sourceKey: 'n1',
                    targetKey: 'n1',
                    controls: ids.map((controlId, i) => ({
                        controlKey: `c${i}`,
                        label: `C${i}`,
                        controlId,
                        dataJson: null,
                    })),
                }),
            ],
        };
    }

    it('rejects the whole save when an edge references a control from another tenant', async () => {
        primeMap();
        // The foreign id simply does not come back from a tenant-scoped read.
        db.control.findMany.mockResolvedValueOnce([{ id: 'ctrl-mine' }]);

        await expect(
            ProcessMapRepository.replaceGraph(
                db as any,
                ctx,
                'm1',
                graphWithControlIds(['ctrl-mine', 'ctrl-theirs']) as any,
            ),
        ).rejects.toThrow(/do not belong to this tenant/);

        // Nothing was written — the check runs before the edge loop.
        expect(db.processEdge.create).not.toHaveBeenCalled();
        expect(db.processEdgeControl.createMany).not.toHaveBeenCalled();
    });

    it('scopes the ownership lookup to the tenant and asks once for the whole graph (no N+1)', async () => {
        primeMap();

        await ProcessMapRepository.replaceGraph(
            db as any,
            ctx,
            'm1',
            graphWithControlIds(['ctrl-a', 'ctrl-b', 'ctrl-a']) as any,
        );

        expect(db.control.findMany).toHaveBeenCalledTimes(1);
        const where = db.control.findMany.mock.calls[0][0].where;
        expect(where.tenantId).toBe(ctx.tenantId);
        // de-duplicated
        expect(where.id.in.slice().sort()).toEqual(['ctrl-a', 'ctrl-b']);
    });

    it('skips the lookup entirely when no edge control carries a controlId', async () => {
        primeMap();

        await ProcessMapRepository.replaceGraph(
            db as any,
            ctx,
            'm1',
            graphWithControlIds([null, null]) as any,
        );

        expect(db.control.findMany).not.toHaveBeenCalled();
        expect(db.processEdgeControl.createMany).toHaveBeenCalled();
    });
});

describe('ProcessMapRepository.listSnapshots', () => {
    it('orders by version desc, caps at 200, and flattens createdBy name', async () => {
        db.processMapSnapshot.findMany.mockResolvedValueOnce([
            {
                id: 's1',
                version: 3,
                createdAt: new Date(),
                createdByUserId: 'u1',
                createdBy: { name: 'Alice' },
            },
            {
                id: 's2',
                version: 2,
                createdAt: new Date(),
                createdByUserId: 'u2',
                createdBy: null, // ?? null branch
            },
        ]);
        const out = await ProcessMapRepository.listSnapshots(db as any, ctx, 'm1');
        const arg = db.processMapSnapshot.findMany.mock.calls[0][0];
        expect(arg.orderBy).toEqual({ version: 'desc' });
        expect(arg.take).toBe(200);
        expect(out[0].createdByName).toBe('Alice');
        expect(out[1].createdByName).toBeNull();
    });
});

describe('ProcessMapRepository.getSnapshotByVersion', () => {
    it('returns null when the version is not found', async () => {
        db.processMapSnapshot.findFirst.mockResolvedValueOnce(null);
        const out = await ProcessMapRepository.getSnapshotByVersion(
            db as any,
            ctx,
            'm1',
            5,
        );
        expect(out).toBeNull();
        const arg = db.processMapSnapshot.findFirst.mock.calls[0][0];
        expect(arg.where).toEqual({
            tenantId: ctx.tenantId,
            processMapId: 'm1',
            version: 5,
        });
    });

    it('maps the found snapshot and flattens createdBy name (?? null)', async () => {
        db.processMapSnapshot.findFirst.mockResolvedValueOnce({
            id: 's1',
            version: 5,
            graphJson: { nodes: [] },
            createdAt: new Date(),
            createdBy: null,
        });
        const out = await ProcessMapRepository.getSnapshotByVersion(
            db as any,
            ctx,
            'm1',
            5,
        );
        expect(out!.version).toBe(5);
        expect(out!.createdByName).toBeNull();
    });

    it('flattens a present createdBy name', async () => {
        db.processMapSnapshot.findFirst.mockResolvedValueOnce({
            id: 's1',
            version: 5,
            graphJson: {},
            createdAt: new Date(),
            createdBy: { name: 'Bob' },
        });
        const out = await ProcessMapRepository.getSnapshotByVersion(
            db as any,
            ctx,
            'm1',
            5,
        );
        expect(out!.createdByName).toBe('Bob');
    });
});

describe('ProcessMapRepository.softDelete', () => {
    it('returns true when a row matched', async () => {
        db.processMap.updateMany.mockResolvedValueOnce({ count: 1 });
        const ok = await ProcessMapRepository.softDelete(db as any, ctx, 'm1', 'u1');
        expect(ok).toBe(true);
        const arg = db.processMap.updateMany.mock.calls[0][0];
        expect(arg.where).toEqual({
            id: 'm1',
            tenantId: ctx.tenantId,
            deletedAt: null,
        });
        expect(arg.data.deletedByUserId).toBe('u1');
    });

    it('returns false when no row matched', async () => {
        db.processMap.updateMany.mockResolvedValueOnce({ count: 0 });
        const ok = await ProcessMapRepository.softDelete(db as any, ctx, 'm1', 'u1');
        expect(ok).toBe(false);
    });
});

describe('ProcessMapRepository.listMapsByControl', () => {
    it('filters out soft-deleted maps and maps the rest', async () => {
        db.processEdgeControl.findMany.mockResolvedValueOnce([
            {
                edge: {
                    edgeKey: 'e1',
                    labelOverride: 'L1',
                    processMap: {
                        id: 'm1',
                        name: 'Live',
                        status: 'PUBLISHED',
                        deletedAt: null,
                    },
                },
            },
            {
                edge: {
                    edgeKey: 'e2',
                    labelOverride: null,
                    processMap: {
                        id: 'm2',
                        name: 'Gone',
                        status: 'DRAFT',
                        deletedAt: new Date(), // filtered out
                    },
                },
            },
        ]);
        const out = await ProcessMapRepository.listMapsByControl(
            db as any,
            ctx,
            'ctrl-1',
        );
        const arg = db.processEdgeControl.findMany.mock.calls[0][0];
        expect(arg.where).toEqual({ tenantId: ctx.tenantId, controlId: 'ctrl-1' });
        expect(out).toHaveLength(1);
        expect(out[0].mapId).toBe('m1');
        expect(out[0].edgeLabel).toBe('L1');
    });

    it('returns empty when no rows', async () => {
        const out = await ProcessMapRepository.listMapsByControl(
            db as any,
            ctx,
            'ctrl-x',
        );
        expect(out).toEqual([]);
    });
});

describe('ProcessMapRepository.listMapsByLinkedEntity', () => {
    it('filters by tenant + nodeType + dataJson.linkedEntityId, drops soft-deleted', async () => {
        db.processNode.findMany.mockResolvedValueOnce([
            {
                nodeKey: 'n1',
                label: 'Prod DB',
                processMap: {
                    id: 'm1',
                    name: 'Live',
                    status: 'ACTIVE',
                    deletedAt: null,
                },
            },
            {
                nodeKey: 'n2',
                label: 'Old DB',
                processMap: {
                    id: 'm2',
                    name: 'Gone',
                    status: 'ARCHIVED',
                    deletedAt: new Date(), // filtered out
                },
            },
        ]);
        const out = await ProcessMapRepository.listMapsByLinkedEntity(
            db as any,
            ctx,
            'asset',
            'asset-1',
        );
        const arg = db.processNode.findMany.mock.calls[0][0];
        expect(arg.where).toEqual({
            tenantId: ctx.tenantId,
            nodeType: 'asset',
            dataJson: { path: ['linkedEntityId'], equals: 'asset-1' },
        });
        expect(out).toHaveLength(1);
        expect(out[0].mapId).toBe('m1');
        expect(out[0].nodeKey).toBe('n1');
        expect(out[0].nodeLabel).toBe('Prod DB');
    });

    it('passes the risk node kind through', async () => {
        await ProcessMapRepository.listMapsByLinkedEntity(
            db as any,
            ctx,
            'risk',
            'risk-7',
        );
        expect(db.processNode.findMany.mock.calls[0][0].where.nodeType).toBe(
            'risk',
        );
    });

    it('returns empty when no rows', async () => {
        const out = await ProcessMapRepository.listMapsByLinkedEntity(
            db as any,
            ctx,
            'risk',
            'risk-x',
        );
        expect(out).toEqual([]);
    });
});
