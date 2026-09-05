/**
 * Admin Permission Boundary Tests
 *
 * Verifies that all admin policy functions correctly enforce
 * ADMIN-only access and that safety invariants block dangerous operations.
 */
import { RequestContext } from '@/app-layer/types';
import {
    assertCanManageMembers,
    assertCanChangeRoles,
    assertCanViewAdminSettings,
    assertCanConfigureSSO,
    assertCanManageSCIM,
    assertNotSelfDemotion,
    assertNotSelfDeactivation,
} from '@/app-layer/policies/admin.policies';
import { computePermissions } from '@/lib/tenant-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { Role } from '@prisma/client';

// ─── Helpers ───

function makeCtx(role: Role, userId = 'user-1'): RequestContext {
    return {
        requestId: 'req-test',
        userId,
        tenantId: 'tenant-1',
        tenantSlug: 'acme-co',
        role,
        permissions: computePermissions(role),
        appPermissions: getPermissionsForRole(role),
    };
}

// ─── Policy Enforcement Tests ───

describe('Admin Policy Enforcement', () => {
    const NON_ADMIN_ROLES: Role[] = ['EDITOR', 'READER', 'AUDITOR'];
    const policies = [
        { name: 'assertCanManageMembers', fn: assertCanManageMembers },
        { name: 'assertCanChangeRoles', fn: assertCanChangeRoles },
        { name: 'assertCanViewAdminSettings', fn: assertCanViewAdminSettings },
        { name: 'assertCanConfigureSSO', fn: assertCanConfigureSSO },
        { name: 'assertCanManageSCIM', fn: assertCanManageSCIM },
    ];

    policies.forEach(({ name, fn }) => {
        describe(name, () => {
            it('allows ADMIN', () => {
                expect(() => fn(makeCtx('ADMIN'))).not.toThrow();
            });

            NON_ADMIN_ROLES.forEach((role) => {
                it(`rejects ${role}`, () => {
                    expect(() => fn(makeCtx(role))).toThrow(/permission/i);
                });
            });
        });
    });
});

// ─── Safety Invariant Tests ───

describe('Admin Safety Invariants', () => {
    it('assertNotSelfDemotion blocks demoting yourself', () => {
        const ctx = makeCtx('ADMIN', 'admin-user-1');
        expect(() => assertNotSelfDemotion(ctx, 'admin-user-1', 'EDITOR')).toThrow(/demote yourself/i);
    });

    it('assertNotSelfDemotion allows demoting another user', () => {
        const ctx = makeCtx('ADMIN', 'admin-user-1');
        expect(() => assertNotSelfDemotion(ctx, 'other-user', 'READER')).not.toThrow();
    });

    it('assertNotSelfDemotion allows keeping own ADMIN role', () => {
        const ctx = makeCtx('ADMIN', 'admin-user-1');
        expect(() => assertNotSelfDemotion(ctx, 'admin-user-1', 'ADMIN')).not.toThrow();
    });

    it('assertNotSelfDeactivation blocks deactivating yourself', () => {
        const ctx = makeCtx('ADMIN', 'admin-user-1');
        expect(() => assertNotSelfDeactivation(ctx, 'admin-user-1')).toThrow(/deactivate your own/i);
    });

    it('assertNotSelfDeactivation allows deactivating another user', () => {
        const ctx = makeCtx('ADMIN', 'admin-user-1');
        expect(() => assertNotSelfDeactivation(ctx, 'other-user')).not.toThrow();
    });
});

// ─── PermissionSet Tests ───

describe('PermissionSet admin capabilities', () => {
    it('OWNER has all admin permissions including tenant_lifecycle and owner_management', () => {
        const perms = getPermissionsForRole('OWNER');
        expect(perms.admin).toEqual({
            view: true,
            manage: true,
            members: true,
            sso: true,
            scim: true,
            tenant_lifecycle: true,
            owner_management: true,
            compliance_dsar_view: true,
            compliance_dsar_manage: true,
            agent_registry: true,
            agent_tool_exposure: true,
            agent_policy_card: true,
        });
    });

    it('ADMIN has operational permissions but NOT tenant_lifecycle or owner_management', () => {
        const perms = getPermissionsForRole('ADMIN');
        expect(perms.admin).toEqual({
            view: true,
            manage: true,
            members: true,
            sso: true,
            scim: true,
            tenant_lifecycle: false,
            owner_management: false,
            compliance_dsar_view: true,
            compliance_dsar_manage: true,
            agent_registry: true,
            agent_tool_exposure: true,
            agent_policy_card: true,
        });
    });

    it('EDITOR has no admin permissions', () => {
        const perms = getPermissionsForRole('EDITOR');
        expect(perms.admin).toEqual({
            view: false,
            manage: false,
            members: false,
            sso: false,
            scim: false,
            tenant_lifecycle: false,
            owner_management: false,
            compliance_dsar_view: false,
            compliance_dsar_manage: false,
            agent_registry: false,
            agent_tool_exposure: false,
            agent_policy_card: false,
        });
    });

    it('AUDITOR can READ the DSAR register but holds no other admin permission', () => {
        const perms = getPermissionsForRole('AUDITOR');
        expect(perms.admin).toEqual({
            view: false,
            manage: false,
            members: false,
            sso: false,
            scim: false,
            tenant_lifecycle: false,
            owner_management: false,
            compliance_dsar_view: true,
            compliance_dsar_manage: false,
            agent_registry: false,
            agent_tool_exposure: false,
            agent_policy_card: false,
        });
    });

    it('READER has no admin permissions', () => {
        const perms = getPermissionsForRole('READER');
        expect(perms.admin).toEqual({
            view: false,
            manage: false,
            members: false,
            sso: false,
            scim: false,
            tenant_lifecycle: false,
            owner_management: false,
            compliance_dsar_view: false,
            compliance_dsar_manage: false,
            agent_registry: false,
            agent_tool_exposure: false,
            agent_policy_card: false,
        });
    });
});

// ─── computePermissions Tests ───

describe('computePermissions admin flags', () => {
    it('ADMIN gets canAdmin=true', () => {
        expect(computePermissions('ADMIN').canAdmin).toBe(true);
    });

    it('EDITOR gets canAdmin=false', () => {
        expect(computePermissions('EDITOR').canAdmin).toBe(false);
    });

    it('READER gets canAdmin=false', () => {
        expect(computePermissions('READER').canAdmin).toBe(false);
    });

    it('AUDITOR gets canAdmin=false, canAudit=true', () => {
        const p = computePermissions('AUDITOR');
        expect(p.canAdmin).toBe(false);
        expect(p.canAudit).toBe(true);
    });
});
