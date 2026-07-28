/**
 * Swappable custom-KPI usecase (`getDashboardKpi`).
 *
 * Verifies the on-demand shaping of the assets / audits / tests +
 * folded evidence / exceptions / treatmentPlans KPI cards + their pie
 * segments, and that an unknown key is rejected. The repository queries
 * are mocked (no DB) — this locks the DTO contract the dashboard's
 * <CustomKpiPanel> consumes.
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

describe('getDashboardKpi — evidence (folded from the Evidence Status card)', () => {
    it('carves a disjoint 8–30d slice so the pie never double-counts urgent rows', async () => {
        // getEvidenceExpiry issues 5 counts in order:
        // overdue, dueSoon7d, dueSoon30d, noReviewDate, current.
        mockTx.evidence = {
            count: jest
                .fn()
                .mockResolvedValueOnce(2) // overdue
                .mockResolvedValueOnce(3) // dueSoon7d
                .mockResolvedValueOnce(5) // dueSoon30d (INCLUDES the 3 due≤7d)
                .mockResolvedValueOnce(1) // noReviewDate
                .mockResolvedValueOnce(10), // current
        };

        const dto = await getDashboardKpi(makeCtx(), 'evidence');

        expect(dto.key).toBe('evidence');
        // 2 overdue + 3 due≤7d + (5-3) due8–30d + 10 current = 17.
        expect(dto.headline).toBe(17);
        expect(dto.subtitle).toBe('59% current'); // round(10/17*100)
        expect(dto.segments).toEqual([
            { label: 'Overdue', value: 2, color: '#dc2626' },
            { label: 'Due ≤7d', value: 3, color: '#f97316' },
            { label: 'Due 8–30d', value: 2, color: '#f59e0b' },
            { label: 'Current', value: 10, color: '#22c55e' },
        ]);
    });
});

describe('getDashboardKpi — exceptions (folded from the Exception Inventory card)', () => {
    it('splits Active into the healthy remainder + two disjoint expiring slices', async () => {
        // getExceptionSummary issues 5 counts in order: activeApproved,
        // pendingRequest, expiringWithin30, expiringWithin7, expired.
        mockTx.controlException = {
            count: jest
                .fn()
                .mockResolvedValueOnce(10) // activeApproved
                .mockResolvedValueOnce(2) // pendingRequest
                .mockResolvedValueOnce(4) // expiringWithin30 (INCLUDES the 1 within7)
                .mockResolvedValueOnce(1) // expiringWithin7
                .mockResolvedValueOnce(3), // expired
        };

        const dto = await getDashboardKpi(makeCtx(), 'exceptions');

        expect(dto.key).toBe('exceptions');
        // activeApproved 10 + pending 2 + expired 3 = 15.
        expect(dto.headline).toBe(15);
        expect(dto.subtitle).toBe('10 active');
        expect(dto.segments).toEqual([
            { label: 'Active', value: 6, color: '#22c55e' }, // 10 - 4 expiring
            { label: 'Expiring ≤7d', value: 1, color: '#f97316' },
            { label: 'Expiring 8–30d', value: 3, color: '#f59e0b' }, // 4 - 1
            { label: 'Pending', value: 2, color: '#3b82f6' },
            { label: 'Expired', value: 3, color: '#dc2626' },
        ]);
        // The segments partition the headline exactly.
        expect(dto.segments.reduce((n, s) => n + s.value, 0)).toBe(dto.headline);
    });
});

describe('getDashboardKpi — treatmentPlans (folded from the Treatment-Plan card)', () => {
    it('shapes the three disjoint lifecycle buckets with due≤7d in the subtitle', async () => {
        // getTreatmentPlanSummary issues 5 counts in order: activeOnTrack,
        // overdue, dueWithin30, dueWithin7, completed.
        mockTx.riskTreatmentPlan = {
            count: jest
                .fn()
                .mockResolvedValueOnce(8) // activeOnTrack
                .mockResolvedValueOnce(2) // overdue
                .mockResolvedValueOnce(4) // dueWithin30
                .mockResolvedValueOnce(1) // dueWithin7
                .mockResolvedValueOnce(5), // completed
        };

        const dto = await getDashboardKpi(makeCtx(), 'treatmentPlans');

        expect(dto.key).toBe('treatmentPlans');
        expect(dto.headline).toBe(15); // 8 on-track + 2 overdue + 5 completed
        expect(dto.subtitle).toBe('1 due ≤7d');
        expect(dto.segments).toEqual([
            { label: 'On track', value: 8, color: '#22c55e' },
            { label: 'Overdue', value: 2, color: '#dc2626' },
            { label: 'Completed', value: 5, color: '#3b82f6' },
        ]);
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
