/**
 * Who may clear a legacy reconciliation queue.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT `assertCanAdmin`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `identity_reconciliation.confirm` is granted to OWNER and ADMIN, and
 * `computePermissions` sets `canAdmin` at `level >= 4`, which is OWNER and ADMIN
 * exactly. So for a built-in role the two are the same set, and
 * `assertCanAdmin` would be indistinguishable.
 *
 * It is not the same for a CUSTOM role. `parsePermissionsJson` merges a stored
 * permission blob over the base role's defaults, so a custom role can grant
 * `identity_reconciliation.confirm` on top of a READER base. Its `canAdmin`
 * stays false, because that is derived from the base role and nothing else.
 *
 * A coarse check would then refuse what the route allowed: `requirePermission`
 * reads the granular key and lets the request through, the usecase reads
 * `canAdmin` and throws. The custom role would be unusable and the failure would
 * read as a bug in the queue rather than a mismatch between two gates.
 *
 * Step 4b's brief says "make sure custom roles can express them". Reading the
 * granular key is what makes that true rather than stated.
 *
 * @module app-layer/policies/identity-reconciliation
 */

import { forbidden } from '@/lib/errors/types';
import type { RequestContext } from '../types';

/**
 * Seeing the queue. Granted to every built-in role, matching `personnel.view`
 * and `access_reviews.view`: a reviewer who cannot see why an account was
 * suggested to somebody cannot sanely confirm it, and the evidence is the whole
 * point of showing the queue at all.
 */
export function assertCanViewReconciliation(ctx: RequestContext): void {
    if (!ctx.appPermissions?.identity_reconciliation?.view) {
        throw forbidden('identity_reconciliation.view is required');
    }
}

/**
 * Deciding. Narrower than `access_reviews.decide` on purpose — see the
 * `PermissionSet` docblock. A confirmation is durable: the account resolves as
 * LINKED on every later run, and a LINKED is acted on without anybody looking.
 */
export function assertCanConfirmReconciliation(ctx: RequestContext): void {
    if (!ctx.appPermissions?.identity_reconciliation?.confirm) {
        throw forbidden('identity_reconciliation.confirm is required');
    }
}
