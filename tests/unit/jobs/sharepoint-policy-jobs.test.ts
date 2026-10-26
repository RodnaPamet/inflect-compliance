/**
 * Unit coverage for `src/app-layer/jobs/sharepoint-policy-jobs.ts`.
 *
 * Mocks prisma + the policy-sharepoint-sync usecases. Who the jobs act as,
 * custom roles included, is covered by sharepoint-policy-jobs-custom-role.test.ts.
 * Branches:
 *   runSharePointPolicyPull:
 *     - no admin → { pulled:false, reason:'no_admin' }.
 *     - policy missing spDriveId/spItemId → { pulled:false, reason:'not_linked' }.
 *     - linked policy → delegates to pullPolicyFromSharePoint → { pulled }.
 *   runSharePointSubscriptionRenew:
 *     - per-tenant client cache (built once per tenant).
 *     - tenant with no admin → client null → policy skipped, tenant reported.
 *     - getSharePointClientForTenant throws → caught → null → skipped.
 *     - successful renew → renewed++.
 *     - renewSubscription throws → caught, not counted.
 *     - null spSubscriptionId rows skipped.
 */
const prismaMock = {
    tenantMembership: { findMany: jest.fn() },
    policy: { findFirst: jest.fn(), findMany: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock }));

const sync = {
    pullPolicyFromSharePoint: jest.fn(),
    getSharePointClientForTenant: jest.fn(),
};
jest.mock('@/app-layer/usecases/policy-sharepoint-sync', () => sync);

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
    runSharePointPolicyPull,
    runSharePointSubscriptionRenew,
} from '@/app-layer/jobs/sharepoint-policy-jobs';

beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.tenantMembership.findMany.mockResolvedValue([{ userId: 'u1', role: 'ADMIN', customRole: null }]);
});

describe('runSharePointPolicyPull', () => {
    it('returns no_admin when the tenant has no active admin', async () => {
        prismaMock.tenantMembership.findMany.mockResolvedValue([]);
        const res = await runSharePointPolicyPull({ tenantId: 't1', policyId: 'p1' } as never);
        expect(res).toEqual({ pulled: false, reason: 'no_admin' });
    });

    it('returns not_linked when the policy lacks SharePoint identifiers', async () => {
        prismaMock.policy.findFirst.mockResolvedValue({ spDriveId: null, spItemId: null });
        const res = await runSharePointPolicyPull({ tenantId: 't1', policyId: 'p1' } as never);
        expect(res).toEqual({ pulled: false, reason: 'not_linked' });
    });

    it('delegates to pullPolicyFromSharePoint for a linked policy', async () => {
        prismaMock.policy.findFirst.mockResolvedValue({ spDriveId: 'd', spItemId: 'i' });
        sync.pullPolicyFromSharePoint.mockResolvedValue({ pulled: true });
        const res = await runSharePointPolicyPull({ tenantId: 't1', policyId: 'p1' } as never);
        expect(sync.pullPolicyFromSharePoint).toHaveBeenCalledWith(expect.anything(), { driveId: 'd', itemId: 'i' });
        expect(res).toEqual({ pulled: true });
    });
});

describe('runSharePointSubscriptionRenew', () => {
    it('renews each subscription with a cached per-tenant client', async () => {
        prismaMock.policy.findMany.mockResolvedValue([
            { id: 'p1', tenantId: 't1', spSubscriptionId: 'sub1' },
            { id: 'p2', tenantId: 't1', spSubscriptionId: 'sub2' }, // same tenant → cache reuse
        ]);
        const renewSubscription = jest.fn().mockResolvedValue(undefined);
        sync.getSharePointClientForTenant.mockResolvedValue({ renewSubscription });
        const res = await runSharePointSubscriptionRenew({} as never);
        expect(res).toEqual({ subscriptions: 2, renewed: 2, unroutable: [] });
        // client built once for t1 despite two policies
        expect(sync.getSharePointClientForTenant).toHaveBeenCalledTimes(1);
        expect(renewSubscription).toHaveBeenCalledTimes(2);
    });

    it('skips policies for a tenant with no admin (client null)', async () => {
        prismaMock.policy.findMany.mockResolvedValue([{ id: 'p1', tenantId: 't1', spSubscriptionId: 'sub1' }]);
        prismaMock.tenantMembership.findMany.mockResolvedValue([]);
        const res = await runSharePointSubscriptionRenew({} as never);
        expect(res).toEqual({ subscriptions: 1, renewed: 0, unroutable: [{ tenantId: 't1', reason: 'no_admin' }] });
        expect(sync.getSharePointClientForTenant).not.toHaveBeenCalled();
    });

    it('treats a client-build failure as null (skipped)', async () => {
        prismaMock.policy.findMany.mockResolvedValue([{ id: 'p1', tenantId: 't1', spSubscriptionId: 'sub1' }]);
        sync.getSharePointClientForTenant.mockRejectedValue(new Error('token fail'));
        const res = await runSharePointSubscriptionRenew({} as never);
        expect(res).toEqual({ subscriptions: 1, renewed: 0, unroutable: [] });
    });

    it('counts a renew failure without throwing', async () => {
        prismaMock.policy.findMany.mockResolvedValue([{ id: 'p1', tenantId: 't1', spSubscriptionId: 'sub1' }]);
        const renewSubscription = jest.fn().mockRejectedValue(new Error('graph down'));
        sync.getSharePointClientForTenant.mockResolvedValue({ renewSubscription });
        const res = await runSharePointSubscriptionRenew({} as never);
        expect(res).toEqual({ subscriptions: 1, renewed: 0, unroutable: [] });
    });

    it('skips rows with a null spSubscriptionId', async () => {
        prismaMock.policy.findMany.mockResolvedValue([{ id: 'p1', tenantId: 't1', spSubscriptionId: null }]);
        const res = await runSharePointSubscriptionRenew({} as never);
        expect(res).toEqual({ subscriptions: 1, renewed: 0, unroutable: [] });
        expect(sync.getSharePointClientForTenant).not.toHaveBeenCalled();
    });
});
