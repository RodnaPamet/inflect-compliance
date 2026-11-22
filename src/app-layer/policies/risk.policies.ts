import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

/**
 * Risk-specific RBAC policies.
 * ADMIN & EDITOR can mutate; all roles can read.
 */

/**
 * Viewing risks: the coarse read tier AND `risks.view` (#5376, owner decision
 * 2026-11-12). Every built-in role that can read holds the key, so the granular
 * half only ever narrows a custom role or an API key's scopes.
 */
export function assertCanReadRisk(ctx: RequestContext): void {
    if (!ctx.permissions.canRead || granularRisksDenied(ctx, 'view')) {
        throw forbidden('You do not have permission to view risks in this context.');
    }
}

/**
 * Whether `assertCanReadRisk` admits this context — the same rule, asked rather
 * than enforced. For a read that shows risks only as the far side of a link
 * (traceability), which omits them rather than refusing the whole read.
 */
export function canReadRisks(ctx: RequestContext): boolean {
    try {
        assertCanReadRisk(ctx);
        return true;
    } catch {
        return false;
    }
}

/**
 * Granular risk flags (#5369). The routes take `risks.create` / `risks.edit`;
 * the usecases floor on them too, so a caller that reaches `createRisk` /
 * `updateRisk` another way (approving an agent's RISK proposal, a
 * materialiser) is held to the key a custom role can withhold on a
 * write-capable base. Same shape as `granularControlsDenied`.
 */
function granularRisksDenied(ctx: RequestContext, flag: 'view' | 'create' | 'edit'): boolean {
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
