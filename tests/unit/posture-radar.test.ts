/**
 * The dashboard hero's six-axis profile.
 *
 * The invariant worth testing is the DIRECTION of every axis: a radar is
 * read as area, so "bigger polygon = healthier" only holds if no axis is
 * inverted. Three of the six sources are natively bad-counts (overdue
 * policies / tasks, high-severity risks), and getting one of those the
 * wrong way round would produce a chart that looks best when the tenant
 * is worst — a failure no type checks.
 */
import {
    MIN_RADAR_AXES,
    isPostureRadarMeaningful,
    levelForRating,
    levelKey,
    overallLevel,
    POSTURE_RADAR_AXES,
    POSTURE_LADDER,
    rankedByWeakness,
    ratePostureAxes,
    toRadarAxes,
    type PostureAxisRating,
} from '@/lib/charts/posture-radar';
import type { ExecutiveDashboardPayload } from '@/app-layer/repositories/DashboardRepository';

/** A payload with everything at zero — the shape, not a scenario. */
function payload(overrides: Partial<ExecutiveDashboardPayload> = {}): ExecutiveDashboardPayload {
    return {
        stats: {} as ExecutiveDashboardPayload['stats'],
        controlCoverage: {
            total: 0,
            applicable: 0,
            implemented: 0,
            inProgress: 0,
            notStarted: 0,
            planned: 0,
            needsReview: 0,
            coveragePercent: 0,
        },
        riskBySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
        riskByStatus: { open: 0, mitigating: 0, accepted: 0, closed: 0 },
        evidenceExpiry: { overdue: 0, dueSoon7d: 0, dueSoon30d: 0, noReviewDate: 0, current: 0 },
        policySummary: {
            total: 0,
            draft: 0,
            inReview: 0,
            approved: 0,
            published: 0,
            archived: 0,
            overdueReview: 0,
        },
        taskSummary: { total: 0, open: 0, inProgress: 0, blocked: 0, resolved: 0, overdue: 0 },
        vendorSummary: { total: 0, overdueReview: 0 },
        computedAt: '2026-08-01T00:00:00.000Z',
        ...overrides,
    };
}

const label = (axis: string) => axis;
const rate = (exec: ExecutiveDashboardPayload): PostureAxisRating[] =>
    ratePostureAxes(exec, label);
const byKey = (exec: ExecutiveDashboardPayload): Record<string, number> =>
    Object.fromEntries(rate(exec).map((a) => [a.key, a.value]));
const levelsByKey = (exec: ExecutiveDashboardPayload): Record<string, number | null> =>
    Object.fromEntries(rate(exec).map((a) => [a.key, a.level]));

describe('ratePostureAxes', () => {
    it('returns the six axes in a stable order', () => {
        expect(rate(payload()).map((a) => a.key)).toEqual([...POSTURE_RADAR_AXES]);
    });

    it('reads control coverage straight through', () => {
        const v = byKey(
            payload({
                controlCoverage: { ...payload().controlCoverage, applicable: 4, implemented: 2, coveragePercent: 50 },
            }),
        );
        expect(v.controls).toBe(50);
    });

    it('scores evidence on the share that is not overdue', () => {
        const v = byKey(
            payload({
                evidenceExpiry: { overdue: 1, dueSoon7d: 0, dueSoon30d: 1, noReviewDate: 0, current: 3 },
            }),
        );
        // 3 current of 4 tracked. `dueSoon30d` is deliberately absent from
        // both sides — it OVERLAPS `current`, and a denominator that
        // double-counts cannot be checked by dividing the printed numbers.
        expect(v.evidence).toBe(75);
    });

    it('excludes review-less evidence from BOTH sides of the ratio', () => {
        // 50 rows nobody scheduled a review for must not drag the axis to
        // zero — they are neither fresh nor stale.
        const v = byKey(
            payload({
                evidenceExpiry: { overdue: 0, dueSoon7d: 0, dueSoon30d: 0, noReviewDate: 50, current: 3 },
            }),
        );
        expect(v.evidence).toBe(100);
    });

    describe('the three inverted sources point the right way', () => {
        it('risk: MORE high/critical risk scores LOWER', () => {
            const calm = byKey(payload({ riskBySeverity: { low: 8, medium: 2, high: 0, critical: 0 } }));
            const alarming = byKey(payload({ riskBySeverity: { low: 0, medium: 0, high: 5, critical: 5 } }));
            expect(calm.risk).toBe(100);
            expect(alarming.risk).toBe(0);
            expect(calm.risk).toBeGreaterThan(alarming.risk);
        });

        it('policies: MORE overdue reviews scores LOWER', () => {
            const base = payload().policySummary;
            const good = byKey(payload({ policySummary: { ...base, total: 10, overdueReview: 0 } }));
            const bad = byKey(payload({ policySummary: { ...base, total: 10, overdueReview: 10 } }));
            expect(good.policies).toBe(100);
            expect(bad.policies).toBe(0);
        });

        it('tasks: MORE overdue scores LOWER', () => {
            const base = payload().taskSummary;
            const good = byKey(payload({ taskSummary: { ...base, total: 4, overdue: 0 } }));
            const bad = byKey(payload({ taskSummary: { ...base, total: 4, overdue: 3 } }));
            expect(good.tasks).toBe(100);
            expect(bad.tasks).toBe(25);
        });

        it('vendors: MORE overdue reviews scores LOWER', () => {
            const good = byKey(payload({ vendorSummary: { total: 5, overdueReview: 0 } }));
            const bad = byKey(payload({ vendorSummary: { total: 5, overdueReview: 4 } }));
            expect(good.vendors).toBe(100);
            expect(bad.vendors).toBe(20);
        });
    });

    it('scores an empty denominator 100, not 0', () => {
        // Nothing is overdue when nothing exists. The empty-TENANT case is
        // handled by `isPostureRadarMeaningful`, not by scoring zeros.
        const v = byKey(payload());
        expect(v.policies).toBe(100);
        expect(v.tasks).toBe(100);
        expect(v.vendors).toBe(100);
        expect(v.risk).toBe(100);
    });

    it('clamps every axis into 0..100', () => {
        const v = byKey(
            payload({
                controlCoverage: { ...payload().controlCoverage, coveragePercent: 140 },
            }),
        );
        for (const value of Object.values(v)) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(100);
        }
    });

    it('survives a non-finite percent without emitting NaN', () => {
        const v = byKey(
            payload({
                controlCoverage: { ...payload().controlCoverage, coveragePercent: Number.NaN },
            }),
        );
        expect(v.controls).toBe(0);
    });

    it('passes each axis key to the label resolver', () => {
        const axes = ratePostureAxes(payload(), (a) => `label:${a}`);
        expect(axes.map((a) => a.label)).toEqual(POSTURE_RADAR_AXES.map((a) => `label:${a}`));
    });
});

describe('isPostureRadarMeaningful', () => {
    it('is false for a tenant with no estate at all', () => {
        // Otherwise the hero paints a perfect hexagon (six axes at 100 for
        // want of anything to be overdue) beside an "At risk" headline.
        expect(isPostureRadarMeaningful(payload())).toBe(false);
    });

    it.each([
        ['controls', { controlCoverage: { ...payload().controlCoverage, applicable: 1 } }],
        ['evidence', { evidenceExpiry: { ...payload().evidenceExpiry, current: 1 } }],
        ['risks', { riskBySeverity: { low: 1, medium: 0, high: 0, critical: 0 } }],
        ['policies', { policySummary: { ...payload().policySummary, total: 1 } }],
        ['tasks', { taskSummary: { ...payload().taskSummary, total: 1 } }],
        ['vendors', { vendorSummary: { total: 1, overdueReview: 0 } }],
    ])('is true once the tenant has any %s', (_name, overrides) => {
        expect(isPostureRadarMeaningful(payload(overrides as Partial<ExecutiveDashboardPayload>))).toBe(true);
    });
});

describe('the ladder', () => {
    it('has five rungs with ascending, non-overlapping floors', () => {
        expect(POSTURE_LADDER.map((r) => r.level)).toEqual([1, 2, 3, 4, 5]);
        const floors = POSTURE_LADDER.map((r) => r.min);
        expect(floors).toEqual([...floors].sort((a, b) => a - b));
        expect(new Set(floors).size).toBe(floors.length);
        // The bottom rung must start at 0 or a score could rate nowhere.
        expect(floors[0]).toBe(0);
    });

    // A defect exists in every one of these (measured < total), so the
    // score alone decides — and can never reach the top rung.
    it.each([
        [0, 1],
        [49, 1],
        [50, 2],
        [74, 2],
        [75, 3],
        [89, 3],
        [90, 4],
        [99, 4],
    ])('score %i with a defect outstanding sits on rung %i', (value, expected) => {
        expect(levelForRating({ value, measured: 1, total: 2 })).toBe(expected);
    });

    describe('the top rung means zero defects, not a high percentage', () => {
        it('is reached only when measured === total', () => {
            expect(levelForRating({ value: 100, measured: 3, total: 3 })).toBe(5);
        });

        it('is NOT reached by a score that merely rounds to 100', () => {
            // The reported bug: 249 of 250 healthy is 99.6%, which rounds
            // to 100. An axis with a live overdue log must not read as
            // "everything is perfect".
            expect(levelForRating({ value: 100, measured: 249, total: 250 })).toBe(4);
        });

        it('caps a single outstanding item at level 4 however large the estate', () => {
            for (const total of [20, 200, 2000]) {
                expect(levelForRating({ value: 100, measured: total - 1, total })).toBe(4);
            }
        });
    });

    it('does not rate an axis with no estate behind it', () => {
        // 0/0 is not a perfect score. A tenant with no vendors is neither
        // good nor bad at vendors.
        expect(levelForRating({ value: 100, measured: 0, total: 0 })).toBeNull();
    });

    it('names every rung', () => {
        for (const rung of POSTURE_LADDER) {
            expect(levelKey(rung.level)).toBe(rung.key);
        }
    });

    it('rates each axis by its own counts', () => {
        const levels = levelsByKey(
            payload({
                // 1 of 4 implemented = 25% → rung 1.
                controlCoverage: { ...payload().controlCoverage, applicable: 4, implemented: 1, coveragePercent: 25 },
                // 19 of 20 not overdue = 95%, but one IS overdue → capped at 4.
                evidenceExpiry: { ...payload().evidenceExpiry, current: 19, overdue: 1 },
                // 3 of 3, nothing overdue → the top rung.
                taskSummary: { ...payload().taskSummary, total: 3, overdue: 0 },
            }),
        );
        expect(levels.controls).toBe(1);
        expect(levels.evidence).toBe(4);
        expect(levels.tasks).toBe(5);
    });

    it('drops a perfect axis off the top the moment one item goes overdue', () => {
        // The behaviour the recalibration exists for.
        const perfect = levelsByKey(payload({ taskSummary: { ...payload().taskSummary, total: 20, overdue: 0 } }));
        const oneOverdue = levelsByKey(payload({ taskSummary: { ...payload().taskSummary, total: 20, overdue: 1 } }));
        expect(perfect.tasks).toBe(5);
        expect(oneOverdue.tasks).toBe(4);
    });

    it('carries the raw counts the score came from', () => {
        // "Exact metrics" means the reader can divide the two numbers on
        // the page and get the percentage back.
        const axes = rate(
            payload({
                taskSummary: { ...payload().taskSummary, total: 8, overdue: 2 },
            }),
        );
        const tasks = axes.find((a) => a.key === 'tasks')!;
        expect({ measured: tasks.measured, total: tasks.total, value: tasks.value }).toEqual({
            measured: 6,
            total: 8,
            value: 75,
        });
        expect(Math.round((tasks.measured / tasks.total) * 100)).toBe(tasks.value);
    });
});

describe('overallLevel — the weakest link', () => {
    const axis = (over: Partial<PostureAxisRating>): PostureAxisRating => ({
        key: 'controls',
        label: 'Controls',
        value: 100,
        level: 5,
        measured: 10,
        total: 10,
        ...over,
    });

    it('takes the WEAKEST rated axis, not the average', () => {
        // Five strong axes must not hide one that is failing — the whole
        // reason a posture headline exists is to refuse that averaging.
        const { level, limitedBy } = overallLevel([
            axis({ key: 'controls', value: 100, level: 5 }),
            axis({ key: 'evidence', value: 98, level: 4 }),
            axis({ key: 'risk', value: 30, level: 1, measured: 3, total: 10 }),
            axis({ key: 'policies', value: 96, level: 4 }),
            axis({ key: 'tasks', value: 99, level: 4 }),
            axis({ key: 'vendors', value: 97, level: 4 }),
        ]);
        expect(level).toBe(1);
        expect(limitedBy?.key).toBe('risk');
    });

    it('names the limiting axis so the number becomes an instruction', () => {
        const { limitedBy } = overallLevel([
            axis({ key: 'tasks', value: 55, level: 2, measured: 11, total: 20 }),
            axis({ key: 'controls', value: 90, level: 4 }),
        ]);
        expect({ key: limitedBy?.key, measured: limitedBy?.measured, total: limitedBy?.total }).toEqual({
            key: 'tasks',
            measured: 11,
            total: 20,
        });
    });

    it('breaks a level tie on the score, not on array order', () => {
        // Both are level 4, but one is 249/250 (rounds to 100) and the
        // other genuinely 96%. The headline must name the one that
        // actually holds the level down.
        const { limitedBy } = overallLevel([
            axis({ key: 'tasks', value: 100, level: 4, measured: 249, total: 250 }),
            axis({ key: 'policies', value: 96, level: 4, measured: 24, total: 25 }),
        ]);
        expect(limitedBy?.key).toBe('policies');
    });

    it('skips axes with no estate behind them', () => {
        // A tenant with no vendors is neither good nor bad at vendors, and
        // must not be rated on something it does not do.
        const { level, limitedBy } = overallLevel([
            axis({ key: 'controls', value: 85, level: 3 }),
            axis({ key: 'vendors', value: 100, level: null, measured: 0, total: 0 }),
        ]);
        expect(level).toBe(3);
        expect(limitedBy?.key).toBe('controls');
    });

    it('reaches the top only when every rated axis is perfect', () => {
        const { level } = overallLevel([
            axis({ key: 'controls', value: 100, level: 5 }),
            axis({ key: 'tasks', value: 100, level: 5 }),
            axis({ key: 'vendors', value: 100, level: null, measured: 0, total: 0 }),
        ]);
        expect(level).toBe(5);
    });

    it('returns the bottom rung and no limiter when nothing is rated', () => {
        expect(overallLevel([])).toEqual({ level: 1, limitedBy: null, nextWeakest: null });
    });
});

describe('toRadarAxes — the dial and the list must tell ONE story', () => {
    const rated = (over: Partial<PostureAxisRating>): PostureAxisRating => ({
        key: 'controls',
        label: 'Controls',
        value: 100,
        level: 5,
        measured: 10,
        total: 10,
        ...over,
    });

    it('plots the LEVEL, not the percentage', () => {
        // The reported bug: Tasks at 97% (18 overdue of ~600) is level 4,
        // because a defect exists. Plotted as a percentage against rings at
        // 20/40/60/80/100 it landed on the OUTER ring and read as a perfect
        // 5, while the list beside it correctly said L4. The ladder's floors
        // (50/75/90/100) are not evenly spaced, so "ring N = level N" is
        // only true if the plotted value IS the level.
        const axes = toRadarAxes([rated({ key: 'tasks', value: 97, level: 4, measured: 582, total: 600 })]);
        expect(axes).toEqual([{ key: 'tasks', label: 'Controls', value: 4 }]);
    });

    it.each([1, 2, 3, 4, 5] as const)('a level-%i axis plots on ring %i', (level) => {
        const [axis] = toRadarAxes([rated({ level, value: 0 })]);
        expect(axis.value).toBe(level);
    });

    it('every plotted value agrees with the level the list shows', () => {
        // The invariant, stated once: whatever the chart draws for an axis
        // is the number the list prints beside it.
        const ratings = ratePostureAxes(
            payload({
                controlCoverage: { ...payload().controlCoverage, applicable: 10, implemented: 5, coveragePercent: 50 },
                evidenceExpiry: { ...payload().evidenceExpiry, current: 19, overdue: 1 },
                riskBySeverity: { low: 8, medium: 2, high: 0, critical: 0 },
                policySummary: { ...payload().policySummary, total: 4, overdueReview: 3 },
                taskSummary: { ...payload().taskSummary, total: 600, overdue: 18 },
                vendorSummary: { total: 5, overdueReview: 0 },
            }),
            label,
        );
        const plotted = new Map(toRadarAxes(ratings).map((a) => [a.key, a.value]));
        for (const r of ratings) {
            if (r.level === null) continue;
            expect({ axis: r.key, plotted: plotted.get(r.key) }).toEqual({ axis: r.key, plotted: r.level });
        }
        // …and the case from the report specifically.
        expect(plotted.get('tasks')).toBe(4);
    });

    it('never plots the top ring for an axis with an outstanding defect', () => {
        const ratings = ratePostureAxes(
            payload({ taskSummary: { ...payload().taskSummary, total: 600, overdue: 18 } }),
            label,
        );
        const tasks = toRadarAxes(ratings).find((a) => a.key === 'tasks')!;
        expect(tasks.value).toBeLessThan(POSTURE_LADDER.length);
    });

    it('omits unrated axes rather than pinning them to the centre', () => {
        // "No vendors yet" is not "level 1 at vendors".
        const axes = toRadarAxes([
            rated({ key: 'controls', level: 3 }),
            rated({ key: 'vendors', level: null, measured: 0, total: 0 }),
        ]);
        expect(axes.map((a) => a.key)).toEqual(['controls']);
    });

    it('needs three points to draw a polygon', () => {
        expect(MIN_RADAR_AXES).toBe(3);
    });
});

describe('rankedByWeakness', () => {
    const rated = (over: Partial<PostureAxisRating>): PostureAxisRating => ({
        key: 'controls',
        label: 'Controls',
        value: 100,
        level: 5,
        measured: 10,
        total: 10,
        ...over,
    });

    it('orders by level, then by score', () => {
        const ranked = rankedByWeakness([
            rated({ key: 'controls', value: 100, level: 5 }),
            rated({ key: 'tasks', value: 97, level: 4 }),
            rated({ key: 'risk', value: 30, level: 1 }),
            rated({ key: 'policies', value: 92, level: 4 }),
        ]);
        expect(ranked.map((r) => r.key)).toEqual(['risk', 'policies', 'tasks', 'controls']);
    });

    it('drops unrated axes', () => {
        const ranked = rankedByWeakness([
            rated({ key: 'vendors', level: null, measured: 0, total: 0 }),
            rated({ key: 'controls', level: 2, value: 55 }),
        ]);
        expect(ranked.map((r) => r.key)).toEqual(['controls']);
    });

    it('feeds the headline and the runner-up bullet from one ordering', () => {
        // `limitedBy` names what holds the level down; `nextWeakest` names
        // what to fix once it is cleared. They must never be the same axis.
        const ratings = [
            rated({ key: 'risk', value: 30, level: 1 }),
            rated({ key: 'tasks', value: 60, level: 2 }),
            rated({ key: 'controls', value: 100, level: 5 }),
        ];
        const { level, limitedBy, nextWeakest } = overallLevel(ratings);
        expect({ level, limited: limitedBy?.key, next: nextWeakest?.key }).toEqual({
            level: 1,
            limited: 'risk',
            next: 'tasks',
        });
    });

    it('has no runner-up when only one axis is rated', () => {
        const { nextWeakest } = overallLevel([
            rated({ key: 'controls', level: 3, value: 80 }),
            rated({ key: 'vendors', level: null, measured: 0, total: 0 }),
        ]);
        expect(nextWeakest).toBeNull();
    });
});
