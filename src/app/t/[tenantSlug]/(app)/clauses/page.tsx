import { getTranslations } from 'next-intl/server';
import { getTenantCtx } from '@/app-layer/context';
import { listClauses } from '@/app-layer/usecases/clause';
import { ClausesBrowser } from './ClausesBrowser';
import { Heading } from '@/components/ui/typography';
import { BackAffordance } from '@/components/nav/BackAffordance';

export const dynamic = 'force-dynamic';

/**
 * Clauses — Server Component wrapper.
 * Fetches clause data server-side, delegates interactive browsing to client island.
 */
export default async function ClausesPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;

    // Translation and tenant context are independent — fetch in parallel
    const [t, ctx] = await Promise.all([
        getTranslations('clauses'),
        getTenantCtx({ tenantSlug }),
    ]);
    const clauses = await listClauses(ctx);

    return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance noFallback />
            <Heading level={1}>{t('title')}</Heading>
            <p className="text-content-muted text-sm">{t('subtitle')}</p>

            <ClausesBrowser
                clauses={JSON.parse(JSON.stringify(clauses))}
                tenantSlug={tenantSlug}
                canEdit={ctx.permissions.canWrite}
            />
        </div>
    );
}
