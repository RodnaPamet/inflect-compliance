/**
 * R4-P3 — /tests performance + data-correctness (structural ratchet).
 *
 * PR-3 reshaped several hot read paths and reconciled two clocks. This locks the
 * load-bearing decisions so a future refactor can't silently regress them:
 *   1. computeTestReadiness runs in ONE transaction with batched groupBy reads,
 *      not 1 + 3×N transactions.
 *   2. getTestDashboardMetrics aggregates via groupBy, not a full run scan.
 *   3. getTestPlan carries a server-side pass/fail aggregate (KPI truth).
 *   4. The FAIL CONTROL_GAP task is spawned POST-COMMIT, never nested inside the
 *      completion transaction.
 *   5. scheduleTestPlan keeps nextDueAt frequency-derived (decoupled from cron).
 *   6. The dashboard "scheduled" KPIs match the scheduler scan (no automationType
 *      filter).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const READINESS = 'src/app-layer/usecases/test-readiness.ts';
const DUE_PLANNING = 'src/app-layer/usecases/due-planning.ts';
const CONTROL_TEST = 'src/app-layer/usecases/control/test-plans.ts';
const SCHEDULING = 'src/app-layer/usecases/test-scheduling.ts';
const PLANS_ROUTE = 'src/app/api/t/[tenantSlug]/tests/plans/route.ts';

describe('R4-P3 (1) readiness rollup is one batched transaction', () => {
    const src = read(READINESS);
    it('opens a single runInTenantContext and batches with groupBy', () => {
        // Exactly one CALL site (the import line also mentions the identifier).
        expect((src.match(/runInTenantContext\(ctx/g) ?? []).length).toBe(1);
        expect(src).toMatch(/controlTestPlan\.groupBy/);
        expect(src).toMatch(/controlTestRun\.groupBy/);
        // No per-framework re-query loop.
        expect(src).not.toMatch(/for \(const fw of frameworks\)[\s\S]*runInTenantContext/);
    });
});

describe('R4-P3 (2) dashboard metrics aggregate in the DB', () => {
    const src = read(DUE_PLANNING);
    it('getTestDashboardMetrics uses groupBy + count, not a full run findMany', () => {
        expect(src).toMatch(/by: \['status', 'result'\]/);
        expect(src).toMatch(/by: \['controlId'\]/);
        // The old `runsInPeriod` full-scan + in-JS filters is gone.
        expect(src).not.toMatch(/const runsInPeriod/);
    });
});

describe('R4-P3 (3) plan KPI counts come from a server aggregate', () => {
    it('getTestPlan returns runResultCounts', () => {
        expect(read(CONTROL_TEST)).toMatch(/runResultCounts/);
    });
});

describe('R4-P3 (4) FAIL gap task is spawned post-commit', () => {
    const src = read(CONTROL_TEST);
    it('a dedicated post-commit spawner exists and createTask is not nested in the completion tx', () => {
        expect(src).toMatch(/async function spawnControlGapTask/);
        expect(src).toMatch(/if \(result\.gapTask\) await spawnControlGapTask/);
    });
});

describe('R4-P3 (5) the two due clocks stay decoupled', () => {
    it('scheduleTestPlan derives nextDueAt from frequency, not from nextRunAt', () => {
        const src = read(SCHEDULING);
        expect(src).toMatch(/const nextDueAt = computeNextDueAt\(plan\.frequency/);
        expect(src).not.toMatch(/const nextDueAt = nextRunAt \?\?/);
    });
});

describe('R4-P3 (6) scheduled KPIs match the scheduler scan', () => {
    it('the dashboard scheduled counts drop the automationType filter', () => {
        const src = read(SCHEDULING);
        // The scheduled-active / overdue / upcoming reads must not re-introduce the
        // SCRIPT/INTEGRATION filter that hid scheduled MANUAL plans.
        const scheduledBlock = src.slice(src.indexOf('Automation plan counts'), src.indexOf('Upcoming top-10'));
        expect(scheduledBlock).not.toMatch(/schedule: \{ not: null \},\s*\n\s*automationType: \{ in: \['SCRIPT', 'INTEGRATION'\] \}/);
    });
});

describe('R4-P3 (7) the dead pagination contract is gone', () => {
    it('the plans route no longer advertises limit/cursor it ignores', () => {
        const src = read(PLANS_ROUTE);
        expect(src).not.toMatch(/limit: z\.coerce/);
        expect(src).not.toMatch(/cursor: z\.string/);
    });
});
