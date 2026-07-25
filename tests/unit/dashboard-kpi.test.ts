/**
 * Swappable custom-KPI usecase (`getDashboardKpi`).
 *
 * Verifies the on-demand shaping of the assets / audits / tests KPI
 * cards + their pie segments, and that an unknown key is rejected.
 * The repository queries are mocked (no DB) — this locks the DTO
 * contract the dashboard's <CustomKpiPanel> consumes.
 */

// ─── Mock db-context so runInTenantContext calls straight through ───
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTx: Record<string, any> = {};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn(mockTx),
    ),
}));

import { getDashboardKpi } from '@/app-layer/usecases/dashboard';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
    return {
        requestId: 'req-test',
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockTx).forEach((k) => delete mockTx[k]);
});

describe('getDashboardKpi — assets', () => {
    it('shapes the asset summary into a headline + status pie', async () => {
        // getAssetSummary issues 4 counts in order: total, active, highCrit, retired.
        mockTx.asset = {
            count: jest
                .fn()
                .mockResolvedValueOnce(10) // total
                .mockResolvedValueOnce(6) // active
                .mockResolvedValueOnce(3) // highCriticality
                .mockResolvedValueOnce(4), // retired
        };

        const dto = await getDashboardKpi(makeCtx(), 'assets');

        expect(dto.key).toBe('assets');
        expect(dto.headline).toBe(10);
        expect(dto.subtitle).toBe('3 high/critical');
        // total - active - retired = 0 → no "Other" slice.
        expect(dto.segments).toEqual([
            { label: 'Active', value: 6, color: '#22c55e' },
            { label: 'Retired', value: 4, color: '#94a3b8' },
        ]);
    });

    it('adds an "Other" slice when active + retired < total', async () => {
        mockTx.asset = {
            count: jest
                .fn()
                .mockResolvedValueOnce(10)
                .mockResolvedValueOnce(5)
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(2),
        };

        const dto = await getDashboardKpi(makeCtx(), 'assets');
        expect(dto.segments.map((s) => s.label)).toEqual(['Active', 'Retired', 'Other']);
        expect(dto.segments.find((s) => s.label === 'Other')?.value).toBe(3);
    });
});

describe('getDashboardKpi — audits', () => {
    it('groups audit cycles by status', async () => {
        mockTx.auditCycle = {
            groupBy: jest.fn(async () => [
                { status: 'PLANNING', _count: { _all: 2 } },
                { status: 'IN_PROGRESS', _count: { _all: 1 } },
                { status: 'COMPLETE', _count: { _all: 4 } },
            ]),
        };

        const dto = await getDashboardKpi(makeCtx(), 'audits');
        expect(dto.headline).toBe(7); // 2 + 1 + 0 (ready) + 4
        expect(dto.subtitle).toBe('4 complete');
        expect(dto.segments).toEqual([
            { label: 'Planning', value: 2, color: '#94a3b8' },
            { label: 'In Progress', value: 1, color: '#f59e0b' },
            { label: 'Ready', value: 0, color: '#3b82f6' },
            { label: 'Complete', value: 4, color: '#22c55e' },
        ]);
    });
});

describe('getDashboardKpi — tests', () => {
    it('groups test runs by result, folding null into pending', async () => {
        mockTx.controlTestRun = {
            groupBy: jest.fn(async () => [
                { result: 'PASS', _count: { _all: 5 } },
                { result: 'FAIL', _count: { _all: 1 } },
                { result: null, _count: { _all: 3 } },
            ]),
        };

        const dto = await getDashboardKpi(makeCtx(), 'tests');
        expect(dto.headline).toBe(9); // 5 + 1 + 0 + 3
        expect(dto.subtitle).toBe('5 passed');
        expect(dto.segments.find((s) => s.label === 'Pending')?.value).toBe(3);
        expect(dto.segments.find((s) => s.label === 'Inconclusive')?.value).toBe(0);
    });
});

describe('getDashboardKpi — guards', () => {
    it('rejects an unknown KPI key', async () => {
        await expect(
            getDashboardKpi(makeCtx(), 'bogus' as never),
        ).rejects.toThrow(/Unknown KPI key/);
    });

    it('denies a caller without read permission', async () => {
        const ctx = makeCtx({
            role: 'READER',
            permissions: { canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        });
        await expect(getDashboardKpi(ctx, 'assets')).rejects.toBeTruthy();
    });
});
