/**
 * Whether this viewer is offered the admin-API write a gate describes, for a
 * client page (#4467, #4466): the edge, the route's key and the usecase's
 * floor, each as the server asks it (`offersAdminApiWrite`).
 *
 * The edge's verdict is the membership's own role (#4581 B, #4587):
 * `membershipOpensAdminConsole(membershipRole)`, the same answer the admin
 * layout, `admitsAdminPage` and the sidebar give, from the set the edge's
 * `checkAdminAccess` applies to every admin path outside the agent subtree. A
 * missing `membershipRole` is NOT admitted.
 *
 * Its own module, NOT a hook on the tenant context provider, on purpose. Every
 * tenant page loads the provider, so whatever it imports at runtime ships in
 * every route's First Load JS; when this hook lived there, `admin-api-affordances`
 * and `permission-key` did, and every route grew (the bundle-size budget caught
 * it on the test-plan page). Only the admin pages that offer an admin-API write
 * import this, and so only they carry it.
 */
import { offersAdminApiWrite, type AdminApiGate } from '@/lib/auth/admin-api-affordances';
import { membershipOpensAdminConsole } from '@/lib/auth/edge-admin-roles';
import { useTenantContext } from '@/lib/tenant-context-provider';

export function useOffersAdminApiWrite(gate: AdminApiGate): boolean {
    const ctx = useTenantContext();
    return offersAdminApiWrite(
        {
            edgeAdmits: membershipOpensAdminConsole(ctx.membershipRole),
            appPermissions: ctx.appPermissions,
            permissions: ctx.permissions,
        },
        gate,
    );
}
