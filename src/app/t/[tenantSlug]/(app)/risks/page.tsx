import { getTranslations } from 'next-intl/server';
import { getTenantCtx } from '@/app-layer/context';
import { listRisks } from '@/app-layer/usecases/risk';
import type { RiskFilters } from '@/app-layer/repositories/RiskRepository';
import { getRiskMatrixConfig } from '@/app-layer/usecases/risk-matrix-config';
import { cachedSsrPayload } from '@/lib/cache/ssr-cache';
import { RisksClient } from './RisksClient';

export const dynamic = 'force-dynamic';

// SSR fetch is capped at the most-relevant SSR_PAGE_LIMIT rows so
// the initial HTML payload + DB query stay bounded as tenants
// accumulate risks. The Epic 69 SWR client immediately fetches
// the unbounded list in the background, swapped in by SWR's
// keepPreviousData with no flicker. Mirrors the PR #146 Tasks
// pattern.
const SSR_PAGE_LIMIT = 100;

/**
 * Risks — Server Component.
 * Fetches risk list server-side (with URL filters applied),
 * delegates interaction to client island.
 */
export default async function RisksPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { tenantSlug } = await params;
    const sp = await searchParams;

    // Translations and tenant context are independent — fetch in parallel
    const [t, td, ctx] = await Promise.all([
        getTranslations('risks'),
        getTranslations('riskManager'),
        getTenantCtx({ tenantSlug }),
    ]);

    // Build filters from searchParams. We maintain two views:
    //   - `clientFilters` mirrors the UI shape (`score=min|max` token) and
    //     hydrates `useFilterContext.serverFilters` so first-paint matches.
    //   - `apiFilters` is the API shape (`scoreMin` + `scoreMax`) passed to
    //     `listRisks` for the SSR data fetch. The UI ↔ API split lives in
    //     `risks/filter-defs.RISK_API_TRANSFORMS` on the client.
    const clientFilters: Record<string, string> = {};
    // Typed as `RiskFilters`, NOT `Record<string, string | number>`. The
    // previous shape was handed to listRisks through
    // `as unknown as Parameters<typeof listRisks>[1]`, so adding a key here
    // compiled even when the usecase had no such filter — the value was
    // silently ignored at the far end and the page quietly returned
    // unfiltered rows. Typing it makes the compiler check every assignment.
    const apiFilters: RiskFilters = {};
    for (const key of ['q', 'status', 'category', 'ownerUserId', 'treatment'] as const) {
        const val = sp[key];
        if (typeof val === 'string' && val) {
            clientFilters[key] = val;
            apiFilters[key] = val;
        }
    }
    // `quantified` is a two-value union, not a free string. The old loop
    // assigned whatever the query string carried, so `?quantified=maybe`
    // reached the repository as an unrecognised value; the cast hid the
    // mismatch. Narrow it instead.
    const quantified = sp['quantified'];
    if (quantified === 'yes' || quantified === 'no') {
        clientFilters.quantified = quantified;
        apiFilters.quantified = quantified;
    }
    // Score + residualScore both carry a `min|max` range token (PR-K adds
    // the residual band so a reviewer can slice by after-controls posture).
    for (const [token, minKey, maxKey] of [
        ['score', 'scoreMin', 'scoreMax'],
        ['residualScore', 'residualScoreMin', 'residualScoreMax'],
    ] as const) {
        const raw = sp[token];
        if (typeof raw === 'string' && raw.includes('|')) {
            clientFilters[token] = raw;
            const [min, max] = raw.split('|');
            if (min && !Number.isNaN(Number(min))) apiFilters[minKey] = Number(min);
            if (max && !Number.isNaN(Number(max))) apiFilters[maxKey] = Number(max);
        }
    }

    // SSR payload cache — unfiltered load only; filtered bypasses (list-cache covers it).
    const fetchRiskPayload = async () => {
        const [risks, matrixConfig] = await Promise.all([
            listRisks(
                ctx,
                Object.keys(apiFilters).length > 0 ? apiFilters : undefined,
                { take: SSR_PAGE_LIMIT },
            ),
            getRiskMatrixConfig(ctx),
        ]);
        return { risks, matrixConfig };
    };
    const { risks, matrixConfig } =
        Object.keys(apiFilters).length > 0
            ? await fetchRiskPayload()
            : await cachedSsrPayload({ tenantId: ctx.tenantId, route: 'risks', ttlSeconds: 30, compute: fetchRiskPayload });

    return (
        <RisksClient
            initialRisks={JSON.parse(JSON.stringify(risks))}
            initialFilters={clientFilters}
            matrixConfig={matrixConfig}
            tenantSlug={tenantSlug}
            permissions={ctx.permissions}
            translations={{
                title: t('title'),
                listDescription: t('listDescription'),
                risksIdentified: t('risksIdentified', { count: risks.length }),
                heatmap: t('heatmap'),
                histogram: t('histogram'),
                register: t('register'),
                addRisk: t('addRisk'),
                riskTitle: t('riskTitle'),
                asset: t('asset'),
                threat: t('threat'),
                score: t('score'),
                level: t('level'),
                treatment: t('treatment'),
                controlsCol: t('controlsCol'),
                noRisks: t('noRisks'),
                low: t('low'),
                medium: t('medium'),
                high: t('high'),
                critical: t('critical'),
                untreated: t('untreated'),
                heatmapTitle: t('heatmapTitle'),
                totalRisks: td('totalRisks'),
                avgScore: td('avgScore'),
                openRisks: td('openRisks'),
                overdueReviews: td('overdueReviews'),
            }}
        />
    );
}
