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

// ─── The ladder ──────────────────────────────────────────────────────
//
// Five rungs, one shared scale. Every axis is already a "share of the
// estate that is healthy" percentage, so ONE table of numbers can rate
// all six — and the reader can check any rating by hand from the counts
// on the page.
//
// Why one shared table rather than six bespoke ones: a per-axis ladder
// would make "Controls level 3" and "Evidence level 3" mean different
// amounts of work, and the radar's whole claim is that its six spokes are
// comparable. They are comparable precisely because the rule is the same.
//
// ── The top rung is a statement about DEFECTS, not a percentage ──
//
// Level 5 means everything is perfect: zero overdue, zero severe, nothing
// unimplemented. It cannot be reached by scoring highly, because a
// percentage cannot express "none left" — 249 of 250 healthy is 99.6%,
// which ROUNDS TO 100 and would have promoted an axis with a live overdue
// log to the top of the ladder. That was the reported bug. The rule is
// therefore `measured === total`, evaluated on the counts, and the
// percentage bands below cap at 4 while any defect remains.
//
// The four bands below the top are evenly spaced quarters (50 / 75 / 90)
// rather than the earlier top-heavy 40/60/80/95. Once the top rung is
// reserved for a clean sheet, the bands underneath describe how far off a
// clean sheet the tenant is, and that distance reads better spread out:
// "nine in ten healthy" (4) is a real position, and so is "half" (2).

/**
 * The five rungs, ascending. `min` is the inclusive floor on the 0-100
 * axis score.
 *
 * The level-5 floor of 100 is NECESSARY BUT NOT SUFFICIENT — see the note
 * above. `levelForRating` owns the zero-defect rule; nothing should rate
 * an axis from its score alone.
 */
export const POSTURE_LADDER = [
    { level: 1, key: 'initial', min: 0 },
    { level: 2, key: 'developing', min: 50 },
    { level: 3, key: 'defined', min: 75 },
    { level: 4, key: 'managed', min: 90 },
    { level: 5, key: 'optimising', min: 100 },
] as const;

export type PostureLevel = 1 | 2 | 3 | 4 | 5;

/**
 * Frame height for the hero's radar.
 *
 * Sized so the dial is bound by the column's WIDTH rather than its
 * height: in a 340px column the frame's inner SVG is 308px wide, the
 * label margin is 55px, so the dial wants a 99px radius — which needs
 * ~254px of SVG height, plus the frame's 32px of padding.
 *
 * Any smaller and the dial shrinks; any larger and the extra height is
 * spent on nothing, pushing the per-component metrics away from the
 * chart they belong to.
 */
export const POSTURE_RADAR_FRAME_HEIGHT = 288;
export type PostureLevelKey = (typeof POSTURE_LADDER)[number]['key'];

/**
 * The rung an axis sits on, or `null` when the axis has no estate to
 * rate.
 *
 * `null` rather than a default level: a tenant with no vendors is neither
 * good nor bad at vendors, and 0/0 is not a perfect score. Scoring it 5
 * would put a fabricated "Optimising" on the page and let an axis the
 * tenant does not use hold up — or hold down — the headline.
 */
export function levelForRating(input: {
    value: number;
    measured: number;
    total: number;
}): PostureLevel | null {
    if (input.total <= 0) return null;
    // The ONLY route to the top rung: nothing left to fix.
    if (input.measured >= input.total) return 5;
    // A defect exists, so the score cannot promote past 4 however it
    // rounds.
    let level: PostureLevel = 1;
    for (const rung of POSTURE_LADDER) {
        if (rung.level === 5) continue;
        if (input.value >= rung.min) level = rung.level;
    }
    return level;
}

/** The rung's key ('defined', …) — the i18n lookup for its name. */
export function levelKey(level: PostureLevel): PostureLevelKey {
    return (POSTURE_LADDER.find((r) => r.level === level) ?? POSTURE_LADDER[0]).key;
}

/**
 * One axis, rated.
 *
 * `measured` / `total` are the raw counts the score came from — the whole
 * point of "exact metrics" is that the reader can divide them and get the
 * percentage back, and that the top rung can be verified as "these two
 * numbers are equal". `level === null` means the axis has no estate
 * behind it.
 */
export interface PostureAxisRating {
    key: PostureRadarAxis;
    label: string;
    /** 0-100, higher is better. */
    value: number;
    level: PostureLevel | null;
    /** Numerator: the part of the estate that is healthy. */
    measured: number;
    /** Denominator: the part of the estate this axis rates at all. */
    total: number;
}

/**
 * The tenant's overall rung: **the weakest rated axis**, not the average.
 *
 * A mean would let five strong axes hide one that is failing, which is
 * exactly the reading a posture headline must not support — and it would
 * also make the headline unexplainable from the chart, because no feature
 * of the polygon corresponds to a mean. The weakest-link rule makes the
 * chart self-explaining: the shortest spoke IS the headline, and naming
 * it (`limitedBy`) turns the number into an instruction.
 *
 * Weakest is by LEVEL first, then by score. Ordering by score alone can
 * pick an axis whose 99.6% rounds to 100 over one genuinely on 96% —
 * both are level 4, but the headline must name the one that actually
 * holds the level down.
 *
 * Unrated axes (`level === null`) are skipped: rating a tenant on
 * something it does not do is worse than saying nothing.
 */
export function overallLevel(ratings: readonly PostureAxisRating[]): {
    level: PostureLevel;
    limitedBy: PostureAxisRating | null;
} {
    const rated = ratings.filter(
        (r): r is PostureAxisRating & { level: PostureLevel } => r.level !== null,
    );
    if (rated.length === 0) return { level: 1, limitedBy: null };
    let weakest = rated[0];
    for (const r of rated) {
        if (r.level < weakest.level || (r.level === weakest.level && r.value < weakest.value)) {
            weakest = r;
        }
    }
    return { level: weakest.level, limitedBy: weakest };
}

/**
 * Rate the six axes from the same executive payload the posture
 * narrative is generated from.
 *
 * Each axis carries its raw `measured / total` counts alongside the
 * score, so every rating on the page can be checked by hand: the score
 * is `measured / total`, and the level is that score read off
 * `POSTURE_LADDER`. Nothing in the hero is a number the reader cannot
 * reconstruct.
 *
 * `label` resolves the axis copy (i18n) — the caller passes a translator
 * so this module stays pure and testable.
 */
export function ratePostureAxes(
    exec: ExecutiveDashboardPayload,
    label: (axis: PostureRadarAxis) => string,
): PostureAxisRating[] {
    const { controlCoverage, evidenceExpiry, riskBySeverity, policySummary, taskSummary, vendorSummary } = exec;

    // Evidence freshness — the share of review-tracked evidence that is
    // NOT overdue.
    //
    // Only the two disjoint buckets are used. `noReviewDate` rows are
    // excluded from both sides: evidence nobody scheduled a review for is
    // neither fresh nor stale, and counting it either way would move the
    // axis for a decision the tenant hasn't made. `dueSoon30d` is excluded
    // because it OVERLAPS `current` (an approved item due in three weeks is
    // in both), and a denominator that double-counts cannot be checked by
    // dividing the two numbers on the page.
    const evidenceTracked = evidenceExpiry.current + evidenceExpiry.overdue;

    // Risk posture — the share of open risks NOT in the top two severity
    // bands. Counting every risk equally would let a hundred low risks
    // mask four critical ones, which is the opposite of what the hero says.
    const riskTotal =
        riskBySeverity.low + riskBySeverity.medium + riskBySeverity.high + riskBySeverity.critical;
    const riskSevere = riskBySeverity.high + riskBySeverity.critical;

    // measured = the healthy part, total = the part this axis rates.
    const counts: Record<PostureRadarAxis, { measured: number; total: number }> = {
        controls: {
            measured: controlCoverage.implemented,
            total: controlCoverage.applicable,
        },
        evidence: { measured: evidenceExpiry.current, total: evidenceTracked },
        risk: { measured: riskTotal - riskSevere, total: riskTotal },
        policies: {
            measured: policySummary.total - policySummary.overdueReview,
            total: policySummary.total,
        },
        tasks: { measured: taskSummary.total - taskSummary.overdue, total: taskSummary.total },
        vendors: {
            measured: vendorSummary.total - vendorSummary.overdueReview,
            total: vendorSummary.total,
        },
    };

    // The control axis takes its percentage from the payload rather than
    // re-dividing: `coveragePercent` is rounded to one decimal upstream and
    // is the number the Controls KPI card shows. Recomputing here would put
    // two slightly different coverage figures on one screen.
    const values: Record<PostureRadarAxis, number> = {
        controls: pct(controlCoverage.coveragePercent),
        evidence: healthyShare(evidenceExpiry.overdue, evidenceTracked),
        risk: healthyShare(riskSevere, riskTotal),
        policies: healthyShare(policySummary.overdueReview, policySummary.total),
        tasks: healthyShare(taskSummary.overdue, taskSummary.total),
        vendors: healthyShare(vendorSummary.overdueReview, vendorSummary.total),
    };

    return POSTURE_RADAR_AXES.map((axis) => ({
        key: axis,
        label: label(axis),
        value: values[axis],
        measured: counts[axis].measured,
        total: counts[axis].total,
        level: levelForRating({
            value: values[axis],
            measured: counts[axis].measured,
            total: counts[axis].total,
        }),
    }));
}

/** The chart's view of the ratings — `<RadarChart>` wants only these three. */
export function toRadarAxes(ratings: readonly PostureAxisRating[]): RadarAxisDatum[] {
    return ratings.map((r) => ({ key: r.key, label: r.label, value: r.value }));
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
        riskBySeverity.low +
        riskBySeverity.medium +
        riskBySeverity.high +
        riskBySeverity.critical +
        policySummary.total +
        taskSummary.total +
        vendorSummary.total;
    return estate > 0;
}
