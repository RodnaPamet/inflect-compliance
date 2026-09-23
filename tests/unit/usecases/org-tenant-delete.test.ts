/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for `deleteTenantUnderOrg` (soft-delete / "remove tenant"
 * from the org admin panel).
 *
 * Contract:
 *   - Only a tenant that belongs to THIS org and isn't already removed
 *     is reachable (org-scoped findFirst). A foreign/unknown id is a
 *     notFound — never touches another org's tenant.
 *   - On success it sets `deletedAt` (soft-delete; data retained) and
 *     does NOT delete the row or its children.
 *   - On success it also REVOKES every membership that still grants
 *     access, in the SAME transaction (#2747). `deletedAt` alone is a
 *     claim about every current query remembering the filter; the grants
 *     themselves otherwise survive the whole 90-day retention window.
 */

const findFirst = jest.fn();
const update = jest.fn();
const membershipUpdateMany = jest.fn();
const membershipDeleteMany = jest.fn();
/** Call order across the two statements — the trigger exemption depends on it. */
const calls: string[] = [];

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: {
            findFirst: (...a: unknown[]) => findFirst(...a),
            update: (...a: unknown[]) => update(...a),
        },
        tenantMembership: {
            updateMany: (...a: unknown[]) => membershipUpdateMany(...a),
            // Present so "did it erase instead of revoke?" is an assertion
            // rather than an absence the mock could not have expressed.
            deleteMany: (...a: unknown[]) => membershipDeleteMany(...a),
        },
        // Sequential batch transaction: Prisma runs the array in order, and
        // `deleteTenantUnderOrg` depends on that order (see its comment).
        $transaction: (ops: unknown[]) => Promise.all(ops),
        // recordTenantDeleted resolves plan via a BillingAccount lookup
        // (SAAS mode only). Mock it so the call is safe under any mode.
        billingAccount: {
            findUnique: jest.fn().mockResolvedValue(null),
        },
    },
}));
// org-tenants.ts pulls these in at module load.
jest.mock('@/lib/security/tenant-keys', () => ({
    generateAndWrapDek: jest.fn(() => ({ wrapped: 'x' })),
}));
jest.mock('@/app-layer/usecases/org-provisioning', () => ({
    provisionAllOrgAdminsToTenant: jest.fn(),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { deleteTenantUnderOrg } from '@/app-layer/usecases/org-tenants';
import type { OrgContext } from '@/app-layer/types';

const ctx = {
    organizationId: 'org-1',
    userId: 'u-1',
    orgSlug: 'acme',
    requestId: 'req-1',
    orgRole: 'ORG_ADMIN',
    // Was `{}`, which was harmless while `deleteTenantUnderOrg` had no
    // permission check of its own. It now asserts `canManageTenants` (added
    // with the org denial-audit work, #2147), so an empty set refuses the very
    // ORG_ADMIN this context is meant to represent.
    permissions: { canManageTenants: true },
} as unknown as OrgContext;

/** The same org, seen by someone who may not manage tenants. */
const readerCtx = {
    organizationId: 'org-1',
    userId: 'user-reader',
    orgSlug: 'acme',
    requestId: 'req-2',
    orgRole: 'ORG_READER',
    permissions: { canManageTenants: false },
} as unknown as OrgContext;

describe('deleteTenantUnderOrg', () => {
    it('refuses a caller without canManageTenants — the check the route no longer owns', async () => {
        // Added with #2147: before it, this usecase had NO permission check and
        // the route was the only gate, so a non-HTTP caller reached it
        // unguarded. Moving that check into `requireOrgPermission` without this
        // would have removed the only check there was.
        await expect(
            deleteTenantUnderOrg(readerCtx, 'tenant-1'),
        ).rejects.toMatchObject({ name: 'ForbiddenError' });
    });

    beforeEach(() => {
        findFirst.mockReset();
        update.mockReset();
        membershipUpdateMany.mockReset();
        membershipDeleteMany.mockReset();
        calls.length = 0;
        update.mockImplementation(() => {
            calls.push('tenant.update');
            return Promise.resolve({});
        });
        membershipUpdateMany.mockImplementation(() => {
            calls.push('tenantMembership.updateMany');
            return Promise.resolve({ count: 3 });
        });
        // Returns a BatchPayload like the real delegate, so swapping the
        // usecase to `deleteMany` fails on the assertion that names the
        // defect rather than on the mock returning undefined. A mutation
        // that crashes the harness proves the harness, not the assertion.
        membershipDeleteMany.mockImplementation(() => {
            calls.push('tenantMembership.deleteMany');
            return Promise.resolve({ count: 3 });
        });
    });

    it('soft-deletes a tenant belonging to the org (sets deletedAt, no hard delete)', async () => {
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });

        const res = await deleteTenantUnderOrg(ctx, 't-1');

        // Looked it up scoped to the org + not-already-deleted.
        expect(findFirst.mock.calls[0][0].where).toMatchObject({
            id: 't-1',
            organizationId: 'org-1',
            deletedAt: null,
        });
        // Soft-delete: update sets deletedAt, targets the row by id.
        const upd = update.mock.calls[0][0];
        expect(upd.where).toEqual({ id: 't-1' });
        expect(upd.data.deletedAt).toBeInstanceOf(Date);
        expect(res.tenant).toEqual({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });
    });

    it('rejects (notFound) a tenant not in this org — never updates', async () => {
        findFirst.mockResolvedValue(null);
        await expect(deleteTenantUnderOrg(ctx, 'foreign')).rejects.toThrow();
        expect(update).not.toHaveBeenCalled();
        expect(membershipUpdateMany).not.toHaveBeenCalled();
    });

    it('revokes every membership that still grants access, with the deletion timestamp', async () => {
        // The gap #2747 names: `deletedAt` is a claim about every future
        // query remembering the filter. The grants themselves outlived the
        // tenant for the whole 90-day retention window — 113 of them.
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });

        await deleteTenantUnderOrg(ctx, 't-1');

        expect(membershipUpdateMany).toHaveBeenCalledTimes(1);
        const args = membershipUpdateMany.mock.calls[0][0];
        expect(args.where).toEqual({
            tenantId: 't-1',
            // ACTIVE and INVITED are exactly what `resolveTenantContext`
            // lets through. Selecting on them (rather than "not
            // DEACTIVATED") also leaves a REMOVED row's terminal state and
            // an earlier revocation's `deactivatedAt` untouched.
            status: { in: ['ACTIVE', 'INVITED'] },
        });
        expect(args.data).toEqual({
            status: 'DEACTIVATED',
            deactivatedAt: expect.any(Date),
        });
        // ONE timestamp for both halves — "the tenant was removed" and
        // "access ended" are the same event, and an auditor reading the two
        // rows must not see them drift by a query's duration.
        const deletedAt = update.mock.calls[0][0].data.deletedAt as Date;
        expect(args.data.deactivatedAt.getTime()).toBe(deletedAt.getTime());
    });

    it('revokes rather than erases — the rows stay for "who had access?"', async () => {
        // The file's own docstring promises the data is "retained for
        // compliance and a possible restore". A deleteMany would answer an
        // auditor's question with silence.
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });

        await deleteTenantUnderOrg(ctx, 't-1');

        expect(membershipDeleteMany).not.toHaveBeenCalled();
        expect(membershipUpdateMany.mock.calls[0][0].data.status).toBe('DEACTIVATED');
    });

    it('soft-deletes BEFORE revoking, which is what clears the last-OWNER trigger', async () => {
        // `tenant_membership_last_owner_guard` raises P0001 on deactivating a
        // tenant's last ACTIVE OWNER, and migration 20260922200000 exempts
        // only a tenant already carrying `deletedAt`. Reverse these two and
        // every deletion aborts against a real database while this file's
        // mocks — which have no triggers — stay green.
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });

        await deleteTenantUnderOrg(ctx, 't-1');

        expect(calls).toEqual(['tenant.update', 'tenantMembership.updateMany']);
    });
});
