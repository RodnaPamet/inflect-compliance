import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';

import { getTenantCtx } from '@/app-layer/context';
import { getExecutiveDashboard } from '@/app-layer/usecases/dashboard';
import {
    getLatestPostureSummary,
    toPostureDto,
} from '@/app-layer/usecases/compliance-posture';
import {
    getComplianceTrends,
    type TrendPayload,
} from '@/app-layer/usecases/compliance-trends';

import { cachedSsrPayload } from '@/lib/cache/ssr-cache';
import DashboardClient from './DashboardClient';
import RecentActivityCard from './RecentActivityCard';
import AgenticGovernanceCard from './AgenticGovernanceCard';
import { dashboardQuickAddGates, mayReadRecentActivity } from './dashboard-gates';
import { Card } from '@/components/ui/card';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

/**
 * Executive Dashboard — server shell (Epic 69 hybrid SSR + SWR).
 *
 *   1. Fetch the executive payload, trends and posture summary once per
 *      navigation, so first paint carries real data.
 *   2. Hand them to `<DashboardClient>` as SWR `fallbackData`; the client
 *      revalidates on focus and on mutation-site `mutate(...)`.
 *   3. `RecentActivityCard` stays a server component, passed as `children`
 *      so its server boundary survives the client edge — and only for a
 *      viewer who can read the audit log (`mayReadRecentActivity`), so
 *      nobody else fetches its rows or sees the card.
 *
 * Per-viewer gates (quick adds, the activity card) are computed here from
 * the request context, OUTSIDE the tenant-scoped payload cache below.
 */
export default async function DashboardPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const t = await getTranslations('dashboard');
    const ctx = await getTenantCtx({ tenantSlug });

    // One parallel batch. Trends and the posture summary are best-effort:
    // a fresh tenant has neither yet, and the client renders their empty
    // states rather than failing the page. The SSR payload cache is
    // per-tenant and tenant-version-keyed, so it may hold only tenant-pure
    // data (see docs/response-caching.md).
    const { exec, trends, postureSummary } = await cachedSsrPayload({
        tenantId: ctx.tenantId,
        route: 'dashboard',
        ttlSeconds: 60,
        compute: async () => {
            const [exec, trends, postureRow] = await Promise.all([
                getExecutiveDashboard(ctx),
                getComplianceTrends(ctx, 30).catch((): TrendPayload | null => null),
                // Cheap cached-row read; never invokes an LLM.
                getLatestPostureSummary(ctx).catch(() => null),
            ]);
            return { exec, trends, postureSummary: toPostureDto(postureRow) };
        },
    });

    return (
        <DashboardClient
            initialExec={exec}
            initialTrends={trends}
            initialPostureSummary={postureSummary}
            quickAdds={dashboardQuickAddGates(ctx)}
            agentic={<AgenticGovernanceCard tenantSlug={tenantSlug} />}
        >
            {mayReadRecentActivity(ctx) ? (
                <Suspense
                    fallback={
                        <Card className="space-y-compact">
                            <Skeleton className="h-4 w-full sm:w-32" />
                        </Card>
                    }
                >
                    <RecentActivityCard
                        tenantSlug={tenantSlug}
                        label={t('recentActivity')}
                        noActivityLabel={t('noRecentActivity')}
                    />
                </Suspense>
            ) : null}
        </DashboardClient>
    );
}
