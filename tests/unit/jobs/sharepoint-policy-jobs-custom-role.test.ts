/**
 * The SharePoint policy pull and the subscription renewal act as the tenant's
 * oldest active OWNER/ADMIN whose RESOLVED authority, custom role included,
 * may write a policy version (#4388, owner decision 2026-10-26).
 *
 * They took the oldest OWNER/ADMIN by built-in role and gave them that role's
 * permissions, so a custom role on that admin was ignored. Now:
 *   - an admin whose custom role withholds `policies.edit` is passed over;
 *   - so is a READER-based role that grants it: a granted key does not lift the
 *     base role's coarse write flag, which `assertCanWritePolicies` asks too;
 *   - nobody qualifying is a named reason in the job's result and a warn log;
 *   - a built-in role's context is exactly the one these jobs built before.
 *
 * `findFirst` answers as the old query did (the oldest of the same rows), so
 * every test here also runs meaningfully against the code before the fix.
 */
const prismaMock = {
    tenantMembership: { findMany: jest.fn(), findFirst: jest.fn() },
    policy: { findFirst: jest.fn(), findMany: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

const sync = {
    pullPolicyFromSharePoint: jest.fn(),
    getSharePointClientForTenant: jest.fn(),
};
jest.mock('@/app-layer/usecases/policy-sharepoint-sync', () => sync);

const warnMock = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: (...a: unknown[]) => warnMock(...a), error: jest.fn(), debug: jest.fn() },
}));

import type { Role } from '@prisma/client';
import { runSharePointPolicyPull, runSharePointSubscriptionRenew } from '@/app-layer/jobs/sharepoint-policy-jobs';
import { initiatorAuthority } from '@/app-layer/context-system';
import { getPermissionsForRole } from '@/lib/permissions';

const BUILT_IN: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'AI_ADMIN'];
const ADMIN = getPermissionsForRole('ADMIN');
const READER = getPermissionsForRole('READER');

/** An ADMIN-based custom role that withholds `policies.edit`. */
const withoutPolicyEdit = { baseRole: 'ADMIN' as Role, permissionsJson: { policies: { ...ADMIN.policies, edit: false } } };
/** A READER-based custom role that grants `policies.edit`. */
const readerWithPolicyEdit = { baseRole: 'READER' as Role, permissionsJson: { policies: { ...READER.policies, edit: true } } };

const member = (userId: string, role: Role, customRole: { baseRole: Role; permissionsJson: unknown } | null = null) => ({
    userId,
    role,
    customRole,
});

/** The tenant's active OWNER/ADMIN rows, oldest first, as the query returns them. */
function admins(rows: ReturnType<typeof member>[]) {
    prismaMock.tenantMembership.findMany.mockResolvedValue(rows);
    prismaMock.tenantMembership.findFirst.mockResolvedValue(rows[0] ?? null);
}

/** The context the pull ran as. */
const pulledAs = () => sync.pullPolicyFromSharePoint.mock.calls[0]?.[0];

/** The context these jobs built before #4388, for a membership with no custom role. */
function contextBefore4388(tenantId: string, m: { userId: string; role: Role }) {
    const appPermissions = getPermissionsForRole(m.role);
    return {
        requestId: `sharepoint-policy-${tenantId}`,
        userId: m.userId,
        tenantId,
        role: m.role,
        permissions: {
            canRead: appPermissions.policies.view,
            canWrite: appPermissions.policies.edit,
            canAdmin: appPermissions.admin.manage,
            canAudit: appPermissions.audits.view,
            canExport: appPermissions.reports.export,
        },
        appPermissions,
    };
}

const pull = () => runSharePointPolicyPull({ tenantId: 'tenant-A', policyId: 'p1' } as never);

beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.policy.findFirst.mockResolvedValue({ spDriveId: 'd', spItemId: 'i' });
    prismaMock.policy.findMany.mockResolvedValue([{ id: 'p1', tenantId: 'tenant-A', spSubscriptionId: 'sub1' }]);
    sync.pullPolicyFromSharePoint.mockResolvedValue({ pulled: true });
    sync.getSharePointClientForTenant.mockResolvedValue({ renewSubscription: jest.fn().mockResolvedValue(undefined) });
});

describe('the jobs act as the oldest OWNER/ADMIN who may write a policy version', () => {
    it('passes over an oldest ADMIN whose custom role withholds policies.edit, for the next one', async () => {
        admins([member('oldest-custom-admin', 'ADMIN', withoutPolicyEdit), member('next-admin', 'ADMIN')]);

        await expect(pull()).resolves.toEqual({ pulled: true });

        expect(pulledAs()).toEqual(contextBefore4388('tenant-A', member('next-admin', 'ADMIN')));
        expect(prismaMock.tenantMembership.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: 'tenant-A', status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
                orderBy: { createdAt: 'asc' },
            }),
        );
    });

    it('passes over a READER-based role that grants policies.edit: the key does not lift the write tier', async () => {
        admins([member('reader-based-admin', 'ADMIN', readerWithPolicyEdit), member('next-admin', 'ADMIN')]);

        await pull();

        expect(pulledAs().userId).toBe('next-admin');
    });

    it('acts with the custom role a request from that admin would carry', async () => {
        // An EDITOR-based role on an ADMIN membership keeps policies.edit and
        // EDITOR's write tier, so it qualifies, as EDITOR.
        const editorBased = member('custom-admin', 'ADMIN', { baseRole: 'EDITOR', permissionsJson: {} });
        admins([editorBased]);

        await pull();

        expect(pulledAs()).toEqual({
            requestId: 'sharepoint-policy-tenant-A',
            userId: 'custom-admin',
            tenantId: 'tenant-A',
            ...initiatorAuthority(editorBased),
        });
        expect(pulledAs().role).toBe('EDITOR');
    });

    it('the renewal builds its client as the same admin', async () => {
        admins([member('oldest-custom-admin', 'ADMIN', withoutPolicyEdit), member('next-admin', 'ADMIN')]);

        const r = await runSharePointSubscriptionRenew({} as never);

        expect(sync.getSharePointClientForTenant.mock.calls[0][0].userId).toBe('next-admin');
        expect(r).toEqual({ subscriptions: 1, renewed: 1, unroutable: [] });
    });
});

describe('nobody to act as is a named reason, never a silent skip', () => {
    it('the pull: no_admin_with_policy_edit, a warn log, and no pull', async () => {
        admins([member('custom-admin', 'ADMIN', withoutPolicyEdit)]);

        await expect(pull()).resolves.toEqual({ pulled: false, reason: 'no_admin_with_policy_edit' });

        expect(sync.pullPolicyFromSharePoint).not.toHaveBeenCalled();
        expect(warnMock).toHaveBeenCalledWith(
            'sharepoint-policy-pull: no admin to act as',
            expect.objectContaining({ tenantId: 'tenant-A', reason: 'no_admin_with_policy_edit' }),
        );
    });

    it('the renewal: the tenant is reported, a warn log, and no client is built', async () => {
        admins([member('custom-admin', 'ADMIN', withoutPolicyEdit)]);

        const r = await runSharePointSubscriptionRenew({} as never);

        expect(r).toEqual({
            subscriptions: 1,
            renewed: 0,
            unroutable: [{ tenantId: 'tenant-A', reason: 'no_admin_with_policy_edit' }],
        });
        expect(sync.getSharePointClientForTenant).not.toHaveBeenCalled();
        expect(warnMock).toHaveBeenCalledWith(
            'sharepoint-subscription-renew: no admin to act as',
            expect.objectContaining({ tenantId: 'tenant-A', reason: 'no_admin_with_policy_edit' }),
        );
    });

    it('no active OWNER or ADMIN at all: no_admin, as before, and now logged', async () => {
        admins([]);

        await expect(pull()).resolves.toEqual({ pulled: false, reason: 'no_admin' });
        expect(warnMock).toHaveBeenCalledWith(
            'sharepoint-policy-pull: no admin to act as',
            expect.objectContaining({ reason: 'no_admin' }),
        );
    });
});

describe('a built-in role’s context is the one these jobs built before #4388', () => {
    // The query reads OWNER and ADMIN only. EDITOR is pinned too, so a change
    // to the rule cannot hide behind the query. READER, AUDITOR and AI_ADMIN
    // hold no policies.edit, so the pull's write gate refused them before and
    // after, and the query never returns them.
    const writers = BUILT_IN.filter((r) => getPermissionsForRole(r).policies.edit);

    it('covers OWNER, ADMIN and EDITOR', () => {
        expect(writers).toEqual(['OWNER', 'ADMIN', 'EDITOR']);
    });

    it.each(writers)('%s', async (role) => {
        admins([member('member-1', role)]);

        await pull();

        expect(pulledAs()).toEqual(contextBefore4388('tenant-A', member('member-1', role)));
    });
});
