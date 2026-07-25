/**
 * Dashboard Usecases
 *
 * Provides:
 *  - getDashboardData  — existing minimal stats (backward compat)
 *  - getExecutiveDashboard — full executive KPI payload (single call)
 *
 * @module app-layer/usecases/dashboard
 */
import { RequestContext } from '../types';
import {
    DashboardRepository,
    type ExecutiveDashboardPayload,
} from '../repositories/DashboardRepository';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { cachedDashboardRead } from '@/lib/cache/list-cache';
import { badRequest } from '@/lib/errors/types';

// ─── Swappable KPI cards (dashboard "custom KPI" slot) ────────────────
//
// The dashboard's custom-KPI slot lets the user pick a KPI from a
// catalog that isn't part of the fixed executive payload. Each renders
// a headline number + a status/result pie. Loaded on demand (only when
// selected) so a picked-once KPI never taxes the default dashboard.

/** Catalog of KPIs selectable in the dashboard's custom slot. */
export const SWAPPABLE_KPI_KEYS = ['assets', 'audits', 'tests'] as const;
export type SwappableKpiKey = (typeof SWAPPABLE_KPI_KEYS)[number];

export function isSwappableKpiKey(v: string): v is SwappableKpiKey {
    return (SWAPPABLE_KPI_KEYS as readonly string[]).includes(v);
}

export interface DashboardKpiSegment {
    label: string;
    value: number;
    /** Hex used for both the pie arc and the legend dot. */
    color: string;
}

export interface DashboardKpiCardDto {
    key: SwappableKpiKey;
    /** Headline count (the big number on the tile). */
    headline: number;
    /** One-line secondary readout under the value. */
    subtitle: string;
    /** Pie/donut segments — the "different pie chart" this KPI renders. */
    segments: DashboardKpiSegment[];
}

/**
 * On-demand data for one swappable KPI card + its pie. Authorized on
 * every call; scoped to the tenant via `runInTenantContext`. Trends are
 * intentionally omitted for now ("pie now, trends later") — the daily
 * snapshot series doesn't yet carry these entities.
 */
export async function getDashboardKpi(
    ctx: RequestContext,
    key: SwappableKpiKey,
): Promise<DashboardKpiCardDto> {
    assertCanRead(ctx);
    if (!isSwappableKpiKey(key)) throw badRequest(`Unknown KPI key: ${key}`);

    return runInTenantContext(ctx, async (db): Promise<DashboardKpiCardDto> => {
        switch (key) {
            case 'assets': {
                const s = await DashboardRepository.getAssetSummary(db, ctx);
                const other = Math.max(0, s.total - s.active - s.retired);
                return {
                    key,
                    headline: s.total,
                    subtitle: `${s.highCriticality} high/critical`,
                    segments: [
                        { label: 'Active', value: s.active, color: '#22c55e' },
                        { label: 'Retired', value: s.retired, color: '#94a3b8' },
                        ...(other > 0
                            ? [{ label: 'Other', value: other, color: '#64748b' }]
                            : []),
                    ],
                };
            }
            case 'audits': {
                const s = await DashboardRepository.getAuditSummary(db, ctx);
                return {
                    key,
                    headline: s.total,
                    subtitle: `${s.complete} complete`,
                    segments: [
                        { label: 'Planning', value: s.planning, color: '#94a3b8' },
                        { label: 'In Progress', value: s.inProgress, color: '#f59e0b' },
                        { label: 'Ready', value: s.ready, color: '#3b82f6' },
                        { label: 'Complete', value: s.complete, color: '#22c55e' },
                    ],
                };
            }
            case 'tests': {
                const s = await DashboardRepository.getTestSummary(db, ctx);
                return {
                    key,
                    headline: s.total,
                    subtitle: `${s.pass} passed`,
                    segments: [
                        { label: 'Pass', value: s.pass, color: '#22c55e' },
                        { label: 'Fail', value: s.fail, color: '#dc2626' },
                        { label: 'Inconclusive', value: s.inconclusive, color: '#f59e0b' },
                        { label: 'Pending', value: s.pending, color: '#94a3b8' },
                    ],
                };
            }
        }
    });
}

/**
 * Original dashboard data — used by the current dashboard page.
 * Backward-compatible; do not modify the return shape.
 */
export async function getDashboardData(ctx: RequestContext) {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const [stats, recentActivity] = await Promise.all([
            DashboardRepository.getStats(db, ctx),
            DashboardRepository.getRecentActivity(db, ctx),
        ]);

        return {
            stats,
            recentActivity,
        };
    });
}

/**
 * Executive Dashboard — aggregated KPI payload.
 *
 * Returns all KPIs in a single structured response to minimize
 * round trips from the frontend. All sub-queries run in parallel
 * within a single transaction for consistency.
 *
 * Query budget:
 * - stats:            8 parallel count queries
 * - controlCoverage:  1 groupBy + 1 count
 * - riskBySeverity:   4 parallel counts
 * - riskByStatus:     1 groupBy
 * - evidenceExpiry:   5 parallel counts
 * - policySummary:    1 groupBy + 1 count
 * - taskSummary:      1 groupBy + 1 count
 * - vendorSummary:    2 counts
 * - exceptions:       5 parallel counts
 * - treatmentPlans:   5 parallel counts
 * Expected latency: <100ms on a warm connection pool
 */
export async function getExecutiveDashboard(ctx: RequestContext): Promise<ExecutiveDashboardPayload> {
    // Authorization is enforced on EVERY call, before any cache lookup — the
    // cache only ever holds data the requesting (tenant, user) is allowed to
    // read, and a denied caller never reaches the cached payload.
    assertCanRead(ctx);

    // PR3 perf: short-TTL cache (per tenant+user). Skips ~30 COUNT/GROUP BY
    // queries + ~6 RLS transactions on a hit. Bypassed entirely without Redis
    // (dev/test), so uncached behaviour is unchanged. Staleness ≤ TTL.
    return cachedDashboardRead({
        ctx,
        operation: 'executive',
        loader: () => runInTenantContext(ctx, async (db) => {
        const [
            stats,
            controlCoverage,
            riskBySeverity,
            riskByStatus,
            evidenceExpiry,
            policySummary,
            taskSummary,
            vendorSummary,
            riskHeatmap,
            upcomingExpirations,
            exceptions,
            treatmentPlans,
        ] = await Promise.all([
            DashboardRepository.getStats(db, ctx),
            DashboardRepository.getControlCoverage(db, ctx),
            DashboardRepository.getRiskBySeverity(db, ctx),
            DashboardRepository.getRiskByStatus(db, ctx),
            DashboardRepository.getEvidenceExpiry(db, ctx),
            DashboardRepository.getPolicySummary(db, ctx),
            DashboardRepository.getTaskSummary(db, ctx),
            DashboardRepository.getVendorSummary(db, ctx),
            DashboardRepository.getRiskHeatmap(db, ctx),
            DashboardRepository.getUpcomingExpirations(db, ctx),
            DashboardRepository.getExceptionSummary(db, ctx),
            DashboardRepository.getTreatmentPlanSummary(db, ctx),
        ]);

        return {
            stats,
            controlCoverage,
            riskBySeverity,
            riskByStatus,
            evidenceExpiry,
            policySummary,
            taskSummary,
            vendorSummary,
            riskHeatmap,
            upcomingExpirations,
            exceptions,
            treatmentPlans,
            computedAt: new Date().toISOString(),
        };
        }),
    });
}
