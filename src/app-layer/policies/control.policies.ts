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
