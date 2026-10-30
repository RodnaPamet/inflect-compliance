import { getTenantCtx } from '@/app-layer/context';
import { listVulnerabilitiesForPage, VULN_STATUSES } from '@/app-layer/usecases/vulnerability';
import { VulnerabilitiesClient, type VulnRow } from './VulnerabilitiesClient';

export const dynamic = 'force-dynamic';

const VULN_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

/**
 * A filter list from the URL, as the filter toolbar writes it
 * (`?status=OPEN,MITIGATING`). Unknown values are dropped rather than
 * passed to the query.
 */
function listParam(value: string | string[] | undefined, allowed: readonly string[]): string[] {
    if (typeof value !== 'string' || !value) return [];
    return value.split(',').filter((v) => allowed.includes(v));
}

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
    // The status / severity filters are applied to the READ (#4465), so the
    // 500-row cap applies after them and "refine your filters" is true advice.
    const page = await listVulnerabilitiesForPage(ctx, {
        assetId,
        statuses: listParam(sp.status, VULN_STATUSES),
        severities: listParam(sp.severity, VULN_SEVERITIES),
    });

    // Each control follows its route's gate: the coarse tier AND the granular
    // keys the route asks (#4465). Built-in roles hold every key or none of
    // them, so for them this is `canWrite` exactly; a custom role sees only
    // the controls its keys can use.
    const p = ctx.appPermissions;
    const canTriage = ctx.permissions.canWrite && p.assets.edit;
    const can = {
        triage: canTriage,
        convertToRisk: canTriage && p.risks.create,
        convertToFinding: canTriage && p.findings.create,
        createTask: canTriage && p.tasks.create && p.tasks.edit,
    };

    return (
        <VulnerabilitiesClient
            initialRows={page.rows as unknown as VulnRow[]}
            truncated={page.truncated}
            cap={page.cap}
            // A scoped view says whose list it is (#4465). `asset` is null when
            // the id names no live asset — the list is then empty, and the
            // page must not claim it is every vulnerability you have.
            scope={assetId ? { assetId, asset: page.scopeAsset } : null}
            tenantSlug={resolved.tenantSlug}
            can={can}
        />
    );
}
