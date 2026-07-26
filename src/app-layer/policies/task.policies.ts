import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

/**
 * Custom-role-aware granular gate for the tasks domain.
 *
 * `requirePermission` (the HTTP guard) reads `ctx.appPermissions` — the
 * custom-role JSON resolved via `parsePermissionsJson` — but these
 * usecase-layer asserts historically consulted only the coarse
 * `ctx.permissions.canRead/canWrite`, computed from the base role ALONE
 * (`computePermissions(effectiveRole)`). A custom role with
 * `baseRole=EDITOR` but `tasks.edit=false` therefore passed the coarse
 * `canWrite` check and silently bypassed its own restriction.
 *
 * Fixing it HERE rather than only at the route layer matters: the
 * deprecated `/api/t/[tenantSlug]/issues/**` surface forwards to these same
 * usecases, so a per-route guard on `/tasks` alone would leave the bypass
 * reachable through `/issues`. The usecase layer is the one choke point
 * every caller passes through.
 *
 * Semantics — tighten, never loosen (mirrors `control.policies`):
 *   - The coarse role check always applies (unchanged).
 *   - When `appPermissions` is present, the matching granular flag must
 *     ALSO be granted, or the request is denied.
 *   - Defensive fallback: if `appPermissions` is entirely absent, fall back
 *     to the coarse check alone. A present-but-partial `tasks` object fails
 *     closed (`!== true` denies).
 *
 * @returns `true` when the granular layer denies the action.
 */
function granularTasksDenied(
    ctx: RequestContext,
    flag: 'view' | 'create' | 'edit' | 'assign',
): boolean {
    // No granular layer at all → honor the coarse check only.
    if (!ctx.appPermissions) return false;
    // Granular layer present → the flag must be explicitly granted.
    return ctx.appPermissions.tasks?.[flag] !== true;
}

/**
 * All authenticated roles can read tasks.
 *
 * NOTE: `ctx.permissions.canRead` is true for EVERY built-in role, so before
 * the granular check this assert could never deny. It now genuinely enforces
 * for custom roles that revoke `tasks.view`.
 */
export function assertCanReadTasks(ctx: RequestContext) {
    if (!ctx.permissions.canRead || granularTasksDenied(ctx, 'view')) {
        throw forbidden('You do not have permission to view tasks.');
    }
}

/** ADMIN and EDITOR can create tasks. */
export function assertCanCreateTask(ctx: RequestContext) {
    if (!ctx.permissions.canWrite || granularTasksDenied(ctx, 'create')) {
        throw forbidden('You do not have permission to create tasks.');
    }
}

/** ADMIN and EDITOR can update / link tasks. */
export function assertCanWriteTasks(ctx: RequestContext) {
    if (!ctx.permissions.canWrite || granularTasksDenied(ctx, 'edit')) {
        throw forbidden('You do not have permission to modify tasks.');
    }
}

/**
 * ADMIN and EDITOR can (re)assign tasks.
 *
 * Split out from `assertCanWriteTasks` because `tasks.assign` is its own
 * granular flag — a custom role may grant edit while withholding the
 * ability to move work onto other people.
 */
export function assertCanAssignTasks(ctx: RequestContext) {
    if (!ctx.permissions.canWrite || granularTasksDenied(ctx, 'assign')) {
        throw forbidden('You do not have permission to assign tasks.');
    }
}

/**
 * ADMIN, EDITOR, and AUDITOR can add comments (broader for collaboration).
 * READER cannot comment.
 *
 * Gated on `edit` at the granular layer: there is no dedicated
 * `tasks.comment` flag, and a role that has had edit revoked should not be
 * able to write into the task's comment thread either.
 */
export function assertCanCommentOnTasks(ctx: RequestContext) {
    if (ctx.role === 'READER' || granularTasksDenied(ctx, 'edit')) {
        throw forbidden('You do not have permission to comment on tasks.');
    }
}
