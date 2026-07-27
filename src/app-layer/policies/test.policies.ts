/**
 * Control Test RBAC policies.
 *
 * These gate on the GRANULAR `tests.*` keys in `ctx.appPermissions`, NOT the
 * coarse `ctx.permissions.canRead/canWrite`. The coarse flags are computed from
 * the membership's baseRole and IGNORE a custom role's `permissionsJson`, so a
 * custom role that sets `tests.execute:false` on an EDITOR base still passed the
 * old `canWrite` check. `appPermissions` is the custom-role-aware set
 * (`parsePermissionsJson`), so these keys are now actually enforceable — the
 * PermissionSet stops advertising control it did not have.
 */
import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

/** All roles can read test plans/runs by default (tests.view). */
export function assertCanReadTests(ctx: RequestContext) {
    if (!ctx.appPermissions.tests.view) {
        throw forbidden('You do not have permission to view test plans.');
    }
}

/** Create/update test plans (tests.create). */
export function assertCanManageTestPlans(ctx: RequestContext) {
    if (!ctx.appPermissions.tests.create) {
        throw forbidden('You do not have permission to manage test plans.');
    }
}

/** Execute/complete test runs (tests.execute). */
export function assertCanExecuteTests(ctx: RequestContext) {
    if (!ctx.appPermissions.tests.execute) {
        throw forbidden('You do not have permission to execute tests.');
    }
}

/** Link/unlink evidence on a test run — part of executing a test. */
export function assertCanLinkTestEvidence(ctx: RequestContext) {
    if (!ctx.appPermissions.tests.execute) {
        throw forbidden('You do not have permission to link evidence to test runs.');
    }
}

/**
 * Bulk-delete the tenant's test program. Bulk deletion is an ADMIN action —
 * matching the peer bulk registers (asset / risk / evidence / policy) — so an
 * EDITOR can no longer soft-delete every plan 100 at a time.
 */
export function assertCanBulkManageTestPlans(ctx: RequestContext) {
    if (!ctx.appPermissions.admin.manage) {
        throw forbidden('You do not have permission to bulk-delete test plans (administrator required).');
    }
}

/**
 * Export the test-evidence bundle. The CSV carries run notes, findingSummary,
 * evidence hashes and control codes out of the app — an EXPORT action gated on
 * `reports.export` (false for READER), NOT the vacuous read gate a READER
 * always passes.
 */
export function assertCanExportTests(ctx: RequestContext) {
    if (!ctx.appPermissions.reports.export) {
        throw forbidden('You do not have permission to export test evidence.');
    }
}
