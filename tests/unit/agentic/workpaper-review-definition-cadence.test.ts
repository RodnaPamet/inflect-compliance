/**
 * The governance pack's definition of `assurance.workpaper_reviews_drawn` must
 * state the cadence the sweep actually runs at (#5304).
 *
 * It said workpapers "written since the last monthly sweep" were not drawn yet,
 * while the sweep runs daily at 09:40 UTC (owner decision, 2026-10-19). The
 * definition ships beside the figure for assessors to cite, so a monthly claim
 * told them up to a month of workpapers was missing when at most a day is.
 */
import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';
import { METRIC_DEFINITIONS } from '@/lib/agentic/report-definitions';

describe('the workpaper-review draw definition matches the sweep schedule', () => {
    const sweep = SCHEDULED_JOBS.find((j) => j.name === 'audit-workpaper-sample-review');
    const excludes = METRIC_DEFINITIONS['assurance.workpaper_reviews_drawn'].excludes ?? [];
    const pending = excludes.filter((line) => line.includes('not drawn yet'));

    it('the sweep runs every day at 09:40 UTC', () => {
        expect(sweep?.pattern).toBe('40 9 * * *');
    });

    it('names the daily sweep, and its time, as what has not drawn the newest workpapers', () => {
        expect(pending).toEqual(['workpapers written since the last daily sweep (09:40 UTC), which are not drawn yet']);
    });
});
