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
    type RecentActivityEntry,
} from '../repositories/DashboardRepository';
import { assertCanAudit, assertCanRead } from '../policies/common';
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
export const SWAPPABLE_KPI_KEYS = [
    'assets',
    'audits',
    'tests',
    // Folded in from the standalone dashboard cards that used to sit below
    // the fixed grid — Evidence Status, Exception Inventory, Treatment
    // Plans. Each is now an on-demand swappable KPI (loaded only when the
    // user picks it) instead of always-computed rows in the executive
    // payload. The compute lives here now, not in getExecutiveDashboard.
    'evidence',
    'exceptions',
    'treatmentPlans',
] as const;
export type SwappableKpiKey = (typeof SWAPPABLE_KPI_KEYS)[number];

export function isSwappableKpiKey(v: string): v is SwappableKpiKey {
    return (SWAPPABLE_KPI_KEYS as readonly string[]).includes(v);
}

/**
 * A pie segment's CODE, not its label.
 *
 * The usecase names the slice; the client renders it in the reader's language
 * (`dashboard.customKpi.segments.<key>`). Returning English from here made
 * every slice untranslatable, and translating on the server would tie the DTO
 * to one request's locale.
 */
export const DASHBOARD_KPI_SEGMENT_KEYS = [
    'active',
    'retired',
    'other',
    'planning',
    'inProgress',
    'ready',
    'complete',
    'pass',
    'fail',
    'inconclusive',
    'pending',
    'overdue',
    'dueWithin7d',
    'due8to30d',
    'current',
    'expiringWithin7d',
    'expiring8to30d',
    'expired',
    'onTrack',
    'completed',
] as const;
export type DashboardKpiSegmentKey = (typeof DASHBOARD_KPI_SEGMENT_KEYS)[number];

/** The tile's secondary readout, as a message code (`dashboard.customKpi.subtitles.<key>`). */
export const DASHBOARD_KPI_SUBTITLE_KEYS = [
    'highCritical',
    'complete',
    'passed',
    'currentPercent',
    'active',
    'dueWithin7d',
] as const;
export type DashboardKpiSubtitleKey = (typeof DASHBOARD_KPI_SUBTITLE_KEYS)[number];

export interface DashboardKpiSegment {
    key: DashboardKpiSegmentKey;
    value: number;
    /** Hex used for both the pie arc and the legend dot. */
    color: string;
}

export interface DashboardKpiCardDto {
    key: SwappableKpiKey;
    /** Headline count (the big number on the tile). */
    headline: number;
    /** One-line secondary readout under the value: a code and its one number. */
    subtitle: { key: DashboardKpiSubtitleKey; count: number };
    /** Pie/donut segments — the "different pie chart" this KPI renders. */
    segments: DashboardKpiSegment[];
}

/**
 * On-demand data for one swappable KPI card + its pie. Authorized on
 * every call; scoped to the tenant via `runInTenantContext`. No trend
 * series here: where the daily snapshot already stores a metric's
 * history (assets), the client draws it from the trends payload it
 * already holds.
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
                    subtitle: { key: 'highCritical', count: s.highCriticality },
                    segments: [
                        { key: 'active', value: s.active, color: '#22c55e' },
                        { key: 'retired', value: s.retired, color: '#94a3b8' },
                        ...(other > 0
                            ? [{ key: 'other' as const, value: other, color: '#64748b' }]
                            : []),
                    ],
                };
            }
            case 'audits': {
                const s = await DashboardRepository.getAuditSummary(db, ctx);
                return {
                    key,
                    headline: s.total,
                    subtitle: { key: 'complete', count: s.complete },
                    segments: [
                        { key: 'planning', value: s.planning, color: '#94a3b8' },
                        { key: 'inProgress', value: s.inProgress, color: '#f59e0b' },
                        { key: 'ready', value: s.ready, color: '#3b82f6' },
                        { key: 'complete', value: s.complete, color: '#22c55e' },
                    ],
                };
            }
            case 'tests': {
                const s = await DashboardRepository.getTestSummary(db, ctx);
                return {
                    key,
                    headline: s.total,
                    subtitle: { key: 'passed', count: s.pass },
                    segments: [
                        { key: 'pass', value: s.pass, color: '#22c55e' },
                        { key: 'fail', value: s.fail, color: '#dc2626' },
                        { key: 'inconclusive', value: s.inconclusive, color: '#f59e0b' },
                        { key: 'pending', value: s.pending, color: '#94a3b8' },
                    ],
                };
            }
            case 'evidence': {
                // Review-timeliness PARTITION. This used to be summed from
                // getEvidenceExpiry, whose due-soon windows and `current`
                // overlap (an approved item due in three weeks is in both), so
                // the headline counted that item twice. The breakdown's four
                // buckets are disjoint by construction, so their sum is a
                // count of rows.
                const s = await DashboardRepository.getEvidenceReviewBreakdown(db, ctx);
                const headline = s.overdue + s.dueWithin7d + s.due8to30d + s.current;
                const currentPct =
                    headline > 0 ? Math.round((s.current / headline) * 100) : 0;
                return {
                    key,
                    headline,
                    subtitle: { key: 'currentPercent', count: currentPct },
                    segments: [
                        { key: 'overdue', value: s.overdue, color: '#dc2626' },
                        { key: 'dueWithin7d', value: s.dueWithin7d, color: '#f97316' },
                        { key: 'due8to30d', value: s.due8to30d, color: '#f59e0b' },
                        { key: 'current', value: s.current, color: '#22c55e' },
                    ],
                };
            }
            case 'exceptions': {
                // Control-exception inventory. expiringWithin30 INCLUDES
                // expiringWithin7, and both are subsets of activeApproved, so
                // the pie splits Active into the healthy remainder + two
                // disjoint expiring slices (all max-0 guarded).
                const s = await DashboardRepository.getExceptionSummary(db, ctx);
                const expiring8to30 = Math.max(
                    0,
                    s.expiringWithin30 - s.expiringWithin7,
                );
                const healthyActive = Math.max(
                    0,
                    s.activeApproved - s.expiringWithin30,
                );
                const headline = s.activeApproved + s.pendingRequest + s.expired;
                return {
                    key,
                    headline,
                    subtitle: { key: 'active', count: s.activeApproved },
                    segments: [
                        { key: 'active', value: healthyActive, color: '#22c55e' },
                        { key: 'expiringWithin7d', value: s.expiringWithin7, color: '#f97316' },
                        { key: 'expiring8to30d', value: expiring8to30, color: '#f59e0b' },
                        { key: 'pending', value: s.pendingRequest, color: '#3b82f6' },
                        { key: 'expired', value: s.expired, color: '#dc2626' },
                    ],
                };
            }
            case 'treatmentPlans': {
                // Risk treatment-plan lifecycle. The three headline buckets are
                // disjoint (future-active / elapsed-not-done / done); the 7-day
                // urgency slice rides in the subtitle rather than as a segment
                // (dueWithin7's status filter isn't a clean subset of active).
                const s = await DashboardRepository.getTreatmentPlanSummary(db, ctx);
                const headline = s.activeOnTrack + s.overdue + s.completed;
                return {
                    key,
                    headline,
                    subtitle: { key: 'dueWithin7d', count: s.dueWithin7 },
                    segments: [
                        { key: 'onTrack', value: s.activeOnTrack, color: '#22c55e' },
                        { key: 'overdue', value: s.overdue, color: '#dc2626' },
                        { key: 'completed', value: s.completed, color: '#3b82f6' },
                    ],
                };
            }
        }
    });
}

/**
 * The dashboard's Recent Activity feed: the ten latest audit-log entries,
 * humanised and titled.
 *
 * Gated exactly as the audit log itself (`listAuditLogs`): `assertCanAudit`,
 * which OWNER, ADMIN and AUDITOR hold. The feed IS the audit log's head, so a
 * role the audit-log route refuses must not read it here either (owner
 * decision, 2026-10-29). The dashboard page asks the same question before it
 * renders the card, so other roles neither fetch the rows nor see an empty
 * card; this assertion is what holds if a caller forgets to ask.
 */
export async function getDashboardRecentActivity(
    ctx: RequestContext,
): Promise<RecentActivityEntry[]> {
    assertCanAudit(ctx);
    return runInTenantContext(ctx, (db) =>
        DashboardRepository.getRecentActivityDetailed(db, ctx),
    );
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
 *
 * The exception-inventory, treatment-plan, risk-heatmap, and
 * evidence-expiry-list widgets moved to the on-demand swappable-KPI slot
 * (or were removed), so those aggregates are NO LONGER computed here — the
 * executive payload only carries what the always-on dashboard shell + the
 * server-side posture summary read.
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
        ] = await Promise.all([
            DashboardRepository.getStats(db, ctx),
            DashboardRepository.getControlCoverage(db, ctx),
            DashboardRepository.getRiskBySeverity(db, ctx),
            DashboardRepository.getRiskByStatus(db, ctx),
            DashboardRepository.getEvidenceExpiry(db, ctx),
            DashboardRepository.getPolicySummary(db, ctx),
            DashboardRepository.getTaskSummary(db, ctx),
            DashboardRepository.getVendorSummary(db, ctx),
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
            computedAt: new Date().toISOString(),
        };
        }),
    });
}
