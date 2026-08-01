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
    buildPostureRadarAxes,
    isPostureRadarMeaningful,
    POSTURE_RADAR_AXES,
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
const byKey = (exec: ExecutiveDashboardPayload) =>
    Object.fromEntries(buildPostureRadarAxes(exec, label).map((a) => [a.key, a.value]));

describe('buildPostureRadarAxes', () => {
    it('returns the six axes in a stable order', () => {
        const axes = buildPostureRadarAxes(payload(), label);
        expect(axes.map((a) => a.key)).toEqual([...POSTURE_RADAR_AXES]);
    });

    it('reads control coverage straight through', () => {
        const v = byKey(
            payload({
                controlCoverage: { ...payload().controlCoverage, applicable: 4, implemented: 2, coveragePercent: 50 },
            }),
        );
        expect(v.controls).toBe(50);
    });

    it('scores evidence on the share that is CURRENT', () => {
        const v = byKey(
            payload({
                evidenceExpiry: { overdue: 1, dueSoon7d: 0, dueSoon30d: 1, noReviewDate: 0, current: 2 },
            }),
        );
        expect(v.evidence).toBe(50);
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
        const axes = buildPostureRadarAxes(payload(), (a) => `label:${a}`);
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
