import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';
import type { IncidentRefusal } from '@/lib/incident-refusals';

/**
 * Authorization for the NIS2 Article 23 incident-response surface.
 *
 * Reads (`incidents.view`) are available to every tenant member for
 * compliance visibility; mutations (`incidents.manage`) are a
 * privileged security-team action — ADMIN/OWNER by default. These are
 * the usecase-layer backstop for the route-layer `requirePermission`
 * gate (defense in depth), and they read the custom-role-aware
 * `appPermissions` set so a tenant's custom roles are honoured.
 */
export function assertCanViewIncidents(ctx: RequestContext): void {
    if (!ctx.appPermissions.incidents.view) {
        throw forbidden('You do not have permission to view incidents.');
    }
}

export function assertCanManageIncidents(ctx: RequestContext): void {
    if (!ctx.appPermissions.incidents.manage) {
        throw forbidden('You do not have permission to manage incidents.', { reason: 'INCIDENT_MANAGE_DENIED' satisfies IncidentRefusal });
    }
}
