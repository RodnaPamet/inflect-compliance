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
    BIA_RANK_POPULATION_CAP,
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

type PopulationRow = { id: string; criticality: string; mtpdHours: number | null; rtoHours: number | null; reviewedAt?: Date | null };

/**
 * The register reads twice: the ranking population (a `select` of four
 * columns), then the page by id. This answers each from one list, so a test
 * states the register once.
 */
function registerDb(population: PopulationRow[]) {
    return withDb({
        businessImpactAnalysis: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            findMany: jest.fn(async (args: any) => {
                if (args.select) return population.map((p) => ({ reviewedAt: null, ...p }));
                const ids: string[] = args.where.id.in;
                return population.filter((p) => ids.includes(p.id)).map((p) => ({ ...p, name: p.id }));
            }),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
}

describe('listBias — recovery ordering', () => {
    it('re-orders the page by recovery priority rather than trusting the database order', async () => {
        registerDb([
            { id: 'b-low', criticality: 'LOW', mtpdHours: 1, rtoHours: 1 },
            { id: 'b-crit-slow', criticality: 'CRITICAL', mtpdHours: 48, rtoHours: 24 },
            { id: 'b-crit-fast', criticality: 'CRITICAL', mtpdHours: 2, rtoHours: 1 },
        ]);

        const { rows } = await listBias(ctx);

        // Criticality first, then tightest MTPD — the LOW row leads on MTPD
        // and still recovers last.
        expect(rows.map((r) => r.id)).toStrictEqual(['b-crit-fast', 'b-crit-slow', 'b-low']);
        expect(rows.map((r) => r.recovery?.rank)).toStrictEqual([1, 2, 3]);
        expect(rows[0].recovery?.rationale).toBe('CRITICAL criticality · MTPD 2h · RTO 1h → recovery #1');
    });

    it('picks the page by recovery rank over the whole register, not by the criticality spelling (#4632)', async () => {
        // Alphabetically CRITICAL < HIGH < LOW < MEDIUM, so a page cut by the
        // stored string kept the Low analysis and dropped the Medium one.
        const db = registerDb([
            { id: 'b-low', criticality: 'LOW', mtpdHours: 1, rtoHours: 1 },
            { id: 'b-medium', criticality: 'MEDIUM', mtpdHours: 1, rtoHours: 1 },
            { id: 'b-critical', criticality: 'CRITICAL', mtpdHours: 1, rtoHours: 1 },
        ]);

        const register = await listBias(ctx, { take: 2 });

        expect(register.rows.map((r) => [r.id, r.recovery?.rank])).toStrictEqual([['b-critical', 1], ['b-medium', 2]]);
        expect(register.truncated).toBe(true);
        expect(register.rankComplete).toBe(true);
        // The page read asks for exactly the ranked ids.
        expect(db.businessImpactAnalysis.findMany.mock.calls[1][0].where).toStrictEqual({
            tenantId: 't-acme', id: { in: ['b-critical', 'b-medium'] },
        });
    });

    it('ranks a filtered page in the WHOLE register, so its "#" matches the analysis page', async () => {
        registerDb([
            { id: 'b-crit', criticality: 'CRITICAL', mtpdHours: 1, rtoHours: 1 },
            { id: 'b-high-a', criticality: 'HIGH', mtpdHours: 2, rtoHours: 1 },
            { id: 'b-high-b', criticality: 'HIGH', mtpdHours: 9, rtoHours: 1 },
        ]);

        const { rows, truncated } = await listBias(ctx, { criticality: 'HIGH' });

        expect(rows.map((r) => [r.id, r.recovery?.rank])).toStrictEqual([['b-high-a', 2], ['b-high-b', 3]]);
        expect(truncated).toBe(false);
    });

    it('counts the summary over the register, not the page', async () => {
        const recent = new Date(Date.now() - 86_400_000);
        registerDb([
            { id: 'b-1', criticality: 'CRITICAL', mtpdHours: 1, rtoHours: 1, reviewedAt: recent },
            { id: 'b-2', criticality: 'CRITICAL', mtpdHours: 2, rtoHours: 1, reviewedAt: null },
            { id: 'b-3', criticality: 'LOW', mtpdHours: 3, rtoHours: 1, reviewedAt: recent },
        ]);

        const { rows, summary } = await listBias(ctx, { take: 1 });

        expect(rows).toHaveLength(1);
        expect(summary).toStrictEqual({ total: 3, critical: 2, overdue: 1 });
        // The row's badge is decided here too, not by the browser's clock.
        expect(rows[0]).toMatchObject({ id: 'b-1', reviewOverdue: false });
    });

    it('reads the ranking population one past its cap, and says when the register is past it', async () => {
        const population = Array.from({ length: BIA_RANK_POPULATION_CAP + 1 }, (_, i) => ({
            id: `b-${String(i).padStart(5, '0')}`, criticality: 'LOW', mtpdHours: null, rtoHours: null,
        }));
        const db = registerDb(population);

        const register = await listBias(ctx);

        expect(db.businessImpactAnalysis.findMany.mock.calls[0][0]).toStrictEqual({
            where: { tenantId: 't-acme' },
            select: { id: true, criticality: true, mtpdHours: true, rtoHours: true, reviewedAt: true },
            orderBy: { id: 'asc' },
            take: BIA_RANK_POPULATION_CAP + 1,
        });
        expect(register.rankComplete).toBe(false);
        expect(register.truncated).toBe(true);
        expect(register.summary.total).toBe(BIA_RANK_POPULATION_CAP);
    });

    it('clamps take at 500 and reads no page when nothing matches', async () => {
        const db = registerDb([{ id: 'b-1', criticality: 'LOW', mtpdHours: 1, rtoHours: 1 }]);

        await listBias(ctx, { take: 5_000 });
        expect(db.businessImpactAnalysis.findMany.mock.calls[1][0]).toStrictEqual({
            where: { tenantId: 't-acme', id: { in: ['b-1'] } },
            include: {
                // No `processNode` include: a BIA names its node by natural
                // key now, which Prisma cannot join. attachProcessNodes()
                // fetches them in one OR-of-pairs query instead (#2971).
                ownerUser: { select: { id: true, name: true, email: true } },
                _count: { select: { dependencies: true } },
            },
            take: 1,
        });

        db.businessImpactAnalysis.findMany.mockClear();
        const none = await listBias(ctx, { criticality: 'HIGH' });
        expect(none.rows).toStrictEqual([]);
        // The population read only — no page read for an empty page.
        expect(db.businessImpactAnalysis.findMany).toHaveBeenCalledTimes(1);
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
            select: { processMapId: true, nodeKey: true, label: true },
            take: 400,
        });
        expect(db.businessImpactAnalysis.findMany).not.toHaveBeenCalled();
    });

    it('stops at none when the protected nodes carry no BIA, without ranking the tenant set', async () => {
        const db = surfaceDb({
            processEdge: { findMany: jest.fn().mockResolvedValue([{ processMapId: 'map-1', sourceKey: 'step-a', targetKey: 'step-b' }]) },
            processNode: { findMany: jest.fn().mockResolvedValue([{ processMapId: 'map-1', nodeKey: 'step-a', label: 'Payroll run' }]) },
        });

        await expect(getControlBiaSurface(ctx, 'c-1')).resolves.toStrictEqual({ kind: 'none' });

        expect(db.businessImpactAnalysis.findMany).toHaveBeenCalledTimes(1);
        expect(db.businessImpactAnalysis.findMany.mock.calls[0][0]).toStrictEqual({
            // An OR of PAIRS. `mapId in [...] AND nodeKey in [...]` would be a
            // cross-product matching nodes that do not exist (#2971).
            where: { tenantId: 't-acme', OR: [{ processMapId: 'map-1', processNodeKey: 'step-a' }] },
            select: {
                id: true, name: true, criticality: true, mtpdHours: true,
                rtoHours: true, processMapId: true, processNodeKey: true,
            },
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
            processNode: { findMany: jest.fn().mockResolvedValue([{ processMapId: 'map-1', nodeKey: 'step-a', label: 'Payroll run' }]) },
            businessImpactAnalysis: {
                findMany: jest
                    .fn()
                    .mockResolvedValueOnce([
                        { id: 'bia-ghost', name: 'Ghost BIA', criticality: 'CRITICAL', mtpdHours: 1, rtoHours: 1, processMapId: 'map-1', processNodeKey: 'step-a' },
                        { id: 'bia-top', name: 'Payroll BIA', criticality: 'HIGH', mtpdHours: 4, rtoHours: 2, processMapId: 'map-1', processNodeKey: 'step-unresolved' },
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
            select: { processMapId: true, nodeKey: true },
            take: 500,
        });
        expect(db.businessImpactAnalysis.findMany).not.toHaveBeenCalled();
    });

    it('asks the database for the tightest-MTPD BIAs of the protected nodes', async () => {
        const rows = [{ id: 'bia-1', name: 'Payroll', criticality: 'CRITICAL', mtpdHours: 2, rtoHours: 1 }];
        const db = incidentDb({
            processEdge: { findMany: jest.fn().mockResolvedValue([{ processMapId: 'map-1', sourceKey: 'step-a', targetKey: 'step-b' }]) },
            processNode: { findMany: jest.fn().mockResolvedValue([{ processMapId: 'map-1', nodeKey: 'step-a' }, { processMapId: 'map-1', nodeKey: 'step-b' }]) },
            businessImpactAnalysis: { findMany: jest.fn().mockResolvedValue(rows) },
        });

        await expect(getIncidentBiaContext(ctx, 'inc-1')).resolves.toStrictEqual(rows);

        expect(db.businessImpactAnalysis.findMany.mock.calls[0][0]).toStrictEqual({
            where: {
                tenantId: 't-acme',
                OR: [
                    { processMapId: 'map-1', processNodeKey: 'step-a' },
                    { processMapId: 'map-1', processNodeKey: 'step-b' },
                ],
            },
            select: { id: true, name: true, criticality: true, mtpdHours: true, rtoHours: true },
            orderBy: { mtpdHours: 'asc' },
            take: 20,
        });
    });
});
