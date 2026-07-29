import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

/**
 * Vendor authorization.
 *
 * These helpers read `ctx.appPermissions.vendors.*` — the CUSTOM-ROLE-AWARE
 * permission set — rather than the coarse `ctx.permissions.canRead/canWrite`
 * they used before 2026-07-28.
 *
 * WHY THAT MATTERED. `computePermissions(role)` in `src/lib/tenant-context.ts`
 * takes ONLY the `Role` enum and derives its flags from a role-level table, so
 * it is structurally blind to a custom role's `permissionsJson`. Every vendor
 * usecase gated on `canWrite`, which meant the granular
 * `vendors: { view, create, edit }` keys were UNENFORCEABLE: a custom role
 * built on an EDITOR base with `vendors.edit: false` still passed
 * `assertCanManageVendors` and could create, edit and delete vendors,
 * documents, assessments and sub-processor relationships.
 *
 * `ctx.appPermissions` IS resolved from `permissionsJson` (see the custom-role
 * note on `getTenantCtx`), so reading it makes those keys real.
 *
 * BUILT-IN ROLE BEHAVIOUR IS UNCHANGED — verified against
 * `getPermissionsForRole` rather than assumed:
 *
 *   vendors.view  true for OWNER/ADMIN/EDITOR/AUDITOR/READER  ≡ old canRead
 *   vendors.edit  true for OWNER/ADMIN/EDITOR only            ≡ old canWrite
 *
 * Same fix the tests domain took on 2026-07-27, and the same one already
 * applied in `test.policies.ts`, `control.policies.ts`, `policy.policies.ts`,
 * `evidence.policies.ts`, `task.policies.ts` and `incident.policies.ts`.
 */

// ─── Read ───

export function assertCanReadVendors(ctx: RequestContext) {
    if (!ctx.appPermissions.vendors.view) throw forbidden('No read access');
}

// ─── Manage (ADMIN / EDITOR) ───

export function assertCanManageVendors(ctx: RequestContext) {
    if (!ctx.appPermissions.vendors.edit) throw forbidden('Only ADMIN or EDITOR can manage vendors');
}

export function assertCanManageVendorDocs(ctx: RequestContext) {
    if (!ctx.appPermissions.vendors.edit) throw forbidden('Only ADMIN or EDITOR can manage vendor documents');
}

export function assertCanRunAssessment(ctx: RequestContext) {
    if (!ctx.appPermissions.vendors.edit) throw forbidden('Only ADMIN or EDITOR can run vendor assessments');
}

// ─── Approve (ADMIN only) ───

/**
 * Deliberately still on the coarse `canAdmin` tier. There is no
 * `vendors.approve` key to migrate to, and folding it into `admin.manage`
 * would widen this change beyond the authz gap it exists to close. Left as a
 * separate decision rather than bundled in silently.
 */
export function assertCanApproveAssessment(ctx: RequestContext) {
    if (!ctx.permissions.canAdmin) throw forbidden('Only ADMIN can approve/reject assessments');
}

// ─── Epic G-3 — Vendor questionnaire template authoring ───

/**
 * Authoring sits at the same tier as vendor management — ADMIN +
 * EDITOR. Reviewer-tier (canAudit) and reader-tier roles cannot
 * edit templates because edits are versioned mutations of the
 * questionnaire surface auditors will see.
 */
export function assertCanManageVendorAssessmentTemplates(ctx: RequestContext) {
    if (!ctx.appPermissions.vendors.edit) {
        throw forbidden(
            'Only ADMIN or EDITOR can author vendor assessment templates',
        );
    }
}
