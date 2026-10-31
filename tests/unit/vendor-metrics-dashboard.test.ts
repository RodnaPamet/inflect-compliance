/**
 * #4799 — the vendor dashboard's counts: an offboarded vendor has no review,
 * renewal or assessment due, and "Assessment risk" reads each vendor's
 * latest COMPLETED assessment.
 */
const vendorFindMany = jest.fn();
const mockDb = {
    vendor: { findMany: vendorFindMany },
    vendorDocument: { count: jest.fn().mockResolvedValue(0) },
    vendorDocExtraction: { findMany: jest.fn().mockResolvedValue([]) },
    vendorPostureEvent: { findMany: jest.fn().mockResolvedValue([]) },
};

jest.mock('@/lib/db-context', () => ({
    ...jest.requireActual('@/lib/db-context'),
    runInTenantReadContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

import { getVendorMetrics } from '@/app-layer/usecases/vendor';
import { makeRequestContext } from '../helpers/make-context';

const DAY = 86_400_000;
function vendor(overrides: Record<string, unknown>) {
    return {
        id: 'v', status: 'ACTIVE', criticality: 'LOW', nextReviewAt: null, contractRenewalAt: null,
        lastAssessmentReviewedAt: new Date(), assessments: [], ...overrides,
    };
}

beforeEach(() => {
    vendorFindMany.mockReset();
});

describe('getVendorMetrics (#4799)', () => {
    it('reads only completed assessments for each vendor', async () => {
        vendorFindMany.mockResolvedValue([]);
        await getVendorMetrics(makeRequestContext('ADMIN'));
        const args = vendorFindMany.mock.calls[0][0];
        expect([...args.include.assessments.where.status.in].sort()).toEqual(['APPROVED', 'CLOSED', 'REVIEWED']);
        expect(args.include.assessments.take).toBe(1);
    });

    it('an offboarded vendor counts in the totals, not as overdue', async () => {
        const past = new Date(Date.now() - DAY);
        vendorFindMany.mockResolvedValue([
            vendor({ id: 'gone', status: 'OFFBOARDED', criticality: 'CRITICAL', nextReviewAt: past, contractRenewalAt: past }),
            vendor({ id: 'live', status: 'ACTIVE', criticality: 'HIGH', nextReviewAt: past, contractRenewalAt: past }),
        ]);
        const m = await getVendorMetrics(makeRequestContext('ADMIN'));
        expect(m.totalVendors).toBe(2);
        expect(m.byStatus).toEqual({ OFFBOARDED: 1, ACTIVE: 1 });
        expect(m.overdueReview).toBe(1);
        expect(m.overdueRenewal).toBe(1);
        expect(m.highRiskNoAssessment).toBe(1);
    });

    it('a high vendor with a completed assessment is not "no assessment"', async () => {
        vendorFindMany.mockResolvedValue([
            vendor({ id: 'assessed', criticality: 'HIGH', assessments: [{ status: 'REVIEWED', riskRating: 'MEDIUM' }] }),
            vendor({ id: 'never', criticality: 'CRITICAL', assessments: [] }),
        ]);
        const m = await getVendorMetrics(makeRequestContext('ADMIN'));
        expect(m.highRiskNoAssessment).toBe(1);
        expect(m.byRiskRating).toEqual({ MEDIUM: 1 });
    });
});
