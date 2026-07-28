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
import { Card } from '@/components/ui/card';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

/**
 * Executive Dashboard — server shell.
 *
 * After Epic 69 the dashboard is a hybrid SSR + SWR page:
 *
 *   1. This server component fetches the executive payload + trend
 *      data once on every navigation. The
 *      first paint therefore contains real data — no loading flash,
 *      no skeleton-on-cold-cache regression vs. the all-server
 *      version.
 *
 *   2. Those payloads are handed to `<DashboardClient>` as
 *      `initialExec` / `initialTrends`. The client component reads
 *      them through `useTenantSWR(CACHE_KEYS.dashboard.executive())`
 *      with `fallbackData`, so:
 *        - first render uses the server-fetched data synchronously,
 *        - subsequent visits hit SWR cache,
 *        - tab focus / network reconnect trigger a background
 *          refetch with no UI flash (the hook keeps previous data),
 *        - the control-status, risk-bulk, and evidence-upload
 *          mutation sites call `mutate(CACHE_KEYS.dashboard.executive())`
 *          to refresh this card stack precisely — no `router.refresh()`
 *          needed.
 *
 *   3. `RecentActivityCard` stays a server component (no API route
 *      yet). It's rendered HERE and passed as `children` to
 *      `<DashboardClient>` so its server boundary survives the
 *      client-component edge.
 *
 * Pre-Epic-69 this file was ~500 lines of inline JSX + a pair of
 * Suspense-streamed async wrappers. The new shape is intentionally
 * boring — fetch on the server, hand off to the client. Future
 * pages adopting the SWR pattern follow the same recipe.
 */
export default async function DashboardPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const t = await getTranslations('dashboard');
    const ctx = await getTenantCtx({ tenantSlug });

    // PR3 perf: fetch all three payloads in ONE parallel batch. Trends were
    // previously awaited AFTER the exec+matrix Promise.all — a serial waterfall
    // on the dashboard's hot path. The trend snapshot stays best-effort: a
    // daily-snapshot row may not exist for the first few days of a fresh tenant
    // (the client renders the empty state when `trends.daysAvailable < 2`), so
    // its rejection resolves to `null` inside the batch rather than failing the
    // whole page.
    // SSR payload cache (origin-tier, per-tenant, tenant-version-keyed).
    // getExecutiveDashboard is ~11 parallel COUNT queries and is NOT
    // list-cached, so this is the real win. Tenant-pure (no per-user data),
    // so a tenant-scoped key is safe. Any entity write bumps the tenant
    // version → next load recomputes. See docs/response-caching.md.
    const { exec, trends, postureSummary } = await cachedSsrPayload({
        tenantId: ctx.tenantId,
        route: 'dashboard',
        ttlSeconds: 60,
        compute: async () => {
            const [exec, trends, postureRow] = await Promise.all([
                getExecutiveDashboard(ctx),
                getComplianceTrends(ctx, 30).catch((): TrendPayload | null => null),
                // Cheap cached-row read; never invokes an LLM. best-effort so a
                // missing row (fresh tenant) doesn't fail the page.
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
        >
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
        </DashboardClient>
    );
}
