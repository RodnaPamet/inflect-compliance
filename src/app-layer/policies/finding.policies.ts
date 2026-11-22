import type { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

/**
 * Finding-register write floors (#5369).
 *
 * The routes take `findings.create` / `findings.edit` (#4574), but
 * `createFinding` / `updateFinding` asserted only the role-tier write, so any
 * caller that reached them another way — approving an agent's FINDING
 * proposal, a materialiser, a vulnerability conversion — skipped the key a
 * custom role can withhold on a write-capable base. Same shape as
 * `assertCanCreateControl`: the coarse write AND, when a granular layer is
 * present, the flag explicitly granted.
 */
function granularFindingsDenied(ctx: RequestContext, flag: 'create' | 'edit'): boolean {
    // No granular layer at all → honour the coarse check only.
    if (!ctx.appPermissions) return false;
    // Granular layer present → the flag must be explicitly granted.
    return ctx.appPermissions.findings?.[flag] !== true;
}

/** Create a finding: the role-tier write and `findings.create`. */
export function assertCanCreateFinding(ctx: RequestContext): void {
    if (!ctx.permissions.canWrite || granularFindingsDenied(ctx, 'create')) {
        throw forbidden('You do not have permission to create findings.');
    }
}

/** Edit a finding: the role-tier write and `findings.edit`. */
export function assertCanUpdateFinding(ctx: RequestContext): void {
    if (!ctx.permissions.canWrite || granularFindingsDenied(ctx, 'edit')) {
        throw forbidden('You do not have permission to edit findings.');
    }
}
