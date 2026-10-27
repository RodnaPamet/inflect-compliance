/**
 * Control-specific RBAC policies.
 */
import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

/**
 * Custom-role-aware granular gate for the controls domain.
 *
 * `requirePermission` (the HTTP guard) reads `ctx.appPermissions` — the
 * custom-role JSON resolved via `parsePermissionsJson` — but these
 * usecase-layer asserts historically consulted only the coarse
 * `ctx.permissions.canRead/canWrite`, which is computed from the base role
 * ALONE (`computePermissions(effectiveRole)`). A custom role with
 * `baseRole=EDITOR` but `controls.edit=false` therefore passed the coarse
 * `canWrite` check and silently bypassed its own restriction. Every assert
 * below now ALSO consults the granular `controls` flag.
 *
 * Semantics — tighten, never loosen:
 *   - The coarse role check always applies (unchanged).
 *   - When `appPermissions` is present (it always is on a resolved
 *     `RequestContext` — both `resolveTenantContext` and the API-key path
 *     populate a complete `PermissionSet`), the matching granular flag must
 *     ALSO be granted, or the request is denied.
 *   - Defensive fallback: if `appPermissions` is entirely absent, fall back
 *     to the coarse check alone (returns `false` here). A present-but-partial
 *     `controls` object fails closed (`!== true` denies).
 *
 * @returns `true` when the granular layer denies the action.
 */
function granularControlsDenied(
    ctx: RequestContext,
    flag: 'view' | 'create' | 'edit',
): boolean {
    // No granular layer at all → honor the coarse check only.
    if (!ctx.appPermissions) return false;
    // Granular layer present → the flag must be explicitly granted.
    return ctx.appPermissions.controls?.[flag] !== true;
}

/** All roles can read controls */
export function assertCanReadControls(ctx: RequestContext) {
    if (!ctx.permissions.canRead || granularControlsDenied(ctx, 'view')) {
        throw forbidden('You do not have permission to view controls.');
    }
}

/**
 * Whether `assertCanReadControls` admits this context — the same rule, asked
 * rather than enforced, so there is one definition of it. For a page that
 * shows controls only as a supporting list (the Evidence library's control
 * pickers) and must still open for a custom role that may view evidence but
 * not controls.
 */
export function canReadControls(ctx: RequestContext): boolean {
    try {
        assertCanReadControls(ctx);
        return true;
    } catch {
        return false;
    }
}

/** ADMIN/EDITOR can create controls */
export function assertCanCreateControl(ctx: RequestContext) {
    if (!ctx.permissions.canWrite || granularControlsDenied(ctx, 'create')) {
        throw forbidden('You do not have permission to create controls.');
    }
}

/** ADMIN/EDITOR can update controls */
export function assertCanUpdateControl(ctx: RequestContext) {
    if (!ctx.permissions.canWrite || granularControlsDenied(ctx, 'edit')) {
        throw forbidden('You do not have permission to update controls.');
    }
}

/** ADMIN/EDITOR can link evidence */
export function assertCanLinkEvidence(ctx: RequestContext) {
    if (!ctx.permissions.canWrite || granularControlsDenied(ctx, 'edit')) {
        throw forbidden('You do not have permission to link evidence to controls.');
    }
}

/**
 * Whether `assertCanLinkEvidence` admits this context — the same rule, asked
 * rather than enforced, so there is one definition of it. For the evidence
 * library's create, edit and upload paths, which apply the rule only when a
 * request adds or removes a control link (#4326, owner decision).
 */
export function canLinkEvidence(ctx: RequestContext): boolean {
    try {
        assertCanLinkEvidence(ctx);
        return true;
    } catch {
        return false;
    }
}

/**
 * Deciding an exception — approving or rejecting one — is an ADMIN action with
 * its own granular key (#4387, owner decision 2026-10-27).
 *
 * It used to be `assertCanAdmin`, the coarse tier alone, which meant the
 * decision could not be withheld from a custom role on an admin base however
 * narrowly that role was drawn — and, because the routes carried no gate
 * either, a refusal wrote no `AUTHZ_DENIED` row. `admin.manage` is the key the
 * routes now require, so route and usecase ask the same question.
 */
export function assertCanDecideException(ctx: RequestContext) {
    if (!ctx.permissions.canAdmin || !ctx.appPermissions.admin.manage) {
        throw forbidden('You do not have permission to decide control exceptions.');
    }
}

/** ADMIN/EDITOR can set control applicability */
export function assertCanSetApplicability(ctx: RequestContext) {
    if (!ctx.permissions.canWrite || granularControlsDenied(ctx, 'edit')) {
        throw forbidden('You do not have permission to set control applicability.');
    }
}

/** ADMIN/EDITOR can map frameworks */
export function assertCanMapFramework(ctx: RequestContext) {
    if (!ctx.permissions.canWrite || granularControlsDenied(ctx, 'edit')) {
        throw forbidden('You do not have permission to map framework requirements.');
    }
}
