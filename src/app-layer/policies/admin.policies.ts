/**
 * Admin Policies — Capability Boundaries for Tenant Administration
 *
 * Single source of truth for all admin action authorization.
 * All admin actions require the ADMIN role via ctx.permissions.canAdmin.
 *
 * @module policies/admin
 */
import { RequestContext } from '../types';
import { assertCanAdmin } from './common';
import { forbidden } from '@/lib/errors/types';

/**
 * Asserts the user can manage tenant members (invite, deactivate, remove).
 */
export function assertCanManageMembers(ctx: RequestContext): void {
    assertCanAdmin(ctx);
}

/**
 * Asserts the user can change roles for tenant members.
 */
export function assertCanChangeRoles(ctx: RequestContext): void {
    assertCanAdmin(ctx);
}

/**
 * Asserts the user can view tenant admin settings.
 */
export function assertCanViewAdminSettings(ctx: RequestContext): void {
    assertCanAdmin(ctx);
}

/**
 * Asserts the user can configure SSO identity providers.
 */
export function assertCanConfigureSSO(ctx: RequestContext): void {
    assertCanAdmin(ctx);
}

/**
 * Asserts the user can manage SCIM provisioning tokens.
 */
export function assertCanManageSCIM(ctx: RequestContext): void {
    assertCanAdmin(ctx);
}

// ─── Safety Invariants ───

/**
 * Prevents an admin from demoting themselves below ADMIN,
 * which would lock them out of admin functions.
 */
export function assertNotSelfDemotion(ctx: RequestContext, targetUserId: string, newRole: string): void {
    if (ctx.userId === targetUserId && newRole !== 'ADMIN') {
        throw forbidden('Cannot demote yourself. Ask another admin to change your role.');
    }
}

/**
 * Prevents an admin from deactivating their own membership.
 */
export function assertNotSelfDeactivation(ctx: RequestContext, targetUserId: string): void {
    if (ctx.userId === targetUserId) {
        throw forbidden('Cannot deactivate your own membership. Ask another admin.');
    }
}

// ─── Owner-grade capabilities ───

/**
 * Asserts the caller may return a quarantined file to circulation.
 *
 * Deliberately NOT `assertCanAdmin`. Clearing an INFECTED verdict puts
 * bytes ClamAV condemned back in front of every downloader, so it
 * carries the same OWNER-only key as tenant deletion and DEK rotation
 * — `admin.tenant_lifecycle`, which ADMIN is explicitly denied by the
 * role model in `src/lib/permissions.ts`.
 *
 * The HTTP route is gated on the same key by `requirePermission`; this
 * is the usecase-layer twin, so a non-HTTP caller (a script, a future
 * job) cannot reach the escape hatch without the same authority.
 */
export function assertCanClearFileQuarantine(ctx: RequestContext): void {
    if (!ctx.appPermissions?.admin?.tenant_lifecycle) {
        throw forbidden(
            'Clearing a malware quarantine is an owner-level action.',
        );
    }
}
