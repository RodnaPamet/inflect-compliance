/**
 * Which ADMIN-API writes a viewer is offered — generalised from the agent
 * register's affordances (#4471) to every admin page (#4467, #4466).
 *
 * A request to `/api/t/:slug/admin/**` passes three gates, in this order, and a
 * page that offers a control on fewer of them shows a button whose every press
 * is refused:
 *
 *   1. THE EDGE. `checkAdminAccess` (`src/lib/auth/guard.ts`) admits the admin
 *      API by the membership's BUILT-IN role in that tenant: OWNER and ADMIN,
 *      AI_ADMIN on the agent paths, AUDITOR on five inventory reads. A custom
 *      role never enters it. The verdict is asked on the server, by the edge's
 *      own function (`edgeAdmitsAdminApi` in `./admin-api-edge.ts`), and handed
 *      in: a client page receives it through the tenant layout
 *      (`TenantContextValue.edgeAdmitsAdminApi`).
 *   2. THE ROUTE: its literal `requirePermission(<key>)`, which reads the
 *      custom-role-aware permission set.
 *   3. THE USECASE FLOOR: a coarse tier the usecase asserts (`assertCanAdmin`
 *      reads `permissions.canAdmin`, which comes from a custom role's BASE), or
 *      a floor of its own (the agent usecases' "coarse tier OR the agent key").
 *
 * This module only ASKS; it widens nothing and is not an authority. Every write
 * still passes all three gates on the server. Pure and client-safe: no session,
 * no request, no import of the edge module (which pulls in `next/server`).
 */
import type { PermissionSet } from '@/lib/permissions';
import { hasPermission, type PermissionKey } from '@/lib/security/permission-key';

/** What the three gates read of a viewer. */
export interface AdminApiViewer {
    /** The edge's verdict for this viewer's request, asked on the server. */
    edgeAdmits: boolean;
    /** The custom-role-aware permission set the route's key is read from. */
    appPermissions: PermissionSet | null | undefined;
    /** The coarse tier a usecase asserts — a custom role's BASE decides it. */
    permissions?: { canAdmin?: boolean; canWrite?: boolean } | null;
}

/** One admin-API write: the route's key, and the usecase's floor. */
export interface AdminApiGate {
    /** The route's literal `requirePermission` key. */
    key: PermissionKey;
    /**
     * The usecase's floor: a coarse tier (`assertCanAdmin` / `assertCanWrite`
     * read exactly these), or the floor's own boolean for a usecase with
     * another one. Omitted for a usecase that asserts nothing beyond the route.
     */
    floor?: 'canAdmin' | 'canWrite' | boolean;
}

/** Whether `viewer` is offered the write `gate` describes: all three gates. */
export function offersAdminApiWrite(viewer: AdminApiViewer, gate: AdminApiGate): boolean {
    if (!viewer.edgeAdmits) return false;
    if (!viewer.appPermissions || !hasPermission(viewer.appPermissions, gate.key)) return false;
    if (gate.floor === undefined) return true;
    if (typeof gate.floor === 'boolean') return gate.floor;
    return viewer.permissions?.[gate.floor] === true;
}
