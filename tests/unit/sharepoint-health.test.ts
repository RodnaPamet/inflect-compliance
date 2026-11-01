/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/** SP-5 — sync-health aggregation. */
const mockDb = {
    integrationConnection: { findMany: jest.fn() },
    integrationExecution: { findMany: jest.fn() },
    integrationSyncMapping: { findMany: jest.fn(), groupBy: jest.fn() },
    evidence: { findMany: jest.fn() },
    policy: { count: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: any, fn: (db: any) => any) => fn(mockDb),
}));

import { getSharePointHealth, PROBLEM_SAMPLE } from '@/app-layer/integrations/providers/sharepoint/health';

const admin = { tenantId: 't1', userId: 'u1', permissions: { canAdmin: true } } as any;
const reader = { tenantId: 't1', userId: 'u2', permissions: { canAdmin: false } } as any;

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.integrationConnection.findMany.mockResolvedValue([]);
    mockDb.integrationExecution.findMany.mockResolvedValue([]);
    mockDb.integrationSyncMapping.groupBy.mockResolvedValue([]);
    mockDb.integrationSyncMapping.findMany.mockResolvedValue([]);
    mockDb.evidence.findMany.mockResolvedValue([]);
    mockDb.policy.count.mockResolvedValue(0);
});

it('rejects a non-admin', async () => {
    await expect(getSharePointHealth(reader)).rejects.toBeDefined();
});

it('aggregates connections, executions, coverage + policy links', async () => {
    mockDb.integrationConnection.findMany.mockResolvedValue([
        { id: 'c1', name: 'SP', isEnabled: false, lastTestedAt: new Date('2026-01-01'), lastTestStatus: 'ok' },
    ]);
    mockDb.integrationExecution.findMany.mockResolvedValue([
        { id: 'e1', automationKey: 'sharepoint.audit_pack_export', status: 'PASSED', triggeredBy: 'manual', executedAt: new Date('2026-02-01'), durationMs: 120 },
    ]);
    mockDb.integrationSyncMapping.groupBy.mockResolvedValue([
        { syncStatus: 'SYNCED', _count: { _all: 2 } },
        { syncStatus: 'STALE', _count: { _all: 1 } },
        { syncStatus: 'FAILED', _count: { _all: 1 } },
    ]);
    mockDb.policy.count.mockResolvedValue(3);

    const h = await getSharePointHealth(admin);
    expect(h.connections).toHaveLength(1);
    expect(h.connections[0].lastTestedAt).toBe('2026-01-01T00:00:00.000Z');
    // #4873 — a disabled connection says so; it is not a green OK.
    expect(h.connections[0].isEnabled).toBe(false);
    expect(h.executions[0].automationKey).toBe('sharepoint.audit_pack_export');
    expect(h.evidenceCoverage).toEqual({ synced: 2, stale: 1, failed: 1, total: 4 });
    expect(h.problemsTotal).toBe(2);
    expect(h.policyLinks).toBe(3);
});

it('counts coverage in the database, past any page size (#4873)', async () => {
    mockDb.integrationSyncMapping.groupBy.mockResolvedValue([
        { syncStatus: 'SYNCED', _count: { _all: 4800 } },
        { syncStatus: 'PENDING', _count: { _all: 7 } },
    ]);

    const h = await getSharePointHealth(admin);
    // It used to tally the first 2,000 rows, so 4,800 synced read as 2,000.
    expect(h.evidenceCoverage).toEqual({ synced: 4800, stale: 0, failed: 0, total: 4807 });
    expect(mockDb.integrationSyncMapping.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ by: ['syncStatus'], where: { tenantId: 't1', provider: 'sharepoint' } }),
    );
});

it('lists the documents behind Stale and Failed, named by their evidence', async () => {
    mockDb.integrationSyncMapping.groupBy.mockResolvedValue([
        { syncStatus: 'FAILED', _count: { _all: 1 } },
        { syncStatus: 'STALE', _count: { _all: 40 } },
    ]);
    mockDb.integrationSyncMapping.findMany.mockResolvedValue([
        { id: 'm1', syncStatus: 'FAILED', localEntityType: 'Evidence', localEntityId: 'ev1', errorMessage: 'Access denied', lastSyncedAt: new Date('2026-10-30') },
        { id: 'm2', syncStatus: 'STALE', localEntityType: 'Evidence', localEntityId: 'ev-gone', errorMessage: null, lastSyncedAt: null },
    ]);
    mockDb.evidence.findMany.mockResolvedValue([{ id: 'ev1', title: 'Access policy.pdf' }]);

    const h = await getSharePointHealth(admin);
    expect(h.problemsTotal).toBe(41);
    expect(h.problems).toEqual([
        { mappingId: 'm1', status: 'FAILED', evidenceId: 'ev1', evidenceTitle: 'Access policy.pdf', errorMessage: 'Access denied', lastSyncedAt: '2026-10-30T00:00:00.000Z' },
        // An evidence row that no longer exists is not linked.
        { mappingId: 'm2', status: 'STALE', evidenceId: null, evidenceTitle: null, errorMessage: null, lastSyncedAt: null },
    ]);
    expect(mockDb.integrationSyncMapping.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: PROBLEM_SAMPLE }),
    );
});
