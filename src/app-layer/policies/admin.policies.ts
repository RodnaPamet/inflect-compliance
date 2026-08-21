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

/**
 * Asserts the caller may enumerate this tenant's quarantined files.
 *
 * SAME KEY AS THE REVERSAL — `admin.tenant_lifecycle`, OWNER-only —
 * and that is a deliberate choice rather than an oversight, because the
 * obvious alternative (let ADMIN read, keep OWNER for the write) is
 * defensible and was rejected for three reasons:
 *
 *   1. The list IS the index of the action. `clearFileQuarantine` takes
 *      a `fileId` and nothing else, so this read is the only way to
 *      obtain the argument the OWNER-only write consumes. Handing that
 *      to a role that cannot use it is disclosure with no matching
 *      capability; handing it to one that can is the same authority
 *      split over two calls.
 *   2. The rows are a map of the malware in a customer's evidence
 *      library — original filename, size, uploader, and the engine's
 *      threat signature. That is exactly the reconnaissance an attacker
 *      with a compromised ADMIN session wants: which payloads landed,
 *      which were caught, and what the scanner calls them.
 *   3. An ADMIN investigating an incident is not left blind. Every
 *      quarantine writes a hash-chained `FILE_QUARANTINED` audit row,
 *      and the audit trail is readable at the far lower `audit.view`
 *      bar. What OWNER buys here is the ACTIONABLE view, not the only
 *      view.
 *
 * The route is gated on the same key by `requirePermission`; this is the
 * usecase-layer twin, so a non-HTTP caller cannot reach the list without
 * the same authority.
 */
export function assertCanViewQuarantinedFiles(ctx: RequestContext): void {
    if (!ctx.appPermissions?.admin?.tenant_lifecycle) {
        throw forbidden(
            'Viewing quarantined files is an owner-level action.',
        );
    }
}
