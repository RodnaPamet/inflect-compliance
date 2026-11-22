/**
 * Unit tests for `changeTenantPlan` — the net-new plan-change boundary
 * that emits the business.plan.upgraded / .downgraded KPIs.
 *
 * Verifies upgrade/downgrade direction (by plan rank), the unchanged
 * no-op, the missing-account = FREE baseline, the SELFHOSTED guard, and
 * that the directional metric fires only for a genuine change.
 */
import { makeRequestContext } from '../helpers/make-context';

const mockFindUnique = jest.fn();
const mockUpsert = jest.fn();
jest.mock('@/lib/db/rls-middleware', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ billingAccount: { findUnique: mockFindUnique, upsert: mockUpsert } }),
    ),
}));

const mockLogEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }));

const mockGetBillingMode = jest.fn();
jest.mock('@/lib/billing/entitlements', () => ({
    getBillingMode: () => mockGetBillingMode(),
}));

const mockUpgraded = jest.fn();
const mockDowngraded = jest.fn();
jest.mock('@/lib/observability/business-metrics', () => ({
    recordPlanUpgraded: (a: unknown) => mockUpgraded(a),
    recordPlanDowngraded: (a: unknown) => mockDowngraded(a),
}));

// Run the usecase span wrapper inline (noop tracer).
jest.mock('@/lib/observability', () => ({
    traceUsecase: (_n: string, _c: unknown, fn: () => unknown) => fn(),
}));

import { changeTenantPlan } from '@/app-layer/usecases/billing';
import { isManualCustomerId } from '@/lib/billing/manual-customer';

const ctx = makeRequestContext('OWNER');

beforeEach(() => {
    jest.clearAllMocks();
    mockGetBillingMode.mockReturnValue('SAAS');
    mockUpsert.mockResolvedValue({});
});

describe('changeTenantPlan', () => {
    it('records an upgrade when the new plan outranks the current one', async () => {
        mockFindUnique.mockResolvedValue({ plan: 'FREE' });
        const res = await changeTenantPlan(ctx, 'PRO');
        expect(res).toEqual({ fromPlan: 'FREE', toPlan: 'PRO', direction: 'upgraded' });
        expect(mockUpgraded).toHaveBeenCalledWith({ fromPlan: 'FREE', toPlan: 'PRO' });
        expect(mockDowngraded).not.toHaveBeenCalled();
        expect(mockLogEvent).toHaveBeenCalledTimes(1);
    });

    it('records a downgrade when the new plan ranks below the current one', async () => {
        mockFindUnique.mockResolvedValue({ plan: 'PRO' });
        const res = await changeTenantPlan(ctx, 'FREE');
        expect(res.direction).toBe('downgraded');
        expect(mockDowngraded).toHaveBeenCalledWith({ fromPlan: 'PRO', toPlan: 'FREE' });
        expect(mockUpgraded).not.toHaveBeenCalled();
    });

    it('mints a customer id the checkout path knows is not a Stripe customer (#5120)', async () => {
        mockFindUnique.mockResolvedValue(null);
        await changeTenantPlan(ctx, 'PRO');
        const created = mockUpsert.mock.calls[0][0].create.stripeCustomerId as string;
        expect(isManualCustomerId(created)).toBe(true);
    });

    it('treats a missing BillingAccount as the FREE baseline', async () => {
        mockFindUnique.mockResolvedValue(null);
        const res = await changeTenantPlan(ctx, 'TRIAL');
        expect(res).toEqual({ fromPlan: 'FREE', toPlan: 'TRIAL', direction: 'upgraded' });
        expect(mockUpgraded).toHaveBeenCalledWith({ fromPlan: 'FREE', toPlan: 'TRIAL' });
    });

    it('is a no-op metric-wise when the plan is unchanged (but still audits)', async () => {
        mockFindUnique.mockResolvedValue({ plan: 'PRO' });
        const res = await changeTenantPlan(ctx, 'PRO');
        expect(res.direction).toBe('unchanged');
        expect(mockUpgraded).not.toHaveBeenCalled();
        expect(mockDowngraded).not.toHaveBeenCalled();
        expect(mockLogEvent).toHaveBeenCalledTimes(1);
    });

    it('refuses plan changes in self-hosted mode', async () => {
        mockGetBillingMode.mockReturnValue('SELFHOSTED');
        await expect(changeTenantPlan(ctx, 'PRO')).rejects.toThrow(/self-hosted/i);
        expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('rejects an unknown plan value', async () => {
        await expect(
            changeTenantPlan(ctx, 'BOGUS' as unknown as 'PRO'),
        ).rejects.toThrow(/unknown billing plan/i);
    });
});
