import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';
import { assertCanRead, assertCanWrite, assertCanAdmin } from './common';

/**
 * Custom-role-aware gates for the policy domain.
 *
 * ── What was actually wrong ────────────────────────────────────────────
 *
 * `getTenantCtx` resolves BOTH permission views correctly:
 *
 *   permissions    = computePermissions(effectiveRole)   ← coarse, base role
 *   appPermissions = parsePermissionsJson(customRole…)   ← granular, custom role
 *
 * The custom role's `permissionsJson` is NOT discarded — it lands in
 * `appPermissions`. The defect was on the consuming side: every policy
 * usecase called the GENERIC `assertCanRead/Write/Admin` from
 * `policies/common`, which read only the coarse view. So a custom role with
 * `baseRole: ADMIN` and `policies: { approve: false, edit: false }` still
 * published, rolled back, archived and purged — its own restrictions were
 * resolved, carried on the context, and then never consulted.
 *
 * That also explains the layer disagreement: `requirePermission` at the route
 * reads `appPermissions`, so a `baseRole: READER` with `policies.edit: true`
 * passed the HTTP gate and then failed the coarse `assertCanWrite` in the
 * usecase. Two layers, two different questions.
 *
 * Fixing it HERE rather than in `policies/common` is deliberate: `common` is
 * shared by every domain, and silently making it granular would change
 * authorization for surfaces that were never reviewed for it. This mirrors
 * `task.policies.ts`, which solved the same problem the same way.
 *
 * ── Semantics: tighten, never loosen ───────────────────────────────────
 *
 *   - The coarse role check always applies (unchanged).
 *   - When `appPermissions` is present, the matching granular flag must ALSO
 *     be granted, or the request is denied.
 *   - If `appPermissions` is entirely absent, fall back to the coarse check
 *     alone. A present-but-partial `policies` object fails CLOSED
 *     (`!== true` denies).
 *
 * A granted granular flag can therefore never widen a base role — it only
 * ever narrows it, which is why a `READER` with `policies.edit: true` is
 * still refused here rather than promoted.
 *
 * @returns `true` when the granular layer denies the action.
 */
function granularPoliciesDenied(
    ctx: RequestContext,
    flag: 'view' | 'create' | 'edit' | 'approve',
): boolean {
    // No granular layer at all → honor the coarse check only.
    if (!ctx.appPermissions) return false;
    // Granular layer present → the flag must be explicitly granted.
    return ctx.appPermissions.policies?.[flag] !== true;
}

/** Read the policy library. */
export function assertCanReadPolicies(ctx: RequestContext) {
    assertCanRead(ctx);
    if (granularPoliciesDenied(ctx, 'view')) {
        throw forbidden('You do not have permission to view policies.');
    }
}

/** Create a policy (from scratch or from a template). */
export function assertCanCreatePolicy(ctx: RequestContext) {
    assertCanWrite(ctx);
    if (granularPoliciesDenied(ctx, 'create')) {
        throw forbidden('You do not have permission to create policies.');
    }
}

/** Edit policy metadata, content, versions, evidence links. */
export function assertCanWritePolicies(ctx: RequestContext) {
    assertCanWrite(ctx);
    if (granularPoliciesDenied(ctx, 'edit')) {
        throw forbidden('You do not have permission to modify policies.');
    }
}

/**
 * Decide an approval — the `policies.approve` gate.
 *
 * This key has existed in `PermissionSet` since the permission model was
 * written and had ZERO enforcement sites: `decidePolicyApproval` gated on
 * `assertCanAdmin` alone, so the flag could be revoked on a custom role and
 * that role would still approve. It is now load-bearing.
 *
 * NOTE — there is still no ASSIGNED-APPROVER model. `PolicyApproval` carries
 * `requestedByUserId` and `approvedByUserId` but no nominated approver, so
 * "who may approve this particular policy" is answered by role alone: every
 * tenant admin holding `policies.approve` is implicitly an approver for
 * every policy. Separation of duties is enforced negatively (you may not
 * approve what you requested or authored) rather than positively (only these
 * named people may approve). Whether a named-approver model is required is a
 * product decision, not a refactor — it needs a schema column, an assignment
 * surface, and a rule for what happens when the named approver leaves the
 * tenant. Deliberately left as-is and surfaced rather than invented here.
 */
export function assertCanApprovePolicies(ctx: RequestContext) {
    assertCanAdmin(ctx);
    if (granularPoliciesDenied(ctx, 'approve')) {
        throw forbidden('You do not have permission to approve policies.');
    }
}

/**
 * Admin-tier policy lifecycle: publish, rollback, archive, purge.
 *
 * Gated on the `edit` flag rather than `approve` — publishing is the exercise
 * of write authority over the library, whereas `approve` is specifically the
 * sign-off decision that SoD protects. A custom role that keeps `approve` but
 * loses `edit` should not be able to publish.
 */
export function assertCanAdminPolicies(ctx: RequestContext) {
    assertCanAdmin(ctx);
    if (granularPoliciesDenied(ctx, 'edit')) {
        throw forbidden('You do not have permission to manage the policy lifecycle.');
    }
}
