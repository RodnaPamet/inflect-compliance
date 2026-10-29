import { getTenantCtx } from '@/app-layer/context';
import { listIncidents, listIncidentKpiCounts } from '@/app-layer/usecases/incident';
import { IncidentsClient } from './IncidentsClient';

export const dynamic = 'force-dynamic';

// SSR fetch is capped at SSR_PAGE_LIMIT rows so the initial HTML payload
// stays bounded; the SWR client then fetches the backfill-capped list
// (`{ rows, truncated, kpiCounts }`) and swaps it in. Same pattern as the
// other register pages.
const SSR_PAGE_LIMIT = 100;

/**
 * Incidents — Server Component (NIS2 Article 23 incident response).
 * Fetches the first page of the per-tenant incident list and the KPI
 * counts server-side and delegates all interaction to the client island.
 */
export default async function IncidentsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    const [incidents, kpiCounts] = await Promise.all([
        listIncidents(ctx, { take: SSR_PAGE_LIMIT }),
        listIncidentKpiCounts(ctx),
    ]);

    return (
        <IncidentsClient
            initialIncidents={JSON.parse(JSON.stringify(incidents))}
            initialKpiCounts={kpiCounts}
            tenantSlug={tenantSlug}
            canManage={ctx.appPermissions.incidents.manage}
        />
    );
}
