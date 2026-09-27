/**
 * Unit coverage for the Business Impact Analysis usecase.
 *
 * DB-bound CRUD + the conditional control/incident wiring resolvers are driven
 * with a mocked `runInTenantContext` + `db`, so every validation / notFound /
 * case-4a/4b/4c branch is exercised without a live database.
 */
jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('../../src/app-layer/policies/common', () => ({ assertCanRead: jest.fn(), assertCanWrite: jest.fn() }));
jest.mock('../../src/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/security/sanitize', () => ({ sanitizePlainText: (s: string) => s }));
jest.mock('../../src/app-layer/services/bia-recovery-priority', () => ({
    deriveRecoveryPriority: jest.fn(() => []),
    rankFor: jest.fn(() => ({ rank: 1 })),
}));

import {
    createBia, listBias, getBia, updateBia, deleteBia, linkBiaToControl,
    getControlBiaSurface, getBiasForProcessNode, getBiasForProcessNodeKey, getIncidentBiaContext,
    listBiaDependencyOptions, addBiaDependency, removeBiaDependency,
} from '@/app-layer/usecases/business-impact-analysis';
import { runInTenantContext } from '@/lib/db-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (over: any = {}): any => ({ tenantId: 't1', userId: 'u1', role: 'ADMIN', ...over });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withDb(db: any) { mockRunInTx.mockImplementation(async (_c: any, fn: any) => fn(db)); }

beforeEach(() => jest.clearAllMocks());

describe('createBia', () => {
    function db(over: Record<string, unknown> = {}) {
        return {
            processNode: { findFirst: jest.fn().mockResolvedValue({ processMapId: 'm1', nodeKey: 'k1' }), findMany: jest.fn().mockResolvedValue([]) },
            asset: { findMany: jest.fn().mockResolvedValue([]) },
            vendor: { findMany: jest.fn().mockResolvedValue([{ id: 'v1' }]) },
            risk: { findMany: jest.fn().mockResolvedValue([]) },
            businessImpactAnalysis: { create: jest.fn().mockResolvedValue({ id: 'b1', name: 'Payroll' }) },
            biaDependency: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
            ...over,
        };
    }
    it('creates a BIA with dependencies + a valid process node', async () => {
        const d = db();
        withDb(d);
        const res = await createBia(ctx(), {
            name: 'Payroll', criticality: 'HIGH', processNodeId: 'n1',
            dependencies: [{ dependsOnType: 'VENDOR', dependsOnId: 'v1' }],
        });
        expect(res).toMatchObject({ id: 'b1' });
        expect(d.biaDependency.createMany).toHaveBeenCalled();
    });
    it('creates a BIA with no process node and no dependencies', async () => {
        const d = db();
        withDb(d);
        await createBia(ctx(), { name: 'Simple', criticality: 'LOW' });
        expect(d.biaDependency.createMany).not.toHaveBeenCalled();
        expect(d.processNode.findFirst).not.toHaveBeenCalled();
    });
    it('accepts a RISK dependency (new type, no migration)', async () => {
        const d = db({ risk: { findMany: jest.fn().mockResolvedValue([{ id: 'r1' }]) } });
        withDb(d);
        await createBia(ctx(), {
            name: 'Payroll', criticality: 'HIGH',
            dependencies: [{ dependsOnType: 'RISK', dependsOnId: 'r1' }],
        });
        expect(d.biaDependency.createMany).toHaveBeenCalled();
    });
    it('rejects a dependency whose target is not in the tenant', async () => {
        withDb(db({ vendor: { findMany: jest.fn().mockResolvedValue([]) } }));
        await expect(
            createBia(ctx(), { name: 'X', criticality: 'HIGH', dependencies: [{ dependsOnType: 'VENDOR', dependsOnId: 'gone' }] }),
        ).rejects.toThrow(/INVALID_DEPENDENCY_TARGET/);
    });
    it('rejects an invalid process node', async () => {
        withDb(db({ processNode: { findFirst: jest.fn().mockResolvedValue(null) } }));
        await expect(createBia(ctx(), { name: 'X', criticality: 'HIGH', processNodeId: 'missing' })).rejects.toThrow(/INVALID_PROCESS_NODE/);
    });
    it('rejects a schema-invalid criticality', async () => {
        withDb(db());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(createBia(ctx(), { name: 'X', criticality: 'NOPE' } as any)).rejects.toBeDefined();
    });
});

describe('listBias', () => {
    it('lists with a criticality filter and ranks the set', async () => {
        withDb({ businessImpactAnalysis: { findMany: jest.fn().mockResolvedValue([{ id: 'b1', criticality: 'HIGH', mtpdHours: 4, rtoHours: 2 }]) } });
        const rows = await listBias(ctx(), { criticality: 'HIGH', take: 10 });
        expect(rows[0]).toMatchObject({ id: 'b1', recovery: { rank: 1 } });
    });
    it('lists with no options (default take, no filter)', async () => {
        withDb({ businessImpactAnalysis: { findMany: jest.fn().mockResolvedValue([]) } });
        await expect(listBias(ctx())).resolves.toEqual([]);
    });
});

describe('getBia', () => {
    it('throws notFound when missing', async () => {
        withDb({ businessImpactAnalysis: { findFirst: jest.fn().mockResolvedValue(null) } });
        await expect(getBia(ctx(), 'x')).rejects.toThrow(/not found/i);
    });
    it('returns the BIA with a recovery rank and enriched (empty) links', async () => {
        withDb({ businessImpactAnalysis: {
            findFirst: jest.fn().mockResolvedValue({ id: 'b1', name: 'P', dependencies: [], evidenceLinks: [] }),
            findMany: jest.fn().mockResolvedValue([{ id: 'b1', criticality: 'HIGH', mtpdHours: 1, rtoHours: 1 }]),
        } });
        await expect(getBia(ctx(), 'b1')).resolves.toMatchObject({ id: 'b1', recovery: { rank: 1 }, dependencies: [], linkedControls: [] });
    });
    it('resolves dependency targets + linked-control frameworks', async () => {
        withDb({
            businessImpactAnalysis: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'b1', name: 'P',
                    dependencies: [{ id: 'd1', dependsOnType: 'ASSET', dependsOnId: 'a1' }],
                    evidenceLinks: [{ id: 'e1', controlId: 'c1' }],
                }),
                findMany: jest.fn().mockResolvedValue([{ id: 'b1', criticality: 'HIGH', mtpdHours: 1, rtoHours: 1 }]),
            },
            processNode: { findMany: jest.fn().mockResolvedValue([]) },
            asset: { findMany: jest.fn().mockResolvedValue([{ id: 'a1', name: 'DB server' }]) },
            vendor: { findMany: jest.fn().mockResolvedValue([]) },
            risk: { findMany: jest.fn().mockResolvedValue([]) },
            control: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Continuity', code: 'A.5.29' }]) },
            controlRequirementLink: { findMany: jest.fn().mockResolvedValue([
                { controlId: 'c1', requirement: { code: 'Art.21(2)(c)', title: 'BCM', framework: { key: 'NIS2', name: 'NIS2' } } },
            ]) },
        });
        const res = await getBia(ctx(), 'b1');
        expect(res.dependencies[0]).toMatchObject({ targetName: 'DB server', targetPath: '/assets/a1' });
        expect(res.linkedControls[0]).toMatchObject({ id: 'c1', code: 'A.5.29', requirements: [{ frameworkName: 'NIS2', code: 'Art.21(2)(c)' }] });
    });
});

describe('listBiaDependencyOptions', () => {
    it('returns { id, label } for assets', async () => {
        withDb({ asset: { findMany: jest.fn().mockResolvedValue([{ id: 'a1', name: 'DB' }]) } });
        await expect(listBiaDependencyOptions(ctx(), 'ASSET')).resolves.toEqual([{ id: 'a1', label: 'DB' }]);
    });
    it('returns { id, label } for risks (title → label)', async () => {
        withDb({ risk: { findMany: jest.fn().mockResolvedValue([{ id: 'r1', title: 'Outage' }]) } });
        await expect(listBiaDependencyOptions(ctx(), 'RISK')).resolves.toEqual([{ id: 'r1', label: 'Outage' }]);
    });
});

describe('addBiaDependency / removeBiaDependency', () => {
    it('adds a validated dependency', async () => {
        const create = jest.fn().mockResolvedValue({ id: 'd1' });
        withDb({
            businessImpactAnalysis: { findFirst: jest.fn().mockResolvedValue({ id: 'b1' }) },
            asset: { findMany: jest.fn().mockResolvedValue([{ id: 'a1' }]) },
            processNode: { findMany: jest.fn().mockResolvedValue([]) },
            vendor: { findMany: jest.fn().mockResolvedValue([]) },
            risk: { findMany: jest.fn().mockResolvedValue([]) },
            biaDependency: { create },
        });
        await expect(addBiaDependency(ctx(), 'b1', { dependsOnType: 'ASSET', dependsOnId: 'a1' })).resolves.toEqual({ id: 'd1' });
        expect(create).toHaveBeenCalled();
    });
    it('rejects adding to a missing BIA', async () => {
        withDb({ businessImpactAnalysis: { findFirst: jest.fn().mockResolvedValue(null) } });
        await expect(addBiaDependency(ctx(), 'x', { dependsOnType: 'ASSET', dependsOnId: 'a1' })).rejects.toThrow(/not found/i);
    });
    it('removes an existing dependency', async () => {
        const del = jest.fn().mockResolvedValue({});
        withDb({ biaDependency: { findFirst: jest.fn().mockResolvedValue({ id: 'd1' }), delete: del } });
        await expect(removeBiaDependency(ctx(), 'b1', 'd1')).resolves.toEqual({ id: 'd1' });
        expect(del).toHaveBeenCalled();
    });
    it('throws when removing a missing dependency', async () => {
        withDb({ biaDependency: { findFirst: jest.fn().mockResolvedValue(null) } });
        await expect(removeBiaDependency(ctx(), 'b1', 'gone')).rejects.toThrow(/not found/i);
    });
});

describe('updateBia', () => {
    function d(existing: unknown) {
        return {
            businessImpactAnalysis: {
                findFirst: jest.fn().mockResolvedValue(existing),
                update: jest.fn().mockResolvedValue({ id: 'b1', name: 'New' }),
            },
            processNode: { findFirst: jest.fn().mockResolvedValue({ id: 'n1' }) },
        };
    }
    it('throws notFound when missing', async () => {
        withDb(d(null));
        await expect(updateBia(ctx(), 'x', { name: 'y' })).rejects.toThrow(/not found/i);
    });
    it('applies the provided fields (name/criticality/reviewedAt set)', async () => {
        const db = d({ id: 'b1' });
        withDb(db);
        await updateBia(ctx(), 'b1', { name: 'New', criticality: 'CRITICAL', reviewedAt: '2026-01-01T00:00:00.000Z' });
        expect(db.businessImpactAnalysis.update).toHaveBeenCalled();
    });
    it('handles a null reviewedAt and null notes', async () => {
        const db = d({ id: 'b1' });
        withDb(db);
        await updateBia(ctx(), 'b1', { reviewedAt: null, notes: null });
        expect(db.businessImpactAnalysis.update).toHaveBeenCalled();
    });
});

describe('deleteBia', () => {
    it('throws notFound when missing', async () => {
        withDb({ businessImpactAnalysis: { findFirst: jest.fn().mockResolvedValue(null) } });
        await expect(deleteBia(ctx(), 'x')).rejects.toThrow(/not found/i);
    });
    it('deletes an existing BIA', async () => {
        const del = jest.fn().mockResolvedValue({});
        withDb({ businessImpactAnalysis: { findFirst: jest.fn().mockResolvedValue({ id: 'b1', name: 'P' }), delete: del } });
        await expect(deleteBia(ctx(), 'b1')).resolves.toEqual({ id: 'b1' });
        expect(del).toHaveBeenCalled();
    });
});

describe('linkBiaToControl', () => {
    it('throws notFound when the BIA is missing', async () => {
        withDb({ businessImpactAnalysis: { findFirst: jest.fn().mockResolvedValue(null) }, control: { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) } });
        await expect(linkBiaToControl(ctx(), 'b', 'c')).rejects.toThrow(/BIA not found/i);
    });
    it('rejects a missing control', async () => {
        withDb({ businessImpactAnalysis: { findFirst: jest.fn().mockResolvedValue({ id: 'b1', name: 'P' }) }, control: { findFirst: jest.fn().mockResolvedValue(null) } });
        await expect(linkBiaToControl(ctx(), 'b', 'c')).rejects.toThrow(/INVALID_CONTROL/);
    });
    it('upserts the evidence link', async () => {
        const upsert = jest.fn().mockResolvedValue({ id: 'link1' });
        withDb({
            businessImpactAnalysis: { findFirst: jest.fn().mockResolvedValue({ id: 'b1', name: 'P' }) },
            control: { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) },
            controlEvidenceLink: { upsert },
        });
        await expect(linkBiaToControl(ctx(), 'b1', 'c1')).resolves.toEqual({ id: 'link1' });
    });
});

describe('getControlBiaSurface', () => {
    it('(a) continuity control → linked BIAs', async () => {
        withDb({
            controlRequirementLink: { findMany: jest.fn().mockResolvedValue([{ id: 'rl1' }]) },
            controlEvidenceLink: { findMany: jest.fn().mockResolvedValue([{ bia: { id: 'b1', name: 'P', criticality: 'HIGH', mtpdHours: 4 } }, { bia: null }]) },
        });
        const res = await getControlBiaSurface(ctx(), 'c1');
        expect(res).toMatchObject({ kind: 'continuity', bias: [{ id: 'b1' }] });
    });
    it('(c) none — no continuity link and no protected process edges', async () => {
        withDb({
            controlRequirementLink: { findMany: jest.fn().mockResolvedValue([]) },
            processEdgeControl: { findMany: jest.fn().mockResolvedValue([]) },
        });
        await expect(getControlBiaSurface(ctx(), 'c1')).resolves.toEqual({ kind: 'none' });
    });
    it('(b) process-protecting control → derived impact chip', async () => {
        withDb({
            controlRequirementLink: { findMany: jest.fn().mockResolvedValue([]) },
            processEdgeControl: { findMany: jest.fn().mockResolvedValue([{ edgeId: 'e1' }]) },
            processEdge: { findMany: jest.fn().mockResolvedValue([{ processMapId: 'm1', sourceKey: 's', targetKey: 't' }]) },
            processNode: { findMany: jest.fn().mockResolvedValue([{ processMapId: 'm1', nodeKey: 'k1', label: 'Payroll node' }]) },
            businessImpactAnalysis: {
                findMany: jest.fn()
                    .mockResolvedValueOnce([{ id: 'b1', name: 'P', criticality: 'HIGH', mtpdHours: 2, rtoHours: 1, processMapId: 'm1', processNodeKey: 'k1' }])
                    .mockResolvedValueOnce([{ id: 'b1', criticality: 'HIGH', mtpdHours: 2, rtoHours: 1 }]),
            },
        });
        const res = await getControlBiaSurface(ctx(), 'c1');
        expect(res).toMatchObject({ kind: 'process', biaId: 'b1', processLabel: 'Payroll node' });
    });
});

describe('getBiasForProcessNode(Key)', () => {
    it('lists BIAs for a node', async () => {
        // The cuid is resolved to the natural key first (#2971) — the wire
        // still accepts an id, the storage no longer uses one.
        withDb({
            processNode: { findFirst: jest.fn().mockResolvedValue({ processMapId: 'm1', nodeKey: 'k1' }) },
            businessImpactAnalysis: { findMany: jest.fn().mockResolvedValue([{ id: 'b1' }]) },
        });
        await expect(getBiasForProcessNode(ctx(), 'n1')).resolves.toEqual([{ id: 'b1' }]);
    });
    it('a node that no longer exists reads as no BIAs, not an error', async () => {
        // The write path rejects an unresolvable id; a READ must not, or a
        // deleted node turns every cross-link into a 400.
        withDb({ processNode: { findFirst: jest.fn().mockResolvedValue(null) } });
        await expect(getBiasForProcessNode(ctx(), 'gone')).resolves.toEqual([]);
    });
    it('key resolver returns empty when the node is not found', async () => {
        withDb({ processNode: { findFirst: jest.fn().mockResolvedValue(null) } });
        await expect(getBiasForProcessNodeKey(ctx(), 'm1', 'k1')).resolves.toEqual({ processNodeId: null, rows: [] });
    });
    it('key resolver returns rows for a resolved node', async () => {
        withDb({
            processNode: { findFirst: jest.fn().mockResolvedValue({ id: 'n1' }) },
            businessImpactAnalysis: { findMany: jest.fn().mockResolvedValue([{ id: 'b1' }]) },
        });
        await expect(getBiasForProcessNodeKey(ctx(), 'm1', 'k1')).resolves.toEqual({ processNodeId: 'n1', rows: [{ id: 'b1' }] });
    });
});

describe('getIncidentBiaContext', () => {
    it('returns [] when the incident has no linked controls', async () => {
        withDb({ incident: { findFirst: jest.fn().mockResolvedValue({ linkedControlIds: [] }) } });
        await expect(getIncidentBiaContext(ctx(), 'i1')).resolves.toEqual([]);
    });
    it('returns [] when no process edges reach a BIA', async () => {
        withDb({
            incident: { findFirst: jest.fn().mockResolvedValue({ linkedControlIds: ['c1'] }) },
            processEdgeControl: { findMany: jest.fn().mockResolvedValue([]) },
        });
        await expect(getIncidentBiaContext(ctx(), 'i1')).resolves.toEqual([]);
    });
    it('resolves control → process → BIA and returns tightest-MTPD BIAs', async () => {
        withDb({
            incident: { findFirst: jest.fn().mockResolvedValue({ linkedControlIds: ['c1'] }) },
            processEdgeControl: { findMany: jest.fn().mockResolvedValue([{ edgeId: 'e1' }]) },
            processEdge: { findMany: jest.fn().mockResolvedValue([{ processMapId: 'm1', sourceKey: 's', targetKey: 't' }]) },
            processNode: { findMany: jest.fn().mockResolvedValue([{ id: 'n1' }]) },
            businessImpactAnalysis: { findMany: jest.fn().mockResolvedValue([{ id: 'b1', name: 'P', criticality: 'HIGH', mtpdHours: 1, rtoHours: 1 }]) },
        });
        await expect(getIncidentBiaContext(ctx(), 'i1')).resolves.toEqual([{ id: 'b1', name: 'P', criticality: 'HIGH', mtpdHours: 1, rtoHours: 1 }]);
    });
});
