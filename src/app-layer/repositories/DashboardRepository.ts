import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { TERMINAL_TASK_STATUSES } from '../domain/task-status';
import { HIGH_RISK_SCORE_MIN, needsTreatmentRiskStatusFilter } from '../domain/risk-status';
import { URGENCY_MS } from '@/lib/urgency';
import {
    evidenceExpiryScopeWhere,
    EVIDENCE_OUTSTANDING_STATUS_FILTER,
    EVIDENCE_REVIEWED_STATUS,
} from '../domain/evidence-expiry';
import { normalizeActivityEntity } from '@/lib/audit/activity-humanize';
import { criticalScoreFloor } from '@/lib/risk-matrix/critical-band';

/**
 * Ratio → percentage, guaranteed finite and clamped to [0, 100], with
 * one decimal place.
 *
 * The dashboard's percentage KPIs are read by formatters that assume a
 * real number — `AnimatedNumber`, `toFixed(1)` in the digest email, and
 * the `× 10` basis-point conversion in the daily snapshot job. None of
 * them can distinguish "no data" from "bad arithmetic", so the guard
 * belongs at the point of derivation: a non-finite ratio (zero or
 * negative denominator, non-numeric count from a future aggregate
 * shape) collapses to 0 here rather than travelling to the UI.
 */
function finitePercent(numerator: number, denominator: number): number {
    const ratio = numerator / denominator;
    if (!Number.isFinite(ratio)) return 0;
    return Math.min(100, Math.max(0, Math.round(ratio * 1000) / 10));
}

/**
 * The evidence review windows: due within 7 days, and within 30.
 *
 * The boundaries come from the shared urgency scale so "due soon" means the
 * same number of days here and on the calendar. Both evidence readers below
 * take them from here, so they cannot drift apart from each other either.
 */
function evidenceReviewWindows(now: Date): { in7d: Date; in30d: Date } {
    return {
        in7d: new Date(now.getTime() + URGENCY_MS.URGENT),
        in30d: new Date(now.getTime() + URGENCY_MS.UPCOMING),
    };
}

// ─── Executive Dashboard DTO Types ─────────────────────────────────

/**
 * Headline KPI stats — simple counts for the stat-card grid.
 *
 * Every field here has a live reader: the executive dashboard grid
 * reads `risks`/`highRisks`/`evidence`/`pendingEvidence`/`openTasks`/
 * `openFindings`, and the assistant read-path
 * (`getDashboardData` → `assistant.ts`) additionally reads `controls`
 * and `overdueEvidence`. The previously-computed-but-never-read
 * `assets` / `clausesReady` / `totalClauses` / `unreadNotifications`
 * fields were removed — the dashboard stopped paying for the
 * `asset.count` / `clauseProgress.findMany` / `notification.count`
 * queries that backed them.
 */
export interface DashboardStats {
    // ── Entity totals ──
    risks: number;
    controls: number;
    evidence: number;
    openTasks: number;
    openFindings: number;

    // ── Alert indicators ──
    /**
     * Risks still needing treatment (OPEN or MITIGATING) with an inherent
     * score of 10 or more — the High and Critical bands of `RiskBySeverity`,
     * so the Risks card's "N high/critical" equals the Risk Distribution
     * card's High + Critical. Mitigated, accepted and closed risks are left
     * out. See `app-layer/domain/risk-status`.
     */
    highRisks: number;
    pendingEvidence: number;
    overdueEvidence: number;
}

/**
 * OPEN-risk breakdown by severity tier.
 * Severity is derived from the `inherentScore` field (likelihood × impact, 1–25).
 * Closed and accepted risks are in no tier: a risk nobody still owns is not a
 * severity anybody has to act on.
 */
export interface RiskBySeverity {
    /** Score 1–4 */
    low: number;
    /** Score 5–9 */
    medium: number;
    /** Score 10–14 */
    high: number;
    /** Score 15–25 */
    critical: number;
}

/**
 * Risk counts by status.
 */
export interface RiskByStatus {
    open: number;
    mitigating: number;
    accepted: number;
    closed: number;
}

/**
 * Control coverage metrics.
 *
 * "Coverage" = the percentage of applicable controls that have reached
 * IMPLEMENTED status. Controls marked NOT_APPLICABLE (via the
 * applicability field) are excluded from the denominator.
 */
export interface ControlCoverage {
    total: number;
    applicable: number;
    implemented: number;
    inProgress: number;
    notStarted: number;
    planned: number;
    needsReview: number;
    /** implemented / applicable × 100, rounded to 1 decimal */
    coveragePercent: number;
}

/**
 * Evidence expiry summary.
 * Computed relative to current server time.
 */
export interface EvidenceExpiry {
    /** nextReviewDate is past AND status ≠ APPROVED */
    overdue: number;
    /** nextReviewDate within 7 days */
    dueSoon7d: number;
    /** nextReviewDate within 30 days */
    dueSoon30d: number;
    /** No nextReviewDate set */
    noReviewDate: number;
    /** Status = APPROVED and not overdue */
    current: number;
}

/**
 * Evidence review timeliness as a PARTITION — every row in at most one bucket.
 *
 * `EvidenceExpiry` is not one: its `dueSoon*` windows count evidence of any
 * status while `current` counts approved evidence whose review date is null or
 * in the future, so an approved item due in three weeks is in both. That is
 * harmless where the two are read separately and wrong wherever they are
 * summed, which is what the dashboard's "Evidence status" metric does.
 *
 * Here the review window wins, as it does on the Evidence page's freshness
 * filter (an approved row due soon is "expiring" there, not "current"):
 *   - overdue     review date past, not approved (same as `EvidenceExpiry`)
 *   - dueWithin7d review date in [now, now+7d], any status
 *   - due8to30d   review date in (now+7d, now+30d], any status
 *   - current     approved, review date null or after now+30d
 */
export interface EvidenceReviewBreakdown {
    overdue: number;
    dueWithin7d: number;
    due8to30d: number;
    current: number;
}

/**
 * Policy status summary.
 */
export interface PolicySummary {
    total: number;
    draft: number;
    inReview: number;
    approved: number;
    published: number;
    archived: number;
    /** Policies with nextReviewAt in the past */
    overdueReview: number;
}

/**
 * Task summary for executive view.
 */
export interface TaskSummary {
    total: number;
    /** OPEN + TRIAGED */
    open: number;
    inProgress: number;
    /** IN_REVIEW — waiting on a reviewer's sign-off; still open work. */
    inReview: number;
    blocked: number;
    /** Every terminal status (RESOLVED, CLOSED, CANCELED). */
    resolved: number;
    /** Tasks where dueAt is past and status is not terminal */
    overdue: number;
}

/**
 * Vendor summary.
 */
export interface VendorSummary {
    total: number;
    /** Vendors with nextReviewAt in the past */
    overdueReview: number;
}

/**
 * Asset summary — the counts that back the Assets-page KPI cards.
 * Mirrors the KPI tiles: Total / Active / High/Critical / Retired.
 */
export interface AssetSummary {
    /** Non-deleted assets. */
    total: number;
    /** status = ACTIVE. */
    active: number;
    /** criticality IN (HIGH, CRITICAL). */
    highCriticality: number;
    /** status = RETIRED. */
    retired: number;
}

/**
 * Audit-cycle summary — the counts that back the swappable "Audits"
 * KPI card + its status pie. Excludes soft-deleted cycles.
 */
export interface AuditSummary {
    total: number;
    planning: number;
    inProgress: number;
    ready: number;
    complete: number;
}

/**
 * Control-test-run summary — backs the swappable "Tests" KPI card +
 * its pass/fail pie. `pending` counts runs with no recorded result yet
 * (status PLANNED/RUNNING); `total` is every run.
 */
export interface TestSummary {
    total: number;
    pass: number;
    fail: number;
    inconclusive: number;
    pending: number;
}

/**
 * Epic G-5 — control exception inventory + expiry-soon counts for
 * the dashboard. Surfaces the same data the operator wants to act
 * on: how many exceptions are live + how many cross the 30-day line
 * in the next month.
 */
export interface ExceptionSummary {
    /** Approved exceptions with no expiry date yet, or with an
     *  expiry in the future. */
    activeApproved: number;
    /** REQUESTED rows still awaiting an approver action. */
    pendingRequest: number;
    /** Approved exceptions whose expiry is within the next 30 days. */
    expiringWithin30: number;
    /** Approved exceptions whose expiry is within the next 7 days
     *  (subset of the 30-day count — operators want the urgent slice). */
    expiringWithin7: number;
    /** Already-EXPIRED rows that haven't been renewed or cleaned up. */
    expired: number;
}

/**
 * Epic G-7 — risk treatment plan inventory + overdue counts for the
 * dashboard. Five COUNTs against the `(tenantId, status)` and
 * `(tenantId, targetDate)` indexes from prompt 1.
 */
export interface TreatmentPlanSummary {
    /** DRAFT or ACTIVE plans whose targetDate is still in the future. */
    activeOnTrack: number;
    /** Plans whose targetDate has elapsed but status isn't COMPLETED. */
    overdue: number;
    /** Approved plans with targetDate within the next 30 days. */
    dueWithin30: number;
    /** Subset of dueWithin30 — within next 7 days. */
    dueWithin7: number;
    /** COMPLETED plans (audit-trail visibility). */
    completed: number;
}

/**
 * Complete executive dashboard payload.
 * Returned as a single aggregated response to minimize round trips.
 */
export interface ExecutiveDashboardPayload {
    stats: DashboardStats;
    controlCoverage: ControlCoverage;
    riskBySeverity: RiskBySeverity;
    riskByStatus: RiskByStatus;
    evidenceExpiry: EvidenceExpiry;
    policySummary: PolicySummary;
    taskSummary: TaskSummary;
    vendorSummary: VendorSummary;
    /** ISO 8601 timestamp of when the payload was computed */
    computedAt: string;
}

/**
 * A recent-activity row enriched with the changed entity's identity.
 * `title` is the resolved name of the entity the audit row points at
 * (null when the entity type has no title resolver or the row was
 * since deleted). The UI humanises `action`/`entity` and links via
 * `entity` + `entityId`.
 */
export interface RecentActivityEntry {
    id: string;
    createdAt: Date;
    actorName: string | null;
    action: string;
    entity: string;
    entityId: string;
    title: string | null;
}

/**
 * Per-entity-type title resolvers for the recent-activity feed.
 *
 * The `entity` column is written by every `logEvent` caller with
 * inconsistent casing (`'Risk'`, `'RISK'`, …) — callers pass a raw
 * `entityType` string. `normalizeActivityEntity` collapses that to a
 * canonical UPPERCASE key; the resolvers below turn a batch of ids
 * for one type into `{ id, title }` rows via a SINGLE `findMany`
 * (`id IN (...)`). The fan-out in `getRecentActivityDetailed` is one
 * query per DISTINCT type present in the 10 rows — bounded, never
 * per-row, so it is not an N+1.
 */
type TitleRow = { id: string; title: string | null };
type TitleResolver = (db: PrismaTx, ids: string[]) => Promise<TitleRow[]>;

// Each resolver is bounded twice over — by the `id: { in: ids }` filter
// AND an explicit `take: ids.length` — because `ids` is derived from the
// 10-row recent-activity window (≤ 10 distinct ids per type). The `take:`
// keeps each query off the unbounded-findMany budget.
const ACTIVITY_TITLE_RESOLVERS: Record<string, TitleResolver> = {
    RISK: (db, ids) =>
        db.risk.findMany({ where: { id: { in: ids } }, select: { id: true, title: true }, take: ids.length }),
    CONTROL: (db, ids) =>
        db.control
            .findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, take: ids.length })
            .then((rows) => rows.map((r) => ({ id: r.id, title: r.name }))),
    POLICY: (db, ids) =>
        db.policy.findMany({ where: { id: { in: ids } }, select: { id: true, title: true }, take: ids.length }),
    EVIDENCE: (db, ids) =>
        db.evidence.findMany({ where: { id: { in: ids } }, select: { id: true, title: true }, take: ids.length }),
    TASK: (db, ids) =>
        db.task.findMany({ where: { id: { in: ids } }, select: { id: true, title: true }, take: ids.length }),
    // Issues are the same `Task` rows surfaced under the issue lens
    // (TaskRepository) — resolve their title from `task`.
    ISSUE: (db, ids) =>
        db.task.findMany({ where: { id: { in: ids } }, select: { id: true, title: true }, take: ids.length }),
    FINDING: (db, ids) =>
        db.finding.findMany({ where: { id: { in: ids } }, select: { id: true, title: true }, take: ids.length }),
    VENDOR: (db, ids) =>
        db.vendor
            .findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, take: ids.length })
            .then((rows) => rows.map((r) => ({ id: r.id, title: r.name }))),
    ASSET: (db, ids) =>
        db.asset
            .findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, take: ids.length })
            .then((rows) => rows.map((r) => ({ id: r.id, title: r.name }))),
    INCIDENT: (db, ids) =>
        db.incident.findMany({ where: { id: { in: ids } }, select: { id: true, title: true }, take: ids.length }),
};

// ─── Repository ────────────────────────────────────────────────────

export class DashboardRepository {
    /**
     * Headline stats — the counts every reader (executive dashboard +
     * assistant read-path) actually consumes.
     *
     * Uses parallel Prisma.count() calls which each translate to a single
     * `SELECT COUNT(*)` with indexed WHERE clauses: 8 parallel counts, all
     * on existing indexes. The former `asset.count` / `clauseProgress.findMany`
     * / `notification.count` reads were dropped — nothing rendered the
     * `assets` / `clausesReady` / `totalClauses` / `unreadNotifications`
     * fields they backed.
     */
    static async getStats(db: PrismaTx, ctx: RequestContext): Promise<DashboardStats> {
        const tenantId = ctx.tenantId;

        const [
            riskCount,
            controlCount,
            evidenceCount,
            taskCount,
            findingCount,
            highRisks,
            pendingEvidence,
            overdueEvidence,
        ] = await Promise.all([
            db.risk.count({ where: { tenantId } }),
            db.control.count({ where: { OR: [{ tenantId }, { tenantId: null }] } }),
            db.evidence.count({ where: { tenantId } }),
            db.task.count({ where: { tenantId, status: { notIn: [...TERMINAL_TASK_STATUSES] } } }),
            db.finding.count({ where: { tenantId, status: { not: 'CLOSED' } } }),
            db.risk.count({
                where: {
                    tenantId,
                    deletedAt: null,
                    status: needsTreatmentRiskStatusFilter(),
                    inherentScore: { gte: HIGH_RISK_SCORE_MIN },
                },
            }),
            db.evidence.count({ where: { tenantId, status: 'SUBMITTED' } }),
            db.evidence.count({
                where: { tenantId, nextReviewDate: { lt: new Date() }, status: { not: 'APPROVED' } },
            }),
        ]);

        return {
            risks: riskCount,
            controls: controlCount,
            evidence: evidenceCount,
            openTasks: taskCount,
            openFindings: findingCount,
            highRisks,
            pendingEvidence,
            overdueEvidence,
        };
    }

    /**
     * Control coverage — the executive KPI.
     *
     * Coverage % = (IMPLEMENTED controls / applicable controls) × 100
     *
     * Uses groupBy aggregation to count all statuses in a single query.
     * Controls with applicability NOT_APPLICABLE are excluded.
     * Soft-deleted controls are excluded.
     *
     * Query: 1 groupBy (single DB round trip)
     */
    static async getControlCoverage(db: PrismaTx, ctx: RequestContext): Promise<ControlCoverage> {
        const tenantId = ctx.tenantId;

        // Group applicable, non-deleted controls by status
        const groups = await db.control.groupBy({
            by: ['status'],
            where: {
                OR: [{ tenantId }, { tenantId: null }],
                applicability: 'APPLICABLE',
                deletedAt: null,
            },
            _count: true,
        });

        const statusCounts: Record<string, number> = {};
        let applicable = 0;
        for (const g of groups) {
            statusCounts[g.status] = g._count;
            applicable += g._count;
        }

        const implemented = statusCounts['IMPLEMENTED'] ?? 0;
        const inProgress = (statusCounts['IN_PROGRESS'] ?? 0) + (statusCounts['IMPLEMENTING'] ?? 0);
        const notStarted = statusCounts['NOT_STARTED'] ?? 0;
        const planned = statusCounts['PLANNED'] ?? 0;
        const needsReview = statusCounts['NEEDS_REVIEW'] ?? 0;

        // Total including not-applicable (for reference)
        const total = await db.control.count({
            where: {
                OR: [{ tenantId }, { tenantId: null }],
                deletedAt: null,
            },
        });

        // `coveragePercent` is a CONTRACT: always a finite number in
        // [0, 100], one decimal place. Every consumer (the dashboard KPI
        // tile, the masthead hero, the daily snapshot's basis-point
        // column, the digest email's `.toFixed(1)`) formats it without
        // re-checking, so a `NaN` leaking out of here does not surface as
        // an error — it surfaces as a mangled number on the page. The
        // zero-denominator branch is the only way to divide by zero today;
        // `finitePercent` makes the invariant total rather than
        // situational, so a future numerator/denominator change cannot
        // reintroduce the failure silently.
        const coveragePercent = finitePercent(implemented, applicable);

        return {
            total,
            applicable,
            implemented,
            inProgress,
            notStarted,
            planned,
            needsReview,
            coveragePercent,
        };
    }

    /**
     * Counts by severity tier of the risks still needing treatment.
     *
     * Severity tiers are derived from inherentScore (1–25):
     *   - Low: 1–4
     *   - Medium: 5–9
     *   - High: 10–14
     *   - Critical: 15–25
     *
     * Only OPEN and MITIGATING risks are in a tier. Closed and accepted risks
     * left in #4496 (owner decision, 2026-10-29), and mitigated ones leave
     * too (owner decision, 2026-10-30): their treatment is done, so a
     * mitigated critical risk no longer holds the next-step card on "review
     * high-severity risks" or pulls down the posture radar's Risk axis. The
     * daily snapshot's `risksLow`..`risksHigh` are written from this; its
     * `risksCritical` is `countCriticalRisks`, which follows the workspace's
     * own risk matrix (#4846).
     *
     * Uses 4 parallel count queries with range filters on an indexed column.
     */
    static async getRiskBySeverity(db: PrismaTx, ctx: RequestContext): Promise<RiskBySeverity> {
        const tenantId = ctx.tenantId;
        const base = { tenantId, deletedAt: null, status: needsTreatmentRiskStatusFilter() };

        const [low, medium, high, critical] = await Promise.all([
            db.risk.count({ where: { ...base, inherentScore: { gte: 1, lte: 4 } } }),
            db.risk.count({ where: { ...base, inherentScore: { gte: 5, lte: 9 } } }),
            db.risk.count({ where: { ...base, inherentScore: { gte: 10, lte: 14 } } }),
            db.risk.count({ where: { ...base, inherentScore: { gte: 15, lte: 25 } } }),
        ]);

        return { low, medium, high, critical };
    }

    /**
     * The lowest inherent score of this workspace's HIGHEST severity band
     * (#4846), from its risk-matrix configuration, or the default grid's 15
     * when it has none. See `criticalScoreFloor`.
     */
    static async criticalScoreFloor(db: PrismaTx, tenantId: string): Promise<number> {
        const config = await db.riskMatrixConfig.findUnique({
            where: { tenantId },
            select: { bands: true },
        });
        return criticalScoreFloor(config?.bands ?? null);
    }

    /**
     * Risks still needing treatment (OPEN or MITIGATING) whose score is in
     * the workspace's highest severity band: what the organization portfolio
     * calls critical (#4846, owner decision 2026-11-01). The daily snapshot's
     * `risksCritical` is written from this, so the portfolio's figure and its
     * Critical Risks list (`listCriticalRisksAcrossOrg`) count the same risks.
     */
    static async countCriticalRisks(db: PrismaTx, ctx: RequestContext): Promise<number> {
        const floor = await DashboardRepository.criticalScoreFloor(db, ctx.tenantId);
        return db.risk.count({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                status: needsTreatmentRiskStatusFilter(),
                inherentScore: { gte: floor },
            },
        });
    }

    /**
     * Risk counts by status.
     *
     * Query: 1 groupBy
     */
    static async getRiskByStatus(db: PrismaTx, ctx: RequestContext): Promise<RiskByStatus> {
        const groups = await db.risk.groupBy({
            by: ['status'],
            where: { tenantId: ctx.tenantId, deletedAt: null },
            _count: true,
        });

        const counts: Record<string, number> = {};
        for (const g of groups) {
            counts[g.status] = g._count;
        }

        return {
            open: counts['OPEN'] ?? 0,
            mitigating: counts['MITIGATING'] ?? 0,
            accepted: counts['ACCEPTED'] ?? 0,
            closed: counts['CLOSED'] ?? 0,
        };
    }

    /**
     * Evidence expiry/freshness summary.
     *
     * Computes:
     * - overdue: nextReviewDate < now AND status ≠ APPROVED
     * - dueSoon7d: nextReviewDate within 7 days
     * - dueSoon30d: nextReviewDate within 30 days (includes dueSoon7d)
     * - noReviewDate: nextReviewDate is null
     * - current: APPROVED and not overdue
     *
     * Uses 5 parallel count queries on indexed columns.
     */
    static async getEvidenceExpiry(db: PrismaTx, ctx: RequestContext): Promise<EvidenceExpiry> {
        const tenantId = ctx.tenantId;
        const now = new Date();
        const { in7d, in30d } = evidenceReviewWindows(now);
        // Shared expiry scope — the same predicate the compliance calendar
        // uses, so both agree on which evidence rows exist at all.
        // See app-layer/domain/evidence-expiry.
        const base = evidenceExpiryScopeWhere(tenantId);

        const [overdue, dueSoon7d, dueSoon30d, noReviewDate, current] = await Promise.all([
            // Overdue: review date is past and not approved
            db.evidence.count({
                where: {
                    ...base,
                    nextReviewDate: { lt: now },
                    status: EVIDENCE_OUTSTANDING_STATUS_FILTER,
                },
            }),
            // Due within 7 days (not yet past)
            db.evidence.count({
                where: { ...base, nextReviewDate: { gte: now, lte: in7d } },
            }),
            // Due within 30 days (not yet past)
            db.evidence.count({
                where: { ...base, nextReviewDate: { gte: now, lte: in30d } },
            }),
            // No review date set
            db.evidence.count({
                where: { ...base, nextReviewDate: null },
            }),
            // Current: approved and review date not passed (or no review date)
            db.evidence.count({
                where: {
                    ...base,
                    status: EVIDENCE_REVIEWED_STATUS,
                    OR: [
                        { nextReviewDate: null },
                        { nextReviewDate: { gte: now } },
                    ],
                },
            }),
        ]);

        return { overdue, dueSoon7d, dueSoon30d, noReviewDate, current };
    }

    /**
     * Evidence review timeliness as four DISJOINT buckets — see
     * `EvidenceReviewBreakdown`. Backs the dashboard's "Evidence status"
     * custom metric, whose headline is the sum of the four.
     *
     * Uses 4 parallel count queries on the same scope and clock as
     * `getEvidenceExpiry`.
     */
    static async getEvidenceReviewBreakdown(
        db: PrismaTx,
        ctx: RequestContext,
    ): Promise<EvidenceReviewBreakdown> {
        const now = new Date();
        const { in7d, in30d } = evidenceReviewWindows(now);
        const base = evidenceExpiryScopeWhere(ctx.tenantId);

        const [overdue, dueWithin7d, due8to30d, current] = await Promise.all([
            db.evidence.count({
                where: {
                    ...base,
                    nextReviewDate: { lt: now },
                    status: EVIDENCE_OUTSTANDING_STATUS_FILTER,
                },
            }),
            db.evidence.count({
                where: { ...base, nextReviewDate: { gte: now, lte: in7d } },
            }),
            db.evidence.count({
                where: { ...base, nextReviewDate: { gt: in7d, lte: in30d } },
            }),
            db.evidence.count({
                where: {
                    ...base,
                    status: EVIDENCE_REVIEWED_STATUS,
                    OR: [{ nextReviewDate: null }, { nextReviewDate: { gt: in30d } }],
                },
            }),
        ]);

        return { overdue, dueWithin7d, due8to30d, current };
    }

    /**
     * Policy status summary.
     *
     * Query: 1 groupBy + 1 count
     */
    static async getPolicySummary(db: PrismaTx, ctx: RequestContext): Promise<PolicySummary> {
        const tenantId = ctx.tenantId;

        const [groups, overdueReview] = await Promise.all([
            db.policy.groupBy({
                by: ['status'],
                where: { tenantId, deletedAt: null },
                _count: true,
            }),
            db.policy.count({
                where: { tenantId, deletedAt: null, nextReviewAt: { lt: new Date() } },
            }),
        ]);

        const counts: Record<string, number> = {};
        let total = 0;
        for (const g of groups) {
            counts[g.status] = g._count;
            total += g._count;
        }

        return {
            total,
            draft: counts['DRAFT'] ?? 0,
            inReview: counts['IN_REVIEW'] ?? 0,
            approved: counts['APPROVED'] ?? 0,
            published: counts['PUBLISHED'] ?? 0,
            archived: counts['ARCHIVED'] ?? 0,
            overdueReview,
        };
    }

    /**
     * Task summary for executive view.
     *
     * Query: 1 groupBy + 1 overdue count
     */
    static async getTaskSummary(db: PrismaTx, ctx: RequestContext): Promise<TaskSummary> {
        const tenantId = ctx.tenantId;

        const [groups, overdue] = await Promise.all([
            db.task.groupBy({
                by: ['status'],
                where: { tenantId, deletedAt: null },
                _count: true,
            }),
            db.task.count({
                where: {
                    tenantId,
                    deletedAt: null,
                    dueAt: { lt: new Date() },
                    status: { notIn: [...TERMINAL_TASK_STATUSES] },
                },
            }),
        ]);

        const counts: Record<string, number> = {};
        let total = 0;
        for (const g of groups) {
            counts[g.status] = g._count;
            total += g._count;
        }

        return {
            total,
            open: (counts['OPEN'] ?? 0) + (counts['TRIAGED'] ?? 0),
            inProgress: counts['IN_PROGRESS'] ?? 0,
            inReview: counts['IN_REVIEW'] ?? 0,
            blocked: counts['BLOCKED'] ?? 0,
            // Sum all terminal statuses using the shared constant
            resolved: TERMINAL_TASK_STATUSES.reduce(
                (sum, s) => sum + (counts[s] ?? 0), 0
            ),
            overdue,
        };
    }

    /**
     * Vendor summary.
     *
     * Query: 1 count + 1 overdue count
     */
    static async getVendorSummary(db: PrismaTx, ctx: RequestContext): Promise<VendorSummary> {
        const tenantId = ctx.tenantId;

        const [total, overdueReview] = await Promise.all([
            db.vendor.count({ where: { tenantId, deletedAt: null } }),
            db.vendor.count({
                where: { tenantId, deletedAt: null, nextReviewAt: { lt: new Date() } },
            }),
        ]);

        return { total, overdueReview };
    }

    /**
     * Asset KPI counts for the daily snapshot + the Assets-page cards.
     * All counts exclude soft-deleted rows (`deletedAt: null`), so the
     * snapshot series mirrors what the live Assets table shows.
     */
    static async getAssetSummary(db: PrismaTx, ctx: RequestContext): Promise<AssetSummary> {
        const tenantId = ctx.tenantId;

        const [total, active, highCriticality, retired] = await Promise.all([
            db.asset.count({ where: { tenantId, deletedAt: null } }),
            db.asset.count({ where: { tenantId, deletedAt: null, status: 'ACTIVE' } }),
            db.asset.count({ where: { tenantId, deletedAt: null, criticality: { in: ['HIGH', 'CRITICAL'] } } }),
            db.asset.count({ where: { tenantId, deletedAt: null, status: 'RETIRED' } }),
        ]);

        return { total, active, highCriticality, retired };
    }

    /**
     * Audit-cycle status counts for the swappable "Audits" KPI card.
     * One `groupBy` over the `(tenantId, deletedAt)` index; excludes
     * soft-deleted cycles so the pie mirrors the live Audits view.
     */
    static async getAuditSummary(db: PrismaTx, ctx: RequestContext): Promise<AuditSummary> {
        const grouped = await db.auditCycle.groupBy({
            by: ['status'],
            where: { tenantId: ctx.tenantId, deletedAt: null },
            _count: { _all: true },
        });
        const by = (s: string) =>
            grouped.find((g) => g.status === s)?._count._all ?? 0;
        const planning = by('PLANNING');
        const inProgress = by('IN_PROGRESS');
        const ready = by('READY');
        const complete = by('COMPLETE');
        return {
            total: planning + inProgress + ready + complete,
            planning,
            inProgress,
            ready,
            complete,
        };
    }

    /**
     * Control-test-run result counts for the swappable "Tests" KPI
     * card. One `groupBy` over the `(tenantId, result)` index; a null
     * result (run not yet resolved) is folded into `pending`.
     */
    static async getTestSummary(db: PrismaTx, ctx: RequestContext): Promise<TestSummary> {
        const grouped = await db.controlTestRun.groupBy({
            by: ['result'],
            where: { tenantId: ctx.tenantId },
            _count: { _all: true },
        });
        const by = (r: string | null) =>
            grouped.find((g) => g.result === r)?._count._all ?? 0;
        const pass = by('PASS');
        const fail = by('FAIL');
        const inconclusive = by('INCONCLUSIVE');
        const pending = by(null);
        return {
            total: pass + fail + inconclusive + pending,
            pass,
            fail,
            inconclusive,
            pending,
        };
    }

    /**
     * Recent audit log activity.
     *
     * Query: 1 findMany with take limit
     */
    static async getRecentActivity(db: PrismaTx, ctx: RequestContext) {
        return db.auditLog.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            take: 10,
            include: { user: { select: { name: true } } },
        });
    }

    /**
     * Recent activity enriched with the changed entity's identity —
     * the feed the dashboard renders (humanised, identified, linked).
     *
     * Resolves each row's entity title through a bounded fan-out: the
     * 10 rows are grouped by entity type, then ONE `findMany` per
     * distinct type (`ACTIVITY_TITLE_RESOLVERS`) hydrates the titles.
     * Unknown entity types (no resolver) keep `title: null` and the
     * UI renders them without a link.
     */
    static async getRecentActivityDetailed(
        db: PrismaTx,
        ctx: RequestContext,
    ): Promise<RecentActivityEntry[]> {
        const logs = await db.auditLog.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: {
                id: true,
                createdAt: true,
                action: true,
                entity: true,
                entityId: true,
                user: { select: { name: true } },
            },
        });

        // Group ids by canonical entity type so each type is a single
        // `id IN (...)` seek — never a per-row query.
        const idsByType = new Map<string, Set<string>>();
        for (const log of logs) {
            if (!log.entityId) continue;
            const key = normalizeActivityEntity(log.entity);
            if (!ACTIVITY_TITLE_RESOLVERS[key]) continue;
            (idsByType.get(key) ?? idsByType.set(key, new Set()).get(key)!).add(log.entityId);
        }

        const titleByKey = new Map<string, string>(); // `${type}:${id}` → title
        await Promise.all(
            [...idsByType.entries()].map(async ([type, ids]) => {
                const rows = await ACTIVITY_TITLE_RESOLVERS[type](db, [...ids]);
                for (const r of rows) {
                    if (r.title) titleByKey.set(`${type}:${r.id}`, r.title);
                }
            }),
        );

        return logs.map((log) => {
            const key = normalizeActivityEntity(log.entity);
            return {
                id: log.id,
                createdAt: log.createdAt,
                actorName: log.user?.name ?? null,
                action: log.action,
                entity: log.entity,
                entityId: log.entityId,
                title: log.entityId ? titleByKey.get(`${key}:${log.entityId}`) ?? null : null,
            };
        });
    }

    /**
     * Epic G-5 — exception inventory + expiry-soon counts for the
     * dashboard card. Five parallel COUNTs against the
     * `(tenantId, status)` and `(tenantId, expiresAt)` indexes.
     */
    static async getExceptionSummary(
        db: PrismaTx,
        ctx: RequestContext,
    ): Promise<ExceptionSummary> {
        const tenantId = ctx.tenantId;
        const now = new Date();
        const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        const [
            activeApproved,
            pendingRequest,
            expiringWithin30,
            expiringWithin7,
            expired,
        ] = await Promise.all([
            db.controlException.count({
                where: {
                    tenantId,
                    status: 'APPROVED',
                    deletedAt: null,
                    OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
                },
            }),
            db.controlException.count({
                where: { tenantId, status: 'REQUESTED', deletedAt: null },
            }),
            db.controlException.count({
                where: {
                    tenantId,
                    status: 'APPROVED',
                    deletedAt: null,
                    expiresAt: { not: null, gte: now, lte: in30 },
                },
            }),
            db.controlException.count({
                where: {
                    tenantId,
                    status: 'APPROVED',
                    deletedAt: null,
                    expiresAt: { not: null, gte: now, lte: in7 },
                },
            }),
            db.controlException.count({
                where: { tenantId, status: 'EXPIRED', deletedAt: null },
            }),
        ]);

        return {
            activeApproved,
            pendingRequest,
            expiringWithin30,
            expiringWithin7,
            expired,
        };
    }

    /**
     * Epic G-7 — risk treatment plan inventory + overdue counts for
     * the dashboard card. Five parallel COUNTs against the
     * `(tenantId, status)` + `(tenantId, targetDate)` indexes.
     */
    static async getTreatmentPlanSummary(
        db: PrismaTx,
        ctx: RequestContext,
    ): Promise<TreatmentPlanSummary> {
        const tenantId = ctx.tenantId;
        const now = new Date();
        const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        const [
            activeOnTrack,
            overdue,
            dueWithin30,
            dueWithin7,
            completed,
        ] = await Promise.all([
            db.riskTreatmentPlan.count({
                where: {
                    tenantId,
                    deletedAt: null,
                    status: { in: ['DRAFT', 'ACTIVE'] },
                    targetDate: { gte: now },
                },
            }),
            db.riskTreatmentPlan.count({
                where: {
                    tenantId,
                    deletedAt: null,
                    status: { in: ['DRAFT', 'ACTIVE', 'OVERDUE'] },
                    targetDate: { lt: now },
                },
            }),
            db.riskTreatmentPlan.count({
                where: {
                    tenantId,
                    deletedAt: null,
                    status: { in: ['DRAFT', 'ACTIVE'] },
                    targetDate: { gte: now, lte: in30 },
                },
            }),
            db.riskTreatmentPlan.count({
                where: {
                    tenantId,
                    deletedAt: null,
                    status: { in: ['DRAFT', 'ACTIVE'] },
                    targetDate: { gte: now, lte: in7 },
                },
            }),
            db.riskTreatmentPlan.count({
                where: { tenantId, deletedAt: null, status: 'COMPLETED' },
            }),
        ]);
        return {
            activeOnTrack,
            overdue,
            dueWithin30,
            dueWithin7,
            completed,
        };
    }
}
