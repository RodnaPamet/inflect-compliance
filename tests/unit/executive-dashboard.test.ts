/**
 * Executive Dashboard Aggregation Tests
 *
 * Verifies:
 * 1. Control coverage % is calculated correctly
 * 2. Risk severity bucketing is correct
 * 3. Evidence expiry logic handles edge cases
 * 4. Tenant scoping is preserved
 * 5. Empty datasets return sensible zeros
 * 6. No N+1 — each method uses groupBy/count (not findMany)
 * 7. Executive payload has correct shape
 */

// ─── Mock db-context ───
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTx: Record<string, any> = {};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => {
        return fn(mockTx);
    }),
}));

import {
    DashboardRepository,
    type ControlCoverage,
    type RiskBySeverity,
    type EvidenceExpiry,
} from '@/app-layer/repositories/DashboardRepository';
import { getExecutiveDashboard } from '@/app-layer/usecases/dashboard';
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
    Object.keys(mockTx).forEach(k => delete mockTx[k]);
});

// ─── Control Coverage ───

describe('Dashboard — Control Coverage', () => {
    function setupControlMock(groups: { status: string; _count: number }[], total: number) {
        mockTx.control = {
            groupBy: jest.fn(async () => groups),
            count: jest.fn(async () => total),
        };
    }

    it('calculates coverage % correctly', async () => {
        setupControlMock([
            { status: 'IMPLEMENTED', _count: 7 },
            { status: 'IN_PROGRESS', _count: 2 },
            { status: 'NOT_STARTED', _count: 1 },
        ], 12);

        const result: ControlCoverage = await DashboardRepository.getControlCoverage(mockTx as never, makeCtx());

        // 7 implemented out of 10 applicable = 70%
        expect(result.implemented).toBe(7);
        expect(result.applicable).toBe(10);
        expect(result.coveragePercent).toBe(70);
        expect(result.inProgress).toBe(2);
        expect(result.notStarted).toBe(1);
        expect(result.total).toBe(12);
    });

    it('returns 0% for empty control set', async () => {
        setupControlMock([], 0);

        const result = await DashboardRepository.getControlCoverage(mockTx as never, makeCtx());

        expect(result.coveragePercent).toBe(0);
        expect(result.applicable).toBe(0);
        expect(result.total).toBe(0);
    });

    it('handles all IMPLEMENTED (100%)', async () => {
        setupControlMock([
            { status: 'IMPLEMENTED', _count: 20 },
        ], 22);

        const result = await DashboardRepository.getControlCoverage(mockTx as never, makeCtx());

        expect(result.coveragePercent).toBe(100);
        expect(result.implemented).toBe(20);
        expect(result.applicable).toBe(20);
    });

    it('handles rounding to 1 decimal', async () => {
        setupControlMock([
            { status: 'IMPLEMENTED', _count: 1 },
            { status: 'NOT_STARTED', _count: 2 },
        ], 3);

        const result = await DashboardRepository.getControlCoverage(mockTx as never, makeCtx());

        // 1/3 = 33.3333... → rounds to 33.3
        expect(result.coveragePercent).toBe(33.3);
    });

    it('combines IN_PROGRESS and IMPLEMENTING statuses', async () => {
        setupControlMock([
            { status: 'IN_PROGRESS', _count: 3 },
            { status: 'IMPLEMENTING', _count: 2 },
        ], 5);

        const result = await DashboardRepository.getControlCoverage(mockTx as never, makeCtx());

        expect(result.inProgress).toBe(5); // 3 + 2
    });
});

// ─── Risk by Severity ───

describe('Dashboard — Risk by Severity', () => {
    it('buckets correctly by inherentScore tiers', async () => {
        mockTx.risk = {
            count: jest.fn()
                .mockResolvedValueOnce(2)   // low (1–4)
                .mockResolvedValueOnce(5)   // medium (5–9)
                .mockResolvedValueOnce(3)   // high (10–14)
                .mockResolvedValueOnce(1),  // critical (15–25)
        };

        const result: RiskBySeverity = await DashboardRepository.getRiskBySeverity(mockTx as never, makeCtx());

        expect(result.low).toBe(2);
        expect(result.medium).toBe(5);
        expect(result.high).toBe(3);
        expect(result.critical).toBe(1);
    });

    it('returns all zeros for empty risk set', async () => {
        mockTx.risk = {
            count: jest.fn().mockResolvedValue(0),
        };

        const result = await DashboardRepository.getRiskBySeverity(mockTx as never, makeCtx());

        expect(result.low).toBe(0);
        expect(result.medium).toBe(0);
        expect(result.high).toBe(0);
        expect(result.critical).toBe(0);
    });
});

// ─── Risk by Status ───

describe('Dashboard — Risk by Status', () => {
    it('maps status groups correctly', async () => {
        mockTx.risk = {
            groupBy: jest.fn(async () => [
                { status: 'OPEN', _count: 10 },
                { status: 'MITIGATING', _count: 3 },
                { status: 'ACCEPTED', _count: 2 },
                { status: 'CLOSED', _count: 5 },
            ]),
        };

        const result = await DashboardRepository.getRiskByStatus(mockTx as never, makeCtx());

        expect(result.open).toBe(10);
        expect(result.mitigating).toBe(3);
        expect(result.accepted).toBe(2);
        expect(result.closed).toBe(5);
    });

    it('returns zeros for missing statuses', async () => {
        mockTx.risk = {
            groupBy: jest.fn(async () => []),
        };

        const result = await DashboardRepository.getRiskByStatus(mockTx as never, makeCtx());

        expect(result.open).toBe(0);
        expect(result.mitigating).toBe(0);
        expect(result.accepted).toBe(0);
        expect(result.closed).toBe(0);
    });
});

// ─── Evidence Expiry ───

describe('Dashboard — Evidence Expiry', () => {
    it('classifies evidence into expiry buckets', async () => {
        mockTx.evidence = {
            count: jest.fn()
                .mockResolvedValueOnce(3)   // overdue
                .mockResolvedValueOnce(2)   // dueSoon7d
                .mockResolvedValueOnce(5)   // dueSoon30d
                .mockResolvedValueOnce(10)  // noReviewDate
                .mockResolvedValueOnce(15), // current
        };

        const result: EvidenceExpiry = await DashboardRepository.getEvidenceExpiry(mockTx as never, makeCtx());

        expect(result.overdue).toBe(3);
        expect(result.dueSoon7d).toBe(2);
        expect(result.dueSoon30d).toBe(5);
        expect(result.noReviewDate).toBe(10);
        expect(result.current).toBe(15);
    });

    it('returns zeros for empty evidence set', async () => {
        mockTx.evidence = {
            count: jest.fn().mockResolvedValue(0),
        };

        const result = await DashboardRepository.getEvidenceExpiry(mockTx as never, makeCtx());

        expect(result.overdue).toBe(0);
        expect(result.dueSoon7d).toBe(0);
        expect(result.dueSoon30d).toBe(0);
        expect(result.noReviewDate).toBe(0);
        expect(result.current).toBe(0);
    });
});

// ─── Policy Summary ───

describe('Dashboard — Policy Summary', () => {
    it('aggregates policy statuses correctly', async () => {
        mockTx.policy = {
            groupBy: jest.fn(async () => [
                { status: 'DRAFT', _count: 3 },
                { status: 'PUBLISHED', _count: 5 },
                { status: 'APPROVED', _count: 2 },
            ]),
            count: jest.fn(async () => 1), // overdueReview
        };

        const result = await DashboardRepository.getPolicySummary(mockTx as never, makeCtx());

        expect(result.total).toBe(10);
        expect(result.draft).toBe(3);
        expect(result.published).toBe(5);
        expect(result.approved).toBe(2);
        expect(result.inReview).toBe(0);
        expect(result.archived).toBe(0);
        expect(result.overdueReview).toBe(1);
    });
});

// ─── Task Summary ───

describe('Dashboard — Task Summary', () => {
    it('aggregates task statuses and overdue count', async () => {
        mockTx.task = {
            groupBy: jest.fn(async () => [
                { status: 'OPEN', _count: 5 },
                { status: 'TRIAGED', _count: 2 },
                { status: 'IN_PROGRESS', _count: 3 },
                { status: 'BLOCKED', _count: 1 },
                { status: 'RESOLVED', _count: 4 },
            ]),
            count: jest.fn(async () => 2), // overdue
        };

        const result = await DashboardRepository.getTaskSummary(mockTx as never, makeCtx());

        expect(result.total).toBe(15);
        expect(result.open).toBe(7); // OPEN (5) + TRIAGED (2)
        expect(result.inProgress).toBe(3);
        expect(result.blocked).toBe(1);
        expect(result.resolved).toBe(4); // RESOLVED
        expect(result.overdue).toBe(2);
    });
});

// ─── Vendor Summary ───

describe('Dashboard — Vendor Summary', () => {
    it('returns total and overdue review count', async () => {
        mockTx.vendor = {
            count: jest.fn()
                .mockResolvedValueOnce(12) // total
                .mockResolvedValueOnce(3), // overdueReview
        };

        const result = await DashboardRepository.getVendorSummary(mockTx as never, makeCtx());

        expect(result.total).toBe(12);
        expect(result.overdueReview).toBe(3);
    });
});

// ─── Executive Dashboard Usecase ───

describe('Dashboard — Executive Payload', () => {
    function setupAllMocks() {
        // Stats
        mockTx.asset = { count: jest.fn(async () => 10) };
        mockTx.risk = {
            count: jest.fn(async () => 5),
            groupBy: jest.fn(async (args: { by: string[] }) => {
                // Handle both status groupBy and likelihood/impact groupBy
                if (args.by.includes('likelihood')) {
                    return [
                        { likelihood: 3, impact: 4, _count: 2 },
                    ];
                }
                return [
                    { status: 'OPEN', _count: 3 },
                    { status: 'CLOSED', _count: 2 },
                ];
            }),
        };
        mockTx.control = {
            count: jest.fn(async () => 20),
            groupBy: jest.fn(async () => [
                { status: 'IMPLEMENTED', _count: 15 },
                { status: 'NOT_STARTED', _count: 5 },
            ]),
        };
        mockTx.evidence = {
            count: jest.fn(async () => 30),
            findMany: jest.fn(async () => []),
        };
        mockTx.task = {
            count: jest.fn(async () => 8),
            groupBy: jest.fn(async () => [
                { status: 'OPEN', _count: 5 },
                { status: 'IN_PROGRESS', _count: 3 },
            ]),
        };
        mockTx.finding = { count: jest.fn(async () => 4) };
        mockTx.clauseProgress = { findMany: jest.fn(async () => []) };
        mockTx.notification = { count: jest.fn(async () => 2) };
        mockTx.policy = {
            groupBy: jest.fn(async () => [
                { status: 'PUBLISHED', _count: 5 },
            ]),
            count: jest.fn(async () => 0),
        };
        mockTx.vendor = {
            count: jest.fn(async () => 4),
        };
        // Epic G-5 — five COUNTs against ControlException for the
        // exception-summary card.
        mockTx.controlException = {
            count: jest.fn(async () => 0),
        };
        // Epic G-7 — five COUNTs against RiskTreatmentPlan for the
        // treatment-plan-summary card.
        mockTx.riskTreatmentPlan = {
            count: jest.fn(async () => 0),
        };
    }

    it('returns complete payload with all sections', async () => {
        setupAllMocks();

        const result = await getExecutiveDashboard(makeCtx());

        // Verify all sections exist
        expect(result.stats).toBeDefined();
        expect(result.controlCoverage).toBeDefined();
        expect(result.riskBySeverity).toBeDefined();
        expect(result.riskByStatus).toBeDefined();
        expect(result.evidenceExpiry).toBeDefined();
        expect(result.policySummary).toBeDefined();
        expect(result.taskSummary).toBeDefined();
        expect(result.vendorSummary).toBeDefined();
        expect(result.computedAt).toBeDefined();
        // The risk-heatmap, expiry-list, exception, and treatment-plan
        // aggregates were removed from the executive payload (the exception
        // + treatment KPIs moved to the on-demand swappable-KPI slot).

        // computedAt is a valid ISO string
        expect(new Date(result.computedAt).toISOString()).toBe(result.computedAt);
    });

    it('rejects non-reader users', async () => {
        setupAllMocks();

        const ctx = makeCtx({
            permissions: { canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        });

        await expect(getExecutiveDashboard(ctx)).rejects.toThrow(/permission/i);
    });
});

// ─── Tenant Scoping ───

describe('Dashboard — Tenant Scoping', () => {
    it('control coverage passes tenantId to groupBy filter', async () => {
        mockTx.control = {
            groupBy: jest.fn(async () => []),
            count: jest.fn(async () => 0),
        };

        await DashboardRepository.getControlCoverage(mockTx as never, makeCtx({ tenantId: 'tenant-xyz' }));

        const groupByCall = mockTx.control.groupBy.mock.calls[0][0];
        expect(JSON.stringify(groupByCall.where)).toContain('tenant-xyz');
    });

    it('risk queries use tenantId from context', async () => {
        mockTx.risk = {
            count: jest.fn(async () => 0),
        };

        await DashboardRepository.getRiskBySeverity(mockTx as never, makeCtx({ tenantId: 'tenant-abc' }));

        const firstCall = mockTx.risk.count.mock.calls[0][0];
        expect(firstCall.where.tenantId).toBe('tenant-abc');
    });

    it('evidence queries use tenantId from context', async () => {
        mockTx.evidence = {
            count: jest.fn(async () => 0),
        };

        await DashboardRepository.getEvidenceExpiry(mockTx as never, makeCtx({ tenantId: 'tenant-def' }));

        const firstCall = mockTx.evidence.count.mock.calls[0][0];
        expect(firstCall.where.tenantId).toBe('tenant-def');
    });
});

// ─── Query Efficiency ───

describe('Dashboard — Query Efficiency (no N+1)', () => {
    it('controlCoverage uses groupBy not findMany', async () => {
        mockTx.control = {
            groupBy: jest.fn(async () => [{ status: 'IMPLEMENTED', _count: 5 }]),
            count: jest.fn(async () => 5),
            findMany: jest.fn(async () => { throw new Error('findMany called — N+1 detected!'); }),
        };

        const result = await DashboardRepository.getControlCoverage(mockTx as never, makeCtx());

        expect(result.implemented).toBe(5);
        expect(mockTx.control.groupBy).toHaveBeenCalledTimes(1);
        expect(mockTx.control.findMany).not.toHaveBeenCalled();
    });

    it('riskByStatus uses groupBy not findMany', async () => {
        mockTx.risk = {
            groupBy: jest.fn(async () => []),
            findMany: jest.fn(async () => { throw new Error('findMany called — N+1 detected!'); }),
        };

        await DashboardRepository.getRiskByStatus(mockTx as never, makeCtx());

        expect(mockTx.risk.groupBy).toHaveBeenCalledTimes(1);
        expect(mockTx.risk.findMany).not.toHaveBeenCalled();
    });

    it('evidenceExpiry uses count not findMany', async () => {
        mockTx.evidence = {
            count: jest.fn(async () => 0),
            findMany: jest.fn(async () => { throw new Error('findMany called — N+1 detected!'); }),
        };

        await DashboardRepository.getEvidenceExpiry(mockTx as never, makeCtx());

        expect(mockTx.evidence.count).toHaveBeenCalled();
        expect(mockTx.evidence.findMany).not.toHaveBeenCalled();
    });
});
