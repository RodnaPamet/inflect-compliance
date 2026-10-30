/**
 * The EDGE half of the admin-API affordances (`./admin-api-affordances.ts`):
 * would the middleware admit this session's request to the admin API of
 * `tenantSlug`? Asked of `checkAdminAccess`, the middleware's own pure gate,
 * with the two JWT claims it reads — never a copy of its role table.
 *
 * Server-only in practice: `guard.ts` imports `next/server`. A client page gets
 * the verdict from the tenant layout (`TenantContextValue.edgeAdmitsAdminApi`).
 */
import { checkAdminAccess } from '@/lib/auth/guard';

/** The two JWT claims the edge's admin gate reads. */
export interface EdgeAdminClaims {
    /** The primary membership's role — read only for a path that names no tenant. */
    role?: string | null;
    /** Every membership the session carries, each with its built-in role. */
    memberships?: ReadonlyArray<{ slug: string; role: string }> | null;
}

/**
 * Would the edge admit `method` on `/api/t/<tenantSlug>/admin<subpath>`?
 * `'defer'` (the tenant is not in a capped claim) admits, as it does at the
 * edge, which leaves that request to the DB-backed gates.
 *
 * With no `subpath` it answers for the TENANT-WIDE admin API: every admin path
 * outside the agent subtree (where an AI admin is admitted) and the five
 * inventory reads (where an auditor is). That is the verdict the tenant layout
 * hands every admin page; `tests/unit/admin-api-affordances.test.ts` holds it
 * equal to the edge's answer for the custom roles and integrations APIs.
 */
export function edgeAdmitsAdminApi(
    tenantSlug: string,
    claims: EdgeAdminClaims | null | undefined,
    subpath = '',
    method = 'POST',
): boolean {
    return (
        checkAdminAccess(
            `/api/t/${tenantSlug}/admin${subpath}`,
            claims?.role ?? null,
            claims?.memberships ?? null,
            method,
        ) !== 'deny'
    );
}
