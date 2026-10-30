/**
 * Swappable custom-KPI usecase (`getDashboardKpi`).
 *
 * Verifies the on-demand shaping of the assets / audits / tests +
 * folded evidence / exceptions / treatmentPlans KPI cards + their pie
 * segments, and that an unknown key is rejected. The repository queries
 * are mocked (no DB) — this locks the DTO contract the dashboard's
 * <CustomKpiPanel> consumes.
 *
 * The DTO carries CODES, not English: each segment a `key` the client renders
 * as `dashboard.customKpi.segments.<key>`, the subtitle a `{ key, count }` it
 * renders as `dashboard.customKpi.subtitles.<key>`. The last block checks
 * every code the usecase can return has a message in both locales.
 */

// ─── Mock db-context so runInTenantContext calls straight through ───
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTx: Record<string, any> = {};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn(mockTx),
    ),
}));

import * as fs from 'fs';
import * as path from 'path';

import {
    DASHBOARD_KPI_SEGMENT_KEYS,
    DASHBOARD_KPI_SUBTITLE_KEYS,
    getDashboardKpi,
} from '@/app-layer/usecases/dashboard';
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
        expect(dto.subtitle).toEqual({ key: 'highCritical', count: 3 });
        // total - active - retired = 0 → no "Other" slice.
        expect(dto.segments).toEqual([
            { key: 'active', value: 6, color: '#22c55e' },
            { key: 'retired', value: 4, color: '#94a3b8' },
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
        expect(dto.segments.map((s) => s.key)).toEqual(['active', 'retired', 'other']);
        expect(dto.segments.find((s) => s.key === 'other')?.value).toBe(3);
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
        expect(dto.subtitle).toEqual({ key: 'complete', count: 4 });
        expect(dto.segments).toEqual([
            { key: 'planning', value: 2, color: '#94a3b8' },
            { key: 'inProgress', value: 1, color: '#f59e0b' },
            { key: 'ready', value: 0, color: '#3b82f6' },
            { key: 'complete', value: 4, color: '#22c55e' },
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
        expect(dto.subtitle).toEqual({ key: 'passed', count: 5 });
        expect(dto.segments.find((s) => s.key === 'pending')?.value).toBe(3);
        expect(dto.segments.find((s) => s.key === 'inconclusive')?.value).toBe(0);
    });
});

describe('getDashboardKpi — evidence (folded from the Evidence Status card)', () => {
    it('sums the four DISJOINT review buckets', async () => {
        // getEvidenceReviewBreakdown issues 4 counts in order:
        // overdue, dueWithin7d, due8to30d, current. They are disjoint by
        // construction — the real-DB proof of that is
        // tests/integration/dashboard-board-figures.test.ts.
        mockTx.evidence = {
            count: jest
                .fn()
                .mockResolvedValueOnce(2) // overdue
                .mockResolvedValueOnce(3) // due within 7d
                .mockResolvedValueOnce(2) // due in 8–30d
                .mockResolvedValueOnce(10), // current (approved, not due within 30d)
        };

        const dto = await getDashboardKpi(makeCtx(), 'evidence');

        expect(dto.key).toBe('evidence');
        // 2 + 3 + 2 + 10 = 17.
        expect(dto.headline).toBe(17);
        expect(dto.subtitle).toEqual({ key: 'currentPercent', count: 59 }); // round(10/17*100)
        expect(dto.segments).toEqual([
            { key: 'overdue', value: 2, color: '#dc2626' },
            { key: 'dueWithin7d', value: 3, color: '#f97316' },
            { key: 'due8to30d', value: 2, color: '#f59e0b' },
            { key: 'current', value: 10, color: '#22c55e' },
        ]);
        // The headline is the pie's total — nothing counted twice.
        expect(dto.segments.reduce((n, s) => n + s.value, 0)).toBe(dto.headline);
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
        expect(dto.subtitle).toEqual({ key: 'active', count: 10 });
        expect(dto.segments).toEqual([
            { key: 'active', value: 6, color: '#22c55e' }, // 10 - 4 expiring
            { key: 'expiringWithin7d', value: 1, color: '#f97316' },
            { key: 'expiring8to30d', value: 3, color: '#f59e0b' }, // 4 - 1
            { key: 'pending', value: 2, color: '#3b82f6' },
            { key: 'expired', value: 3, color: '#dc2626' },
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
        expect(dto.subtitle).toEqual({ key: 'dueWithin7d', count: 1 });
        expect(dto.segments).toEqual([
            { key: 'onTrack', value: 8, color: '#22c55e' },
            { key: 'overdue', value: 2, color: '#dc2626' },
            { key: 'completed', value: 5, color: '#3b82f6' },
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

describe('getDashboardKpi — every code it returns has a message', () => {
    // The client renders `t(`customKpi.segments.${key}`)`, a template-literal
    // lookup the static i18n-keys guard cannot resolve, so the catalogue is
    // checked against the usecase's own code lists here.
    const ROOT = path.resolve(__dirname, '../..');
    const locales = ['en', 'bg'].map((loc) => ({
        loc,
        customKpi: JSON.parse(
            fs.readFileSync(path.join(ROOT, `messages/${loc}.json`), 'utf8'),
        ).dashboard.customKpi as {
            segments: Record<string, string>;
            subtitles: Record<string, string>;
        },
    }));

    it.each(locales)('$loc carries a label for every segment and subtitle code', ({ customKpi }) => {
        for (const key of DASHBOARD_KPI_SEGMENT_KEYS) {
            expect(typeof customKpi.segments[key]).toBe('string');
        }
        for (const key of DASHBOARD_KPI_SUBTITLE_KEYS) {
            expect(customKpi.subtitles[key]).toContain('{count}');
        }
    });
});
