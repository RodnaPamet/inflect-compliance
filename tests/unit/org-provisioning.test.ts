/**
 * Epic O-2 — auto-provisioning service unit contract.
 *
 * Mocks Prisma at the module boundary to exercise the branching logic
 * in `org-provisioning.ts` without needing a live DB. The
 * end-to-end-against-real-schema-constraints assertions live in the
 * companion integration test (`tests/integration/org-provisioning.test.ts`).
 *
 * Coverage:
 *   * Happy path for both fan-out functions (counts, payload shape).
 *   * skipDuplicates routes correctly through the unique constraint.
 *   * Empty-set short-circuits (no DB write at all).
 *   * provisionAllOrgAdminsToTenant filters out ORG_READER members.
 *   * Deprovision targets ONLY (provisionedByOrgId, ADMIN) rows —
 *     manual rows + other-org rows + non-ADMIN-tagged rows untouched.
 *   * Deprovision returns the correct tenantIds list.
 */

const tenantFindManyMock = jest.fn();
const orgMembershipFindManyMock = jest.fn();
const tenantMembershipCreateManyMock = jest.fn();
const tenantMembershipFindManyMock = jest.fn();
const tenantMembershipDeleteManyMock = jest.fn();

jest.mock('@/lib/prisma', () => {
    const txClient = {
        tenantMembership: {
            findMany: (...args: unknown[]) => tenantMembershipFindManyMock(...args),
            deleteMany: (...args: unknown[]) => tenantMembershipDeleteManyMock(...args),
        },
    };
    const client = {
        tenant: {
            findMany: (...args: unknown[]) => tenantFindManyMock(...args),
        },
        orgMembership: {
            findMany: (...args: unknown[]) => orgMembershipFindManyMock(...args),
        },
        tenantMembership: {
            createMany: (...args: unknown[]) => tenantMembershipCreateManyMock(...args),
            findMany: (...args: unknown[]) => tenantMembershipFindManyMock(...args),
            deleteMany: (...args: unknown[]) => tenantMembershipDeleteManyMock(...args),
        },
        $transaction: <T,>(callback: (tx: typeof txClient) => Promise<T>) => callback(txClient),
    };
    return { __esModule: true, default: client, prisma: client };
});

import {
    provisionOrgAdminToTenants,
    provisionAllOrgAdminsToTenant,
    deprovisionOrgAdmin,
} from '@/app-layer/usecases/org-provisioning';

beforeEach(() => {
    tenantFindManyMock.mockReset();
    orgMembershipFindManyMock.mockReset();
    tenantMembershipCreateManyMock.mockReset();
    tenantMembershipFindManyMock.mockReset();
    tenantMembershipDeleteManyMock.mockReset();
});

// ── provisionOrgAdminToTenants ─────────────────────────────────────────

describe('provisionOrgAdminToTenants', () => {
    it('creates ADMIN memberships in every tenant under the org', async () => {
        tenantFindManyMock.mockResolvedValue([
            { id: 'tenant-1' },
            { id: 'tenant-2' },
            { id: 'tenant-3' },
        ]);
        // Pre-query for existing memberships returns empty — all
        // three tenants are eligible for new rows.
        tenantMembershipFindManyMock.mockResolvedValue([]);
        tenantMembershipCreateManyMock.mockResolvedValue({ count: 3 });

        const result = await provisionOrgAdminToTenants('org-1', 'user-1');

        expect(result).toEqual({
            created: 3,
            skipped: 0,
            totalConsidered: 3,
            tenantIds: ['tenant-1', 'tenant-2', 'tenant-3'],
        });

        const arg = tenantMembershipCreateManyMock.mock.calls[0][0];
        expect(arg.skipDuplicates).toBe(true);
        expect(arg.data).toHaveLength(3);
        for (const row of arg.data) {
            expect(row.userId).toBe('user-1');
            expect(row.role).toBe('ADMIN');
            expect(row.provisionedByOrgId).toBe('org-1');
        }
        expect(arg.data.map((r: { tenantId: string }) => r.tenantId)).toEqual([
            'tenant-1',
            'tenant-2',
            'tenant-3',
        ]);
    });

    it('reports skipped rows AND tenantIds = only-newly-created when some pairs already exist', async () => {
        tenantFindManyMock.mockResolvedValue([
            { id: 'tenant-1' },
            { id: 'tenant-2' },
            { id: 'tenant-3' },
        ]);
        // Pre-query: tenant-2 already has a membership for this user.
        tenantMembershipFindManyMock.mockResolvedValue([
            { tenantId: 'tenant-2' },
        ]);
        tenantMembershipCreateManyMock.mockResolvedValue({ count: 2 });

        const result = await provisionOrgAdminToTenants('org-1', 'user-1');

        expect(result).toEqual({
            created: 2,
            skipped: 1,
            totalConsidered: 3,
            tenantIds: ['tenant-1', 'tenant-3'], // only the newly-created
        });
    });

    it('is a no-op when the org has zero tenants (no DB write)', async () => {
        tenantFindManyMock.mockResolvedValue([]);

        const result = await provisionOrgAdminToTenants('org-1', 'user-1');

        expect(result).toEqual({
            created: 0,
            skipped: 0,
            totalConsidered: 0,
            tenantIds: [],
        });
        expect(tenantMembershipCreateManyMock).not.toHaveBeenCalled();
    });

    it('uses createMany with skipDuplicates (race safety net) AND skips it entirely when nothing to create', async () => {
        // Every tenant already has a membership — the function takes
        // the no-write fast path: createMany is skipped, audit-relevant
        // tenantIds list is empty.
        tenantFindManyMock.mockResolvedValue([{ id: 'tenant-1' }]);
        tenantMembershipFindManyMock.mockResolvedValue([
            { tenantId: 'tenant-1' },
        ]);

        const result = await provisionOrgAdminToTenants('org-1', 'user-1');

        expect(result).toEqual({
            created: 0,
            skipped: 1,
            totalConsidered: 1,
            tenantIds: [],
        });
        expect(tenantMembershipCreateManyMock).not.toHaveBeenCalled();
    });

    it('createMany still uses skipDuplicates as a race safety net when there IS work to do', async () => {
        tenantFindManyMock.mockResolvedValue([{ id: 'tenant-1' }]);
        tenantMembershipFindManyMock.mockResolvedValue([]);
        tenantMembershipCreateManyMock.mockResolvedValue({ count: 1 });

        await provisionOrgAdminToTenants('org-1', 'user-1');

        const arg = tenantMembershipCreateManyMock.mock.calls[0][0];
        expect(arg.skipDuplicates).toBe(true);
    });

    it('looks up tenants scoped to the supplied orgId only', async () => {
        tenantFindManyMock.mockResolvedValue([]);

        await provisionOrgAdminToTenants('org-target', 'user-1');

        expect(tenantFindManyMock).toHaveBeenCalledTimes(1);
        const arg = tenantFindManyMock.mock.calls[0][0];
        expect(arg.where).toEqual({ organizationId: 'org-target' });
    });
});

// ── provisionAllOrgAdminsToTenant ──────────────────────────────────────

describe('provisionAllOrgAdminsToTenant', () => {
    it('creates ADMIN memberships for every ORG_ADMIN of the org', async () => {
        orgMembershipFindManyMock.mockResolvedValue([
            { userId: 'admin-a' },
            { userId: 'admin-b' },
        ]);
        tenantMembershipCreateManyMock.mockResolvedValue({ count: 2 });

        const result = await provisionAllOrgAdminsToTenant('org-1', 'tenant-new');

        // tenantIds intentionally empty — see the function's docstring:
        // the per-tenant fan-out shape doesn't reuse the per-user
        // `tenantIds` field. A future audit hook for tenant creation
        // will introduce a per-(tenantId, userId) result shape.
        expect(result).toEqual({
            created: 2,
            skipped: 0,
            totalConsidered: 2,
            tenantIds: [],
        });

        const arg = tenantMembershipCreateManyMock.mock.calls[0][0];
        expect(arg.skipDuplicates).toBe(true);
        expect(arg.data).toHaveLength(2);
        for (const row of arg.data) {
            expect(row.tenantId).toBe('tenant-new');
            expect(row.role).toBe('ADMIN');
            expect(row.provisionedByOrgId).toBe('org-1');
        }
    });

    it('filters to the administrators, owner included (ORG_READER members not auto-provisioned)', async () => {
        orgMembershipFindManyMock.mockResolvedValue([]);

        await provisionAllOrgAdminsToTenant('org-1', 'tenant-new');

        const queryArg = orgMembershipFindManyMock.mock.calls[0][0];
        // #4576: an owner is an administrator, so a new tenant is
        // provisioned to it as to every ORG_ADMIN.
        expect(queryArg.where).toEqual({
            organizationId: 'org-1',
            role: { in: ['ORG_OWNER', 'ORG_ADMIN'] },
        });
    });

    it('is a no-op when the org has zero ORG_ADMINs (no DB write)', async () => {
        orgMembershipFindManyMock.mockResolvedValue([]);

        const result = await provisionAllOrgAdminsToTenant('org-1', 'tenant-new');

        expect(result).toEqual({
            created: 0,
            skipped: 0,
            totalConsidered: 0,
            tenantIds: [],
        });
        expect(tenantMembershipCreateManyMock).not.toHaveBeenCalled();
    });

    it('reports skipped rows when an admin already has a membership', async () => {
        orgMembershipFindManyMock.mockResolvedValue([
            { userId: 'admin-a' },
            { userId: 'admin-b' },
        ]);
        tenantMembershipCreateManyMock.mockResolvedValue({ count: 1 });

        const result = await provisionAllOrgAdminsToTenant('org-1', 'tenant-new');

        expect(result).toEqual({
            created: 1,
            skipped: 1,
            totalConsidered: 2,
            tenantIds: [],
        });
    });
});

// ── deprovisionOrgAdmin ────────────────────────────────────────────────

describe('deprovisionOrgAdmin', () => {
    it('targets ONLY rows tagged provisionedByOrgId AND role=ADMIN', async () => {
        tenantMembershipFindManyMock.mockResolvedValue([
            { tenantId: 'tenant-1' },
            { tenantId: 'tenant-2' },
        ]);
        tenantMembershipDeleteManyMock.mockResolvedValue({ count: 2 });

        const result = await deprovisionOrgAdmin('org-1', 'user-1');

        expect(result).toEqual({
            deleted: 2,
            tenantIds: ['tenant-1', 'tenant-2'],
        });

        // Both the targets-read and the delete must use the same predicate
        // (userId + provisionedByOrgId + role=ADMIN). The role clause is
        // load-bearing — see "manual memberships preserved" below.
        for (const call of [
            tenantMembershipFindManyMock.mock.calls[0][0],
            tenantMembershipDeleteManyMock.mock.calls[0][0],
        ]) {
            expect(call.where).toEqual({
                userId: 'user-1',
                provisionedByOrgId: 'org-1',
                role: 'ADMIN',
            });
        }
    });

    it('returns zero-count + empty tenantIds when nothing matches', async () => {
        tenantMembershipFindManyMock.mockResolvedValue([]);

        const result = await deprovisionOrgAdmin('org-1', 'user-1');

        expect(result).toEqual({ deleted: 0, tenantIds: [] });
        // Short-circuits BEFORE the deleteMany when there's nothing to delete.
        expect(tenantMembershipDeleteManyMock).not.toHaveBeenCalled();
    });

    it('preserves manual memberships (provisionedByOrgId IS NULL not in predicate)', async () => {
        // The predicate explicitly requires provisionedByOrgId === orgId, so
        // a NULL row never matches. Captured here as a structural check on
        // the predicate shape.
        tenantMembershipFindManyMock.mockResolvedValue([]);

        await deprovisionOrgAdmin('org-1', 'user-1');

        const where = tenantMembershipFindManyMock.mock.calls[0][0].where;
        expect(where.provisionedByOrgId).toBe('org-1');
        // Defence-in-depth: no broader OR clause can creep in
        expect(where.OR).toBeUndefined();
    });

    it('preserves rows provisioned by a DIFFERENT org', async () => {
        // Same structural check on the predicate — provisionedByOrgId is
        // pinned to the supplied orgId, so org-2 rows for the same user
        // are not matched.
        tenantMembershipFindManyMock.mockResolvedValue([]);

        await deprovisionOrgAdmin('org-1', 'user-cross-org');

        const where = tenantMembershipFindManyMock.mock.calls[0][0].where;
        expect(where.provisionedByOrgId).toBe('org-1');
    });

    it('the ADMIN role clause is present (defence-in-depth)', async () => {
        tenantMembershipFindManyMock.mockResolvedValue([]);

        await deprovisionOrgAdmin('org-1', 'user-1');

        // If a misconfigured row had provisionedByOrgId set on a non-
        // ADMIN record, this clause prevents the delete from widening
        // and silently removing higher-privilege memberships.
        expect(tenantMembershipFindManyMock.mock.calls[0][0].where.role).toBe('ADMIN');
        // deleteMany inherits the same predicate when targets > 0; covered
        // by the first test in this describe block.
    });
});

// ── Cross-cutting: idempotency ─────────────────────────────────────────

describe('idempotency under retry', () => {
    it('repeated provisionOrgAdminToTenants converges to a stable state', async () => {
        tenantFindManyMock.mockResolvedValue([{ id: 'tenant-1' }, { id: 'tenant-2' }]);

        // First run: pre-query returns empty → both eligible → 2 created.
        tenantMembershipFindManyMock.mockResolvedValueOnce([]);
        tenantMembershipCreateManyMock.mockResolvedValueOnce({ count: 2 });
        const a = await provisionOrgAdminToTenants('org-1', 'user-1');
        expect(a.created).toBe(2);
        expect(a.skipped).toBe(0);
        expect(a.tenantIds).toEqual(['tenant-1', 'tenant-2']);

        // Second run: pre-query returns BOTH tenants → toCreate is empty
        // → fast path skips createMany entirely → 0 created, 2 skipped.
        tenantMembershipFindManyMock.mockResolvedValueOnce([
            { tenantId: 'tenant-1' },
            { tenantId: 'tenant-2' },
        ]);
        const b = await provisionOrgAdminToTenants('org-1', 'user-1');
        expect(b.created).toBe(0);
        expect(b.skipped).toBe(2);
        expect(b.totalConsidered).toBe(2);
        expect(b.tenantIds).toEqual([]);
    });

    it('repeated deprovisionOrgAdmin is a no-op after the first call', async () => {
        // First run: deletes 2 rows
        tenantMembershipFindManyMock.mockResolvedValueOnce([
            { tenantId: 'tenant-1' },
            { tenantId: 'tenant-2' },
        ]);
        tenantMembershipDeleteManyMock.mockResolvedValueOnce({ count: 2 });
        const a = await deprovisionOrgAdmin('org-1', 'user-1');
        expect(a.deleted).toBe(2);

        // Second run: nothing left to delete
        tenantMembershipFindManyMock.mockResolvedValueOnce([]);
        const b = await deprovisionOrgAdmin('org-1', 'user-1');
        expect(b.deleted).toBe(0);
        expect(b.tenantIds).toEqual([]);
    });
});
