import { notFound } from 'next/navigation';

import { getOrgCtx } from '@/app-layer/context';
import { getPortfolioOverview } from '@/app-layer/usecases/portfolio';
import { listOrgDashboardWidgets } from '@/app-layer/usecases/org-dashboard-widgets';
import { getCurrentOrgThreatLevel } from '@/app-layer/usecases/org-threat-level';
import { getCurrentOrgMaturity } from '@/app-layer/usecases/org-maturity';
import { getInitiativesForWidget } from '@/app-layer/usecases/org-security-initiative';
import { toPlainJson } from '@/lib/server/to-plain-json';

import { PortfolioDashboard } from './PortfolioDashboard';

/**
 * Epic O-4 + Epic 41 — portfolio overview (CISO landing page).
 *
 * Server-rendered shell + client island for the configurable widget
 * surface. The server fetches:
 *
 *   1. Persisted widget rows for the org via
 *      `listOrgDashboardWidgets(ctx)`. Source of truth for layout +
 *      composition.
 *   2. Live portfolio data via `getPortfolioOverview(ctx)` —
 *      tenant list, latest snapshots, 90-day trends. The dispatcher
 *      maps each widget row to the right slice.
 *
 * Both are handed to the `<PortfolioDashboard>` client component
 * which owns:
 *   - widget state (initialized from server data)
 *   - edit-mode toggle (ORG_ADMIN only via `canConfigureDashboard`)
 *   - drag/resize → PATCH wiring
 *   - add-widget → POST wiring
 *   - delete-widget → DELETE wiring
 *
 * Read access is gated by `canViewPortfolio`; widget configuration
 * by `canConfigureDashboard`. Both are existing flags on
 * `OrgPermissionSet` — see `src/lib/permissions.ts`.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
    params: Promise<{ orgSlug: string }>;
}

export default async function PortfolioOverviewPage({ params }: PageProps) {
    const { orgSlug } = await params;

    let ctx;
    try {
        ctx = await getOrgCtx({ orgSlug });
    } catch {
        notFound();
    }

    // Fetch widgets + live portfolio data concurrently. Both reads
    // are org-scoped; the `getPortfolioData` helper memoises tenants
    // + snapshots within the request scope so the parallel reads
    // don't duplicate.
    const [widgets, overview, threatLevel, maturity, initiatives] = await Promise.all([
        listOrgDashboardWidgets(ctx),
        getPortfolioOverview(ctx, { trendDays: 90 }),
        getCurrentOrgThreatLevel(ctx),
        getCurrentOrgMaturity(ctx),
        getInitiativesForWidget(ctx, { topN: 5 }),
    ]);

    return (
        <PortfolioDashboard
            initialWidgets={toPlainJson(widgets)}
            data={toPlainJson({
                summary: overview.summary,
                tenantHealth: overview.tenantHealth,
                trends: overview.trends,
                orgSlug,
                threatLevel,
                canSetThreatLevel: ctx.permissions.canSetThreatLevel,
                maturity,
                canSetMaturity: ctx.permissions.canSetMaturity,
                initiatives,
                canManageInitiatives: ctx.permissions.canConfigureDashboard,
                canDrillDown: ctx.permissions.canDrillDown,
            })}
            canEdit={ctx.permissions.canConfigureDashboard}
            canManageTenants={ctx.permissions.canManageTenants}
        />
    );
}
