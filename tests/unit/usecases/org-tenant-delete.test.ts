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
 */

const findFirst = jest.fn();
const update = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: {
            findFirst: (...a: unknown[]) => findFirst(...a),
            update: (...a: unknown[]) => update(...a),
        },
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
    });

    it('soft-deletes a tenant belonging to the org (sets deletedAt, no hard delete)', async () => {
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });
        update.mockResolvedValue({});

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
    });
});
