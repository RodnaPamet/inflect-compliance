/**
 * Posture radar — the dashboard hero's six-axis profile.
 *
 * The hero headline is an AI narrative over `gatherPostureSignals`, which
 * is itself assembled from `getExecutiveDashboard`: control coverage,
 * risk severities, evidence freshness, and the open/overdue counts for
 * findings, tasks, policies and vendors. The narrative compresses all of
 * that into one word ("Developing") and one number (a maturity score).
 *
 * The radar re-expands it. Same inputs, same tenant, same moment — so the
 * shape of the polygon explains the word beside it: a tenant reading
 * "Developing" can see WHICH axis is pulling the score down instead of
 * inferring it from the advice list.
 *
 * Every axis is normalised to 0–100 where **higher is better**, because a
 * radar is read as area: "bigger polygon = healthier" only holds if no
 * axis is inverted. Three of the six sources are natively "bad counts"
 * (overdue policies, overdue tasks, high-severity risks), so they are
 * expressed as the share that is NOT in trouble.
 *
 * An axis with no denominator (no policies at all, no vendors yet) scores
 * 100 rather than 0: nothing is overdue when nothing exists, and a fresh
 * tenant should not read as failing on axes it has not started using. The
 * empty-tenant case is handled one level up — `isPostureRadarMeaningful`
 * returns false when the tenant has no compliance estate at all, and the
 * hero renders the chart's empty state instead of a perfect hexagon.
 */
import type { ExecutiveDashboardPayload } from '@/app-layer/repositories/DashboardRepository';
import type { RadarAxisDatum } from '@/components/ui/charts';

/** The six axes, in render order (clockwise from the top of the radar). */
export const POSTURE_RADAR_AXES = [
    'controls',
    'evidence',
    'risk',
    'policies',
    'tasks',
    'vendors',
] as const;

export type PostureRadarAxis = (typeof POSTURE_RADAR_AXES)[number];

/** Clamp to the 0–100 the radar's `maxValue` expects. */
function pct(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * "Share that is fine" — `1 - bad/total`, as a percentage.
 *
 * `total === 0` scores 100 (see the module note): a tenant with no
 * policies has no overdue policies.
 */
function healthyShare(bad: number, total: number): number {
    if (total <= 0) return 100;
    return pct(((total - bad) / total) * 100);
}

/**
 * Build the six axes from the same executive payload the posture
 * narrative is generated from.
 *
 * `label` resolves the axis copy (i18n) — the caller passes a translator
 * so this module stays pure and testable.
 */
export function buildPostureRadarAxes(
    exec: ExecutiveDashboardPayload,
    label: (axis: PostureRadarAxis) => string,
): RadarAxisDatum[] {
    const { controlCoverage, evidenceExpiry, riskBySeverity, policySummary, taskSummary, vendorSummary } = exec;

    // Evidence freshness — `current` over everything with a review clock.
    // `noReviewDate` rows are excluded from BOTH sides: evidence nobody
    // scheduled a review for is neither fresh nor stale, and counting it
    // as either would move the axis for a decision the tenant hasn't made.
    const evidenceTracked =
        evidenceExpiry.current + evidenceExpiry.overdue + evidenceExpiry.dueSoon30d;

    // Risk posture — the share of open risks NOT in the top two severity
    // bands. Counting every risk equally would let a hundred low risks
    // mask four critical ones, which is the opposite of what the hero says.
    const riskTotal =
        riskBySeverity.low + riskBySeverity.medium + riskBySeverity.high + riskBySeverity.critical;
    const riskSevere = riskBySeverity.high + riskBySeverity.critical;

    const values: Record<PostureRadarAxis, number> = {
        controls: pct(controlCoverage.coveragePercent),
        evidence: evidenceTracked > 0 ? pct((evidenceExpiry.current / evidenceTracked) * 100) : 100,
        risk: healthyShare(riskSevere, riskTotal),
        policies: healthyShare(policySummary.overdueReview, policySummary.total),
        tasks: healthyShare(taskSummary.overdue, taskSummary.total),
        vendors: healthyShare(vendorSummary.overdueReview, vendorSummary.total),
    };

    return POSTURE_RADAR_AXES.map((axis) => ({
        key: axis,
        label: label(axis),
        value: values[axis],
    }));
}

/**
 * Does this tenant have enough of an estate for the radar to mean
 * anything?
 *
 * Without this, a brand-new tenant renders a perfect hexagon — six axes
 * at 100 because nothing is overdue when nothing exists — directly beside
 * a hero that says "At risk". The chart would be lying by construction,
 * so the hero shows the radar's empty state instead.
 */
export function isPostureRadarMeaningful(exec: ExecutiveDashboardPayload): boolean {
    const { controlCoverage, evidenceExpiry, riskBySeverity, policySummary, taskSummary, vendorSummary } = exec;
    const estate =
        controlCoverage.applicable +
        evidenceExpiry.current +
        evidenceExpiry.overdue +
        evidenceExpiry.dueSoon30d +
        riskBySeverity.low +
        riskBySeverity.medium +
        riskBySeverity.high +
        riskBySeverity.critical +
        policySummary.total +
        taskSummary.total +
        vendorSummary.total;
    return estate > 0;
}
