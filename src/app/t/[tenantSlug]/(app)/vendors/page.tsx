import { getTenantCtx } from '@/app-layer/context';
import { listVendors } from '@/app-layer/usecases/vendor';
import { VendorsClient } from './VendorsClient';

export const dynamic = 'force-dynamic';

// SSR fetch is capped at SSR_PAGE_LIMIT rows so the initial HTML
// payload + DB query stay bounded as tenants accumulate vendors.
// The Epic 69 SWR client immediately fetches the unbounded list
// in the background and keepPreviousData swaps it in transparently.
// Mirrors the PR #146 / #149 pattern.
const SSR_PAGE_LIMIT = 100;

/**
 * Vendors — Server Component wrapper.
 * Fetches vendor list server-side (with URL filters applied),
 * delegates interaction to client island.
 */
export default async function VendorRegisterPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { tenantSlug } = await params;
    const sp = await searchParams;
    const ctx = await getTenantCtx({ tenantSlug });

    // Build filters from searchParams for server-side data fetch.
    // riskRating is assessment-derived — VendorRepository._buildWhere maps it
    // to an `assessments: { some: { riskRating } }` predicate; it just wasn't
    // being forwarded from the SSR page, so the filter chip did nothing.
    const filters: Record<string, string> = {};
    for (const key of ['q', 'status', 'criticality', 'reviewDue', 'riskRating']) {
        const val = sp[key];
        if (typeof val === 'string' && val) filters[key] = val;
    }

    const vendors = await listVendors(
        ctx,
        Object.keys(filters).length > 0 ? filters : undefined,
        { take: SSR_PAGE_LIMIT },
    );

    // Render the client directly (no wrapping <div>): the plain-block
    // wrapper severed ListPageShell's `md:flex-1 md:min-h-0` flex chain,
    // so the whole page scrolled instead of the table body clamping to
    // the viewport like Controls. animate-fadeIn now rides the shell.
    return (
        <VendorsClient
            initialVendors={JSON.parse(JSON.stringify(vendors))}
            initialFilters={filters}
            tenantSlug={tenantSlug}
            // Each flag is what the server checks for that verb: the key the
            // route's `requirePermission` names AND what its usecase asserts.
            // `vendors.create` alone was the create button's gate while
            // `createVendor` asserts `vendors.edit`, and the bulk bar had no
            // gate at all (#4462).
            permissions={{
                // POST /vendors: vendors.create, then assertCanManageVendors.
                canCreate: ctx.appPermissions.vendors.create && ctx.appPermissions.vendors.edit,
                // bulk/status + bulk/assign: vendors.edit, route and usecase.
                canEdit: ctx.appPermissions.vendors.edit,
                // bulk/delete: admin.manage, then assertCanAdmin (coarse tier).
                canDelete: ctx.permissions.canAdmin && ctx.appPermissions.admin.manage,
            }}
        />
    );
}
