import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

/**
 * Risk-specific RBAC policies.
 * ADMIN & EDITOR can mutate; all roles can read.
 */

export function assertCanReadRisk(ctx: RequestContext): void {
    if (!ctx.permissions.canRead) {
        throw forbidden('You do not have permission to view risks in this context.');
    }
}

/**
 * Granular risk flags (#5369). The routes take `risks.create` / `risks.edit`;
 * the usecases floor on them too, so a caller that reaches `createRisk` /
 * `updateRisk` another way (approving an agent's RISK proposal, a
 * materialiser) is held to the key a custom role can withhold on a
 * write-capable base. Same shape as `granularControlsDenied`.
 */
function granularRisksDenied(ctx: RequestContext, flag: 'create' | 'edit'): boolean {
    // No granular layer at all → honour the coarse check only.
    if (!ctx.appPermissions) return false;
    // Granular layer present → the flag must be explicitly granted.
    return ctx.appPermissions.risks?.[flag] !== true;
}

export function assertCanCreateRisk(ctx: RequestContext): void {
    if (!ctx.permissions.canWrite || granularRisksDenied(ctx, 'create')) {
        throw forbidden('You do not have permission to create risks. Requires ADMIN or EDITOR role.');
    }
}

export function assertCanUpdateRisk(ctx: RequestContext): void {
    if (!ctx.permissions.canWrite || granularRisksDenied(ctx, 'edit')) {
        throw forbidden('You do not have permission to update risks. Requires ADMIN or EDITOR role.');
    }
}

export function assertCanSetStatus(ctx: RequestContext): void {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to change risk status. Requires ADMIN or EDITOR role.');
    }
}

export function assertCanMapControls(ctx: RequestContext): void {
    if (!ctx.permissions.canWrite) {
        throw forbidden('You do not have permission to map controls to risks. Requires ADMIN or EDITOR role.');
    }
}
