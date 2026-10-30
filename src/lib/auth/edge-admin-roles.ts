/**
 * The built-in roles the edge admits to an admin path, in a module with no
 * imports so a client component can hold the same set the middleware applies.
 *
 * The edge's admin gate (`checkAdminAccess` in `./guard.ts`) reads the role on
 * the person's OWN membership in the tenant the path names, never a custom
 * role's base, and refuses every `/api/t/:slug/admin/**` call from anybody
 * else (bar the agent paths for AI_ADMIN and the agent inventory reads for
 * AUDITOR). The admin pages read the same set (#4581 B, owner decision
 * 2026-10-30): a page whose data calls the edge would refuse is not shown
 * either, whatever a custom role grants. OWNER is strictly superior to ADMIN.
 */
export const EDGE_ADMIN_ROLES: ReadonlySet<string> = new Set(['ADMIN', 'OWNER']);

/**
 * Whether a membership whose own built-in role is `membershipRole` may open
 * the admin console at all. Absent is no: a caller whose membership role is
 * unknown is not shown pages the edge may refuse.
 */
export function membershipOpensAdminConsole(membershipRole: string | null | undefined): boolean {
    return membershipRole != null && EDGE_ADMIN_ROLES.has(membershipRole);
}
