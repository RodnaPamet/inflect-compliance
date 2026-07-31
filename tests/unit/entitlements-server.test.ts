/**
 * Branch coverage for the server-side entitlement gate.
 *
 * `entitlements-server.ts` is the boundary that turns a tenant's
 * billing plan into a hard 403 when a feature isn't included. The
 * branches that carry product risk:
 *
 *   - getTenantPlan: billing account present → its plan;
 *     absent → null (billing not configured → ungated)
 *   - requireFeature: null plan → pass-through (self-hosted /
 *     billing-off); plan present + feature included → pass;
 *     plan present + feature missing → throw EntitlementError
 *   - EntitlementError carries the typed code/status/requiredPlan/
 *     feature fields the route mapper reads
 *
 * Prisma is mocked — these are pure decision-logic assertions.
 */

const findUniqueMock = jest.fn();
const findManyMock = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        billingAccount: { findUnique: (...a: unknown[]) => findUniqueMock(...a) },
        billingEvent: { findMany: (...a: unknown[]) => findManyMock(...a) },
    },
}));

import {
    EntitlementError,
    getTenantPlan,
    requireFeature,
    hasFeatureForTenant,
    listBillingEvents,
} from '@/lib/entitlements-server';
import { FEATURES } from '@/lib/entitlements';

beforeEach(() => {
    findUniqueMock.mockReset();
    findManyMock.mockReset();
});

describe('getTenantPlan', () => {
    it('returns the plan when a billing account exists', async () => {
        findUniqueMock.mockResolvedValueOnce({ plan: 'PRO' });
        await expect(getTenantPlan('t1')).resolves.toBe('PRO');
    });

    it('returns null when no billing account exists', async () => {
        findUniqueMock.mockResolvedValueOnce(null);
        await expect(getTenantPlan('t1')).resolves.toBeNull();
    });

    it('queries by tenantId', async () => {
        findUniqueMock.mockResolvedValueOnce({ plan: 'FREE' });
        await getTenantPlan('tenant-xyz');
        expect(findUniqueMock).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-xyz' },
            select: { plan: true },
        });
    });
});

describe('requireFeature', () => {
    it('passes through when no billing account exists (ungated)', async () => {
        findUniqueMock.mockResolvedValueOnce(null);
        await expect(
            requireFeature('t1', FEATURES.CUSTOM_INTEGRATIONS),
        ).resolves.toBeUndefined();
    });

    it('passes when the plan includes the feature', async () => {
        findUniqueMock.mockResolvedValueOnce({ plan: 'ENTERPRISE' });
        await expect(
            requireFeature('t1', FEATURES.CUSTOM_INTEGRATIONS),
        ).resolves.toBeUndefined();
    });

    it('passes for a feature at exactly the tenant plan level', async () => {
        // PDF_EXPORTS requires TRIAL; a TRIAL tenant is exactly at the bar.
        findUniqueMock.mockResolvedValueOnce({ plan: 'TRIAL' });
        await expect(
            requireFeature('t1', FEATURES.PDF_EXPORTS),
        ).resolves.toBeUndefined();
    });

    it('throws EntitlementError when the plan lacks the feature', async () => {
        findUniqueMock.mockResolvedValueOnce({ plan: 'FREE' });
        await expect(
            requireFeature('t1', FEATURES.AUDIT_PACK_SHARING),
        ).rejects.toBeInstanceOf(EntitlementError);
    });

    it('the thrown error carries the typed code, status, and required plan', async () => {
        findUniqueMock.mockResolvedValueOnce({ plan: 'TRIAL' });

        let caught: EntitlementError | undefined;
        try {
            await requireFeature('t1', FEATURES.CUSTOM_INTEGRATIONS);
        } catch (err) {
            caught = err as EntitlementError;
        }

        expect(caught).toBeInstanceOf(EntitlementError);
        expect(caught?.code).toBe('PLAN_REQUIRED');
        expect(caught?.status).toBe(403);
        expect(caught?.requiredPlan).toBe('ENTERPRISE');
        expect(caught?.feature).toBe(FEATURES.CUSTOM_INTEGRATIONS);
        // Message names both the required and current plan for the UI.
        expect(caught?.message).toContain('ENTERPRISE');
        expect(caught?.message).toContain('TRIAL');
    });
});

describe('EntitlementError', () => {
    it('is a real Error with the documented name', () => {
        const err = new EntitlementError({
            message: 'nope',
            requiredPlan: 'PRO',
            feature: FEATURES.AUDIT_PACK_SHARING,
        });
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('EntitlementError');
        expect(err.message).toBe('nope');
        expect(err.code).toBe('PLAN_REQUIRED');
        expect(err.status).toBe(403);
    });
});

describe('listBillingEvents', () => {
    it('returns events ordered newest-first with the default limit', async () => {
        const events = [{ id: 'e1' }, { id: 'e2' }];
        findManyMock.mockResolvedValueOnce(events);

        const result = await listBillingEvents('t1');

        expect(result).toBe(events);
        expect(findManyMock).toHaveBeenCalledWith({
            where: { tenantId: 't1' },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
                id: true,
                type: true,
                stripeEventId: true,
                createdAt: true,
            },
        });
    });

    it('honours a custom limit', async () => {
        findManyMock.mockResolvedValueOnce([]);
        await listBillingEvents('t1', 5);
        expect(findManyMock.mock.calls[0][0].take).toBe(5);
    });
});


// ── hasFeatureForTenant ───────────────────────────────────────────────────
//
// The boolean twin of requireFeature, for callers that must BRANCH rather than
// throw — a server component deciding whether to render or redirect. The SoA
// print view uses it: that page had no entitlement check at all, so any member
// could open it and window.print() a full Statement of Applicability.
describe('hasFeatureForTenant', () => {
    it('is true when the plan includes the feature', async () => {
        findUniqueMock.mockResolvedValueOnce({ plan: 'PRO' });
        await expect(hasFeatureForTenant('t1', FEATURES.PDF_EXPORTS)).resolves.toBe(true);
    });

    it('is false when the plan does not include it', async () => {
        findUniqueMock.mockResolvedValueOnce({ plan: 'FREE' });
        await expect(hasFeatureForTenant('t1', FEATURES.PDF_EXPORTS)).resolves.toBe(false);
    });

    it('is true when no billing account exists (self-hosted / billing off)', async () => {
        // Same semantics as requireFeature's pass-through. A self-hosted
        // deployment must not have features silently disabled by the absence of
        // a billing row it will never have.
        findUniqueMock.mockResolvedValueOnce(null);
        await expect(hasFeatureForTenant('t1', FEATURES.AUDIT_PACK_SHARING)).resolves.toBe(true);
    });

    it('agrees with requireFeature on the same inputs', async () => {
        // The two must never disagree: a page that renders a control because
        // hasFeatureForTenant said yes, over an API that throws because
        // requireFeature said no, is the client/server split this pair exists
        // to keep closed.
        for (const plan of ['FREE', 'TRIAL', 'PRO', 'ENTERPRISE']) {
            for (const feature of Object.values(FEATURES)) {
                findUniqueMock.mockResolvedValueOnce({ plan });
                const allowed = await hasFeatureForTenant('t1', feature);
                findUniqueMock.mockResolvedValueOnce({ plan });
                const threw = await requireFeature('t1', feature).then(() => false, () => true);
                expect(allowed).toBe(!threw);
            }
        }
    });
});
