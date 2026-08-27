/**
 * DELETE /api/org/[orgSlug]/tenants/[tenantId]
 *
 * Soft-delete ("remove") a tenant from the org admin panel. ORG_ADMIN
 * only (canManageTenants). The tenant is marked deleted — filtered out
 * of tenant resolution + all listings, so it becomes inaccessible — but
 * its data is retained (no hard purge). Org-scoped: only the org's own
 * tenants are reachable; a foreign id resolves to 404.
 */
import { NextRequest, NextResponse } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { deleteTenantUnderOrg } from '@/app-layer/usecases/org-tenants';

interface RouteContext {
    params: Promise<{ orgSlug: string; tenantId: string }>;
}

type DeleteParams = { orgSlug: string; tenantId: string };

/**
 * Gated on `canManageTenants`.
 *
 * The inline check this replaces threw 403 and recorded NOTHING, so a refused
 * attempt to detach a tenant left no trace (#2147). The gate writes an
 * `ORG_AUTHZ_DENIED` row to OrgAuditLog — org denials cannot use AuditLog at
 * all, whose `tenantId` is NOT NULL.
 *
 * This is not a MOVE of the only check: `deleteTenantUnderOrg` gained
 * `assertCanManageOrgTenants` in the same diff, so non-HTTP callers stay
 * protected. Without that, replacing the route check would have removed the
 * sole gate on the usecase.
 */
export const DELETE = withApiErrorHandling(
    requireOrgPermission<DeleteParams>('canManageTenants', async (_req, { params }, ctx) => {
        const result = await deleteTenantUnderOrg(ctx, params.tenantId);
        return NextResponse.json({ tenant: result.tenant }, { status: 200 });
    }),
);
