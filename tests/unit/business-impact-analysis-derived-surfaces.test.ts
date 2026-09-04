/**
 * The DERIVED read surfaces of the BIA usecase — the parts with no column of
 * their own: the recovery ordering the register is sorted by, the dependency
 * link resolution, and the two multi-hop chains (control → edge → node → BIA,
 * incident → control → edge → node → BIA).
 *
 * Both chains are a ladder of "if this hop resolved to nothing, stop". Each
 * rung looks identical from outside — an empty page — so a rung wired to the
 * wrong collection is invisible in the product and, worse, would leave the
 * next query running against an empty `in: []`. Each rung is therefore tested
 * for BOTH its return value AND the fact that the next hop was never issued.
 *
 * `deriveRecoveryPriority` / `rankFor` are the REAL service (they are pure),
 * so the ordering assertions are against the documented precedence rather than
 * against a stub that would agree with any implementation. One test overrides
 * `deriveRecoveryPriority` to omit a row from the rankings — that is the only
 * way to reach "the ranker could not place this BIA", which the code answers
 * with a 999 sentinel.
 */
jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/app-layer/services/bia-recovery-priority', () => {
    const actual = jest.requireActual('@/app-layer/services/bia-recovery-priority');
    return { ...actual, deriveRecoveryPriority: jest.fn(actual.deriveRecoveryPriority) };
});

import {
    listBias,
    getBia,
    getControlBiaSurface,
    getIncidentBiaContext,
    CONTINUITY_REQUIREMENT_CODES,
} from '@/app-layer/usecases/business-impact-analysis';
import { runInTenantContext } from '@/lib/db-context';
import { deriveRecoveryPriority } from '@/app-layer/services/bia-recovery-priority';
import { makeRequestContext } from '../helpers/make-context';
import { ForbiddenError, NotFoundError } from '@/lib/errors/types';

const actualPriority = jest.requireActual<typeof import('@/app-layer/services/bia-recovery-priority')>(
    '@/app-layer/services/bia-recovery-priority',
);
const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockDerive = deriveRecoveryPriority as jest.MockedFunction<typeof deriveRecoveryPriority>;
const ctx = makeRequestContext('ADMIN', { tenantId: 't-acme', userId: 'u-1' });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withDb<T extends Record<string, any>>(db: T): T {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRunInTx.mockImplementation(async (_c: any, fn: any) => fn(db));
    return db;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDerive.mockImplementation(actualPriority.deriveRecoveryPriority);
});

describe('listBias — recovery ordering', () => {
    it('re-orders the page by recovery priority rather than trusting the database order', async () => {
        const db = withDb({
            businessImpactAnalysis: {
                findMany: jest.fn().mockResolvedValue([
                    { id: 'b-low', criticality: 'LOW', mtpdHours: 1, rtoHours: 1 },
                    { id: 'b-crit-slow', criticality: 'CRITICAL', mtpdHours: 48, rtoHours: 24 },
                    { id: 'b-crit-fast', criticality: 'CRITICAL', mtpdHours: 2, rtoHours: 1 },
                ]),
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        const rows = await listBias(ctx);

        // Criticality first, then tightest MTPD — the LOW row leads on MTPD
        // and still recovers last.
        expect(rows.map((r) => r.id)).toStrictEqual(['b-crit-fast', 'b-crit-slow', 'b-low']);
        expect(rows.map((r) => r.recovery?.rank)).toStrictEqual([1, 2, 3]);
        expect(rows[0].recovery?.rationale).toBe('CRITICAL criticality · MTPD 2h · RTO 1h → recovery #1');
    });

    it('sorts BIAs the ranker could not place LAST, in their original relative order', async () => {
        // Only one of the three rows comes back ranked — the shape you get
        // when the ranking input was truncated. `rankFor` returns null for the
        // other two and they fall to the 999 sentinel, which must sink them
        // rather than float them (a `?? 0` would put the unrankable first).
        mockDerive.mockReturnValue([{ id: 'b-ranked', rank: 7, rationale: 'HIGH criticality → recovery #7' }]);
        const db = withDb({
            businessImpactAnalysis: {
                findMany: jest.fn().mockResolvedValue([
                    { id: 'b-ghost-a', criticality: 'CRITICAL', mtpdHours: 1, rtoHours: 1 },
                    { id: 'b-ranked', criticality: 'HIGH', mtpdHours: 99, rtoHours: 99 },
                    { id: 'b-ghost-b', criticality: 'CRITICAL', mtpdHours: 2, rtoHours: 1 },
                ]),
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        const rows = await listBias(ctx);

        expect(rows.map((r) => r.id)).toStrictEqual(['b-ranked', 'b-ghost-a', 'b-ghost-b']);
        expect(rows.map((r) => r.recovery)).toStrictEqual([
            { id: 'b-ranked', rank: 7, rationale: 'HIGH criticality → recovery #7' },
            null,
            null,
        ]);
        expect(db.businessImpactAnalysis.findMany).toHaveBeenCalledTimes(1);
    });

    it('clamps take at 500 and only filters by criticality when one was asked for', async () => {
        const db = withDb({
            businessImpactAnalysis: { findMany: jest.fn().mockResolvedValue([]) },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        await listBias(ctx, { take: 5_000, criticality: 'HIGH' });

        expect(db.businessImpactAnalysis.findMany.mock.calls[0][0]).toStrictEqual({
            where: { tenantId: 't-acme', criticality: 'HIGH' },
            include: {
                processNode: { select: { id: true, label: true } },
                ownerUser: { select: { id: true, name: true, email: true } },
                _count: { select: { dependencies: true } },
            },
            orderBy: [{ criticality: 'asc' }, { mtpdHours: 'asc' }],
            take: 500,
        });

        await listBias(ctx);

        expect(db.businessImpactAnalysis.findMany.mock.calls[1][0].where).toStrictEqual({ tenantId: 't-acme' });
        expect(db.businessImpactAnalysis.findMany.mock.calls[1][0].take).toBe(200);
    });

    it('refuses a context without read permission before opening a tenant transaction', async () => {
        const blind = makeRequestContext('READER', {
            tenantId: 't-acme',
            permissions: { canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        });

        await expect(listBias(blind)).rejects.toBeInstanceOf(ForbiddenError);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });
});

describe('getBia — dependency and control resolution', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function detailDb(bia: any, over: Record<string, unknown> = {}) {
        return withDb({
            businessImpactAnalysis: {
                findFirst: jest.fn().mockResolvedValue(bia),
                findMany: jest.fn().mockResolvedValue([
                    { id: 'bia-1', criticality: 'HIGH', mtpdHours: 4, rtoHours: 2 },
                ]),
            },
            processNode: { findMany: jest.fn().mockResolvedValue([]) },
            asset: { findMany: jest.fn().mockResolvedValue([]) },
            vendor: { findMany: jest.fn().mockResolvedValue([]) },
            risk: { findMany: jest.fn().mockResolvedValue([]) },
            control: { findMany: jest.fn().mockResolvedValue([]) },
            controlRequirementLink: { findMany: jest.fn().mockResolvedValue([]) },
            ...over,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
    }

    it('renders a deleted dependency target as a plain, non-navigable label', async () => {
        const db = detailDb({
            id: 'bia-1',
            name: 'Payroll',
            dependencies: [
                { id: 'dep-live', dependsOnType: 'VENDOR', dependsOnId: 'vendor-1' },
                { id: 'dep-gone', dependsOnType: 'VENDOR', dependsOnId: 'vendor-deleted' },
            ],
            evidenceLinks: [],
        }, {
            vendor: { findMany: jest.fn().mockResolvedValue([{ id: 'vendor-1', name: 'Acme Payroll' }]) },
        });

        const res = await getBia(ctx, 'bia-1');

        expect(res.dependencies).toStrictEqual([
            {
                id: 'dep-live',
                dependsOnType: 'VENDOR',
                dependsOnId: 'vendor-1',
                targetName: 'Acme Payroll',
                targetPath: '/vendors/vendor-1',
            },
            {
                id: 'dep-gone',
                dependsOnType: 'VENDOR',
                dependsOnId: 'vendor-deleted',
                targetName: null,
                targetPath: null,
            },
        ]);
        // One query for the type in play, none for the three that are not.
        expect(db.vendor.findMany.mock.calls[0][0]).toStrictEqual({
            where: { tenantId: 't-acme', id: { in: ['vendor-1', 'vendor-deleted'] } },
            select: { id: true, name: true },
            take: 200,
        });
        expect(db.asset.findMany).not.toHaveBeenCalled();
        expect(db.risk.findMany).not.toHaveBeenCalled();
        expect(db.processNode.findMany).not.toHaveBeenCalled();
    });

    it('groups every requirement onto its control, leaves an unmapped control with none, and reads each control once', async () => {
        const db = detailDb({
            id: 'bia-1',
            name: 'Payroll',
            dependencies: [],
            evidenceLinks: [
                { id: 'ev-1', controlId: 'c-continuity' },
                { id: 'ev-2', controlId: 'c-continuity' },
                { id: 'ev-3', controlId: 'c-plain' },
            ],
        }, {
            control: {
                findMany: jest.fn().mockResolvedValue([
                    { id: 'c-continuity', name: 'ICT continuity plan', code: 'A.5.30' },
                    { id: 'c-plain', name: 'Clear desk', code: null },
                ]),
            },
            controlRequirementLink: {
                findMany: jest.fn().mockResolvedValue([
                    {
                        controlId: 'c-continuity',
                        requirement: { code: 'Art.21(2)(c)', title: 'Business continuity', framework: { key: 'NIS2', name: 'NIS2 Directive' } },
                    },
                    {
                        controlId: 'c-continuity',
                        requirement: { code: 'A.5.30', title: 'ICT readiness', framework: { key: 'ISO27001', name: 'ISO/IEC 27001' } },
                    },
                ]),
            },
        });

        const res = await getBia(ctx, 'bia-1');

        expect(res.linkedControls).toStrictEqual([
            {
                id: 'c-continuity',
                name: 'ICT continuity plan',
                code: 'A.5.30',
                requirements: [
                    { code: 'Art.21(2)(c)', title: 'Business continuity', frameworkKey: 'NIS2', frameworkName: 'NIS2 Directive' },
                    { code: 'A.5.30', title: 'ICT readiness', frameworkKey: 'ISO27001', frameworkName: 'ISO/IEC 27001' },
                ],
            },
            // No requirement link — the truthful answer is an empty list, not
            // a fabricated framework badge.
            { id: 'c-plain', name: 'Clear desk', code: null, requirements: [] },
        ]);
        // The duplicate evidence link must not duplicate the control query.
        expect(db.control.findMany.mock.calls[0][0]).toStrictEqual({
            where: { tenantId: 't-acme', id: { in: ['c-continuity', 'c-plain'] } },
            select: { id: true, name: true, code: true },
            take: 100,
        });
    });

    it('raises notFound for a BIA outside this tenant, before any enrichment query', async () => {
        const db = detailDb(null);

        await expect(getBia(ctx, 'bia-other-tenant')).rejects.toBeInstanceOf(NotFoundError);
        expect(db.businessImpactAnalysis.findMany).not.toHaveBeenCalled();
        expect(db.control.findMany).not.toHaveBeenCalled();
    });
});

describe('getControlBiaSurface — the no-dead-tab ladder', () => {
    const surfaceDb = (over: Record<string, unknown>) => withDb({
        controlRequirementLink: { findMany: jest.fn().mockResolvedValue([]) },
        processEdgeControl: { findMany: jest.fn().mockResolvedValue([{ edgeId: 'edge-1' }]) },
        processEdge: { findMany: jest.fn().mockResolvedValue([]) },
        processNode: { findMany: jest.fn().mockResolvedValue([]) },
        businessImpactAnalysis: { findMany: jest.fn().mockResolvedValue([]) },
        ...over,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    it('asks for the continuity requirement by code OR a renamed title, and stops at none when the edges resolve to nothing', async () => {
        const db = surfaceDb({});

        await expect(getControlBiaSurface(ctx, 'c-1')).resolves.toStrictEqual({ kind: 'none' });

        expect(db.controlRequirementLink.findMany.mock.calls[0][0]).toStrictEqual({
            where: {
                tenantId: 't-acme',
                controlId: 'c-1',
                requirement: {
                    OR: [
                        { code: { in: ['Art.21(2)(c)', 'A.5.29', 'A.5.30'] } },
                        { title: { contains: 'continuit', mode: 'insensitive' } },
                    ],
                },
            },
            select: { id: true },
            take: 1,
        });
        expect([...CONTINUITY_REQUIREMENT_CODES]).toStrictEqual(['Art.21(2)(c)', 'A.5.29', 'A.5.30']);
        expect(db.processEdge.findMany.mock.calls[0][0]).toStrictEqual({
            where: { tenantId: 't-acme', id: { in: ['edge-1'] } },
            select: { processMapId: true, sourceKey: true, targetKey: true },
            take: 400,
        });
        // The edges resolved to no node keys — the node query must not run
        // with an empty `in`.
        expect(db.processNode.findMany).not.toHaveBeenCalled();
    });

    it('stops at none when the edge keys resolve to no nodes, deduplicating the keys it asks for', async () => {
        const db = surfaceDb({
            processEdgeControl: { findMany: jest.fn().mockResolvedValue([{ edgeId: 'edge-1' }, { edgeId: 'edge-2' }]) },
            processEdge: {
                findMany: jest.fn().mockResolvedValue([
                    { processMapId: 'map-1', sourceKey: 'step-a', targetKey: 'step-b' },
                    { processMapId: 'map-1', sourceKey: 'step-b', targetKey: 'step-c' },
                ]),
            },
        });

        await expect(getControlBiaSurface(ctx, 'c-1')).resolves.toStrictEqual({ kind: 'none' });

        expect(db.processNode.findMany.mock.calls[0][0]).toStrictEqual({
            where: {
                tenantId: 't-acme',
                processMapId: { in: ['map-1'] },
                nodeKey: { in: ['step-a', 'step-b', 'step-c'] },
            },
            select: { id: true, label: true },
            take: 400,
        });
        expect(db.businessImpactAnalysis.findMany).not.toHaveBeenCalled();
    });

    it('stops at none when the protected nodes carry no BIA, without ranking the tenant set', async () => {
        const db = surfaceDb({
            processEdge: { findMany: jest.fn().mockResolvedValue([{ processMapId: 'map-1', sourceKey: 'step-a', targetKey: 'step-b' }]) },
            processNode: { findMany: jest.fn().mockResolvedValue([{ id: 'node-1', label: 'Payroll run' }]) },
        });

        await expect(getControlBiaSurface(ctx, 'c-1')).resolves.toStrictEqual({ kind: 'none' });

        expect(db.businessImpactAnalysis.findMany).toHaveBeenCalledTimes(1);
        expect(db.businessImpactAnalysis.findMany.mock.calls[0][0]).toStrictEqual({
            where: { tenantId: 't-acme', processNodeId: { in: ['node-1'] } },
            select: { id: true, name: true, criticality: true, mtpdHours: true, rtoHours: true, processNodeId: true },
            take: 100,
        });
        expect(mockDerive).not.toHaveBeenCalled();
    });

    it('chips the ranked BIA over an unranked one and falls back to the BIA name when its node is not in the resolved set', async () => {
        // `bia-ghost` is protected but absent from the (take-500) tenant set,
        // so it has no rank; `bia-top` is ranked and must win despite being
        // the less critical of the two. `bia-top` hangs off a node beyond the
        // node query's own take, so there is no label to show for it.
        const db = surfaceDb({
            processEdge: { findMany: jest.fn().mockResolvedValue([{ processMapId: 'map-1', sourceKey: 'step-a', targetKey: 'step-b' }]) },
            processNode: { findMany: jest.fn().mockResolvedValue([{ id: 'node-1', label: 'Payroll run' }]) },
            businessImpactAnalysis: {
                findMany: jest
                    .fn()
                    .mockResolvedValueOnce([
                        { id: 'bia-ghost', name: 'Ghost BIA', criticality: 'CRITICAL', mtpdHours: 1, rtoHours: 1, processNodeId: 'node-1' },
                        { id: 'bia-top', name: 'Payroll BIA', criticality: 'HIGH', mtpdHours: 4, rtoHours: 2, processNodeId: 'node-unresolved' },
                    ])
                    .mockResolvedValueOnce([
                        { id: 'bia-top', criticality: 'HIGH', mtpdHours: 4, rtoHours: 2 },
                    ]),
            },
        });

        await expect(getControlBiaSurface(ctx, 'c-1')).resolves.toStrictEqual({
            kind: 'process',
            processLabel: 'Payroll BIA',
            biaId: 'bia-top',
            name: 'Payroll BIA',
            mtpdHours: 4,
            recoveryRank: 1,
        });
    });
});

describe('getIncidentBiaContext — recovery deadline chain', () => {
    const incidentDb = (over: Record<string, unknown>) => withDb({
        incident: { findFirst: jest.fn().mockResolvedValue({ linkedControlIds: ['c-1', 'c-2'] }) },
        processEdgeControl: { findMany: jest.fn().mockResolvedValue([{ edgeId: 'edge-1' }]) },
        processEdge: { findMany: jest.fn().mockResolvedValue([]) },
        processNode: { findMany: jest.fn().mockResolvedValue([]) },
        businessImpactAnalysis: { findMany: jest.fn().mockResolvedValue([]) },
        ...over,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    it('returns nothing for an incident outside this tenant, without walking the chain', async () => {
        const db = incidentDb({ incident: { findFirst: jest.fn().mockResolvedValue(null) } });

        await expect(getIncidentBiaContext(ctx, 'inc-other-tenant')).resolves.toStrictEqual([]);

        expect(db.incident.findFirst.mock.calls[0][0]).toStrictEqual({
            where: { id: 'inc-other-tenant', tenantId: 't-acme' },
            select: { linkedControlIds: true },
        });
        expect(db.processEdgeControl.findMany).not.toHaveBeenCalled();
    });

    it('queries the edges of every linked control at once and stops when they resolve to no nodes', async () => {
        const db = incidentDb({});

        await expect(getIncidentBiaContext(ctx, 'inc-1')).resolves.toStrictEqual([]);

        expect(db.processEdgeControl.findMany.mock.calls[0][0]).toStrictEqual({
            where: { tenantId: 't-acme', controlId: { in: ['c-1', 'c-2'] } },
            select: { edgeId: true },
            take: 500,
        });
        expect(db.processNode.findMany).not.toHaveBeenCalled();
    });

    it('stops when the edge keys resolve to no nodes, without querying BIAs on an empty node set', async () => {
        const db = incidentDb({
            processEdge: { findMany: jest.fn().mockResolvedValue([{ processMapId: 'map-1', sourceKey: 'step-a', targetKey: 'step-b' }]) },
        });

        await expect(getIncidentBiaContext(ctx, 'inc-1')).resolves.toStrictEqual([]);

        expect(db.processNode.findMany.mock.calls[0][0]).toStrictEqual({
            where: { tenantId: 't-acme', processMapId: { in: ['map-1'] }, nodeKey: { in: ['step-a', 'step-b'] } },
            select: { id: true },
            take: 500,
        });
        expect(db.businessImpactAnalysis.findMany).not.toHaveBeenCalled();
    });

    it('asks the database for the tightest-MTPD BIAs of the protected nodes', async () => {
        const rows = [{ id: 'bia-1', name: 'Payroll', criticality: 'CRITICAL', mtpdHours: 2, rtoHours: 1 }];
        const db = incidentDb({
            processEdge: { findMany: jest.fn().mockResolvedValue([{ processMapId: 'map-1', sourceKey: 'step-a', targetKey: 'step-b' }]) },
            processNode: { findMany: jest.fn().mockResolvedValue([{ id: 'node-1' }, { id: 'node-2' }]) },
            businessImpactAnalysis: { findMany: jest.fn().mockResolvedValue(rows) },
        });

        await expect(getIncidentBiaContext(ctx, 'inc-1')).resolves.toStrictEqual(rows);

        expect(db.businessImpactAnalysis.findMany.mock.calls[0][0]).toStrictEqual({
            where: { tenantId: 't-acme', processNodeId: { in: ['node-1', 'node-2'] } },
            select: { id: true, name: true, criticality: true, mtpdHours: true, rtoHours: true },
            orderBy: { mtpdHours: 'asc' },
            take: 20,
        });
    });
});
