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
 *
 * ── Read scope is TENANT-WIDE, and that is deliberate ──────────────────
 *
 * This gate answers "may you read tasks?", not "may you read THIS task?".
 * There is no assignee / reviewer / watcher / creator row-scoping —
 * every member holding `tasks.view` reads every task in the tenant.
 * Recording the reasoning so this is not mistaken for an oversight:
 *
 *   - A task here is a unit of COMPLIANCE REMEDIATION, not private work.
 *     It is the evidence that a finding was closed, a control gap was
 *     fixed, or an incident was handled. Auditors (the AUDITOR role
 *     exists precisely for this) must be able to see the whole
 *     remediation trail; a per-user view would make the register
 *     unauditable.
 *   - Tenant-wide reads are load-bearing for surfaces that aggregate
 *     across all tasks regardless of who owns them: `getTaskMetrics`
 *     (the KPI strip), control/asset/risk task rollups, coverage
 *     reporting, and audit-pack exports. Row-scoping the read would
 *     silently skew every one of those numbers per-viewer.
 *   - Tenant isolation is the real confidentiality boundary and is
 *     enforced independently, in depth: Postgres RLS plus a `tenantId`
 *     predicate on every repository query.
 *
 * Narrowing this is a PRODUCT decision, not a refactor — it would need a
 * scoping rule (assignee ∪ reviewer ∪ watcher ∪ creator, presumably with
 * an "all tasks" permission for ADMIN/AUDITOR), matching predicates on
 * the list, detail, metrics and rollup paths, and a decision about what
 * the aggregate surfaces above should report to a scoped viewer. Do not
 * bolt it onto this function alone: a gate that denies detail reads while
 * the list, KPI counts and control rollups still expose title and status
 * would leak the same information through a different door.
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
