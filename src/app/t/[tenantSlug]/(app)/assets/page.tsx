import { getTranslations } from 'next-intl/server';
import { getTenantCtx } from '@/app-layer/context';
import { listAssets } from '@/app-layer/usecases/asset';
import { cachedSsrPayload } from '@/lib/cache/ssr-cache';
import { AssetsClient } from './AssetsClient';

export const dynamic = 'force-dynamic';

/**
 * Assets — Server Component wrapper.
 * Fetches asset list server-side (with URL filters applied),
 * delegates interaction to client island.
 */
export default async function AssetsPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { tenantSlug } = await params;
    const sp = await searchParams;

    // Translations and tenant context are independent — fetch in parallel
    const [t, tc, ctx] = await Promise.all([
        getTranslations('assets'),
        getTranslations('common'),
        getTenantCtx({ tenantSlug }),
    ]);

    // Build filters from searchParams for server-side data fetch
    const filters: Record<string, string> = {};
    for (const key of ['q', 'type', 'status']) {
        const val = sp[key];
        if (typeof val === 'string' && val) filters[key] = val;
    }

    // SSR payload cache — unfiltered load only; filtered bypasses (list-cache covers it).
    const fetchAssets = () => listAssets(ctx, Object.keys(filters).length > 0 ? filters : undefined);
    const assets =
        Object.keys(filters).length > 0
            ? await fetchAssets()
            : await cachedSsrPayload({ tenantId: ctx.tenantId, route: 'assets', ttlSeconds: 30, compute: fetchAssets });

    // Render the client directly (no wrapping <div>): the wrapper was a
    // plain block that severed ListPageShell's `md:flex-1 md:min-h-0`
    // flex chain, so the whole page scrolled instead of the table body
    // clamping to the viewport like Controls. animate-fadeIn now rides
    // the shell.
    return (
        <AssetsClient
                initialAssets={JSON.parse(JSON.stringify(assets))}
                initialFilters={filters}
                tenantSlug={tenantSlug}
                permissions={{ canWrite: ctx.permissions.canWrite, canAdmin: ctx.permissions.canAdmin }}
                translations={{
                    title: t('title'),
                listDescription: t('listDescription'),
                    addAsset: t('addAsset'),
                    createAsset: t('createAsset'),
                    name: t('name'),
                    type: t('type'),
                    classification: t('classification'),
                    classificationPlaceholder: t('classificationPlaceholder'),
                    owner: t('owner'),
                    location: t('location'),
                    dataResidency: t('dataResidency'),
                    residencyPlaceholder: t('residencyPlaceholder'),
                    confidentiality: t('confidentiality'),
                    integrity: t('integrity'),
                    availability: t('availability'),
                    controlsCol: t('controlsCol'),
                    noAssets: t('noAssets'),
                    cancel: tc('cancel'),
                }}
            />
    );
}
