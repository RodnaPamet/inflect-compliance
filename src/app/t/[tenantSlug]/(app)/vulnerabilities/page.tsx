import { getTenantCtx } from '@/app-layer/context';
import { listVulnerabilities } from '@/app-layer/usecases/vulnerability';
import { VulnerabilitiesClient, type VulnRow } from './VulnerabilitiesClient';

export const dynamic = 'force-dynamic';

/**
 * Vulnerabilities — Server Component. Fetches matched CVEs across the tenant's
 * assets and delegates interaction (filter + convert) to the client island.
 */
export default async function VulnerabilitiesPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const resolved = await params;
    const sp = await searchParams;
    const ctx = await getTenantCtx(resolved);
    // Deep-link support: the asset page's "See all vulnerabilities" link lands
    // here with ?assetId=<id>, scoping the global view to that asset's CVE
    // matches. (The assets list's Vulns badge now opens the asset's own
    // Vulnerabilities tab instead, which also lists its scanner findings.)
    const assetId = typeof sp.assetId === 'string' && sp.assetId ? sp.assetId : undefined;
    const rows = (await listVulnerabilities(ctx, { assetId, take: 500 })) as unknown as VulnRow[];

    // Each control follows its route's gate: the coarse tier AND the granular
    // keys the route asks (#4465). Built-in roles hold every key or none of
    // them, so for them this is `canWrite` exactly; a custom role sees only
    // the controls its keys can use.
    const p = ctx.appPermissions;
    const canTriage = ctx.permissions.canWrite && p.assets.edit;
    const can = {
        triage: canTriage,
        convertToRisk: canTriage && p.risks.create,
        convertToFinding: canTriage,
        createTask: canTriage && p.tasks.create && p.tasks.edit,
    };

    return (
        <VulnerabilitiesClient
            initialRows={rows}
            tenantSlug={resolved.tenantSlug}
            can={can}
        />
    );
}
