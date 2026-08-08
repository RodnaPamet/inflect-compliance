/**
 * R3-P2 — guided test run (structural ratchet).
 *
 * "Running" a test used to open a PLANNED result-entry form, not an
 * execution. This locks the guided-run refactor:
 *   1. A PLANNED → RUNNING transition exists and is wired end-to-end
 *      (usecase + repo + route). RUNNING was a dead enum value.
 *   2. Test steps are authorable after creation (UpdateTestPlanSchema +
 *      the shared editor) and shown during a run.
 *   3. Evidence is picked from the library, not pasted as a raw cuid.
 *   4. /tests/due "Run now" uses client navigation, not window.location.
 *   5. method↔automationType are reconciled at the write layer.
 *   6. The swallow-on-failure write paths surface an error toast.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const USECASE = 'src/app-layer/usecases/control-test.ts';
const DERIVE_DOMAIN = 'src/app-layer/domain/test-plan-method.ts';
const REPOSITORY = 'src/app-layer/repositories/TestPlanRepository.ts';
const PLAN_DETAIL = 'src/components/test-plans/TestPlanDetailView.tsx';
const SCHEDULING = 'src/app-layer/usecases/test-scheduling.ts';
const RUN_REPO = 'src/app-layer/repositories/TestRunRepository.ts';
const START_ROUTE = 'src/app/api/t/[tenantSlug]/tests/runs/[runId]/start/route.ts';
const RUN_PAGE = 'src/app/t/[tenantSlug]/(app)/tests/runs/[runId]/page.tsx';
const DUE_PAGE = 'src/app/t/[tenantSlug]/(app)/tests/due/page.tsx';
const STEPS_EDITOR = 'src/components/test-plans/TestStepsEditor.tsx';
const SCHEMAS = 'src/lib/schemas/index.ts';
const PLAN_REPO = 'src/app-layer/repositories/TestPlanRepository.ts';

describe('R3-P2 (1) PLANNED → RUNNING transition', () => {
    it('startTestRun usecase + repo.start + route exist', () => {
        expect(read(USECASE)).toMatch(/export async function startTestRun/);
        expect(read(RUN_REPO)).toMatch(/async start\(/);
        expect(read(RUN_REPO)).toMatch(/status: 'RUNNING'/);
        expect(read(START_ROUTE)).toMatch(/startTestRun/);
    });
    it('the run page drives the guided flow (Start when PLANNED, checklist when RUNNING)', () => {
        const src = read(RUN_PAGE);
        expect(src).toMatch(/start-test-run-btn/);
        expect(src).toMatch(/isRunning|isPlanned/);
        expect(src).toMatch(/checkedSteps/);
    });
});

describe('R3-P2 (2) authorable steps', () => {
    it('UpdateTestPlanSchema accepts steps and a shared editor exists', () => {
        // steps appears in the Update schema block, not just Create
        const schemas = read(SCHEMAS);
        const updateStart = schemas.indexOf('UpdateTestPlanSchema');
        const updateBlock = schemas.slice(updateStart, schemas.indexOf('CompleteTestRunSchema'));
        expect(updateBlock).toMatch(/steps:/);
        expect(read(STEPS_EDITOR)).toMatch(/export function TestStepsEditor/);
        expect(read(PLAN_REPO)).toMatch(/controlTestStep\.deleteMany/);
    });
});

describe('R3-P2 (3) evidence picker, not raw cuid', () => {
    it('the run page uses a Combobox for the EVIDENCE kind', () => {
        const src = read(RUN_PAGE);
        expect(src).toMatch(/evidenceOptions/);
        // the old raw paste input is gone
        expect(src).not.toMatch(/evidenceIdPlaceholder/);
    });
});

describe('R3-P2 (4) client navigation on due Run-now', () => {
    it('/tests/due uses router.push, not window.location.href', () => {
        const src = read(DUE_PAGE);
        expect(src).toMatch(/router\.push\(tenantHref\(`\/tests\/runs\//);
        expect(src).not.toMatch(/window\.location\.href = tenantHref/);
    });
});

describe('R3-P2 (5) method↔automation reconciliation', () => {
    it('a single derive helper is applied in the scheduling write path', () => {
        // PR-CC — the helper moved to `domain/test-plan-method` so
        // TestPlanRepository can derive too WITHOUT a repository→usecase import
        // (which would invert the layer dependency). The usecase imports and
        // re-exports it, so this remains the usecase-layer import site.
        expect(read(DERIVE_DOMAIN)).toMatch(/export function deriveMethodFromAutomationType/);
        expect(read(USECASE)).toMatch(/deriveMethodFromAutomationType/);
        expect(read(SCHEDULING)).toMatch(/deriveMethodFromAutomationType/);
        // schedule write syncs method + nextDueAt into one coherent model
        expect(read(SCHEDULING)).toMatch(/method,/);
        expect(read(SCHEDULING)).toMatch(/nextDueAt,/);
    });

    it('`method` is DERIVED everywhere — no surface writes it directly', () => {
        // PR-CC — the free method toggle drifted from automationType (a plan
        // rendered "AUTOMATED" while nothing was scheduled). It's gone: the
        // edit form no longer offers it, and the repository derives on create.
        expect(read(PLAN_DETAIL)).not.toMatch(/buildMethodOptions|setEditMethod/);
        // The repo derives on CREATE from automationType instead of accepting a
        // caller-supplied `method` (which defaulted to MANUAL and was a latent
        // re-drift vector). `update` still takes `method` — that's the usecase
        // persisting the value it just DERIVED, which is the correct flow.
        const repo = read(REPOSITORY);
        expect(repo).toMatch(/method: deriveMethodFromAutomationType\(/);
        expect(repo).toMatch(/automationType\?: string;/);
    });
});

describe('R3-P2 (6) no silent write failures', () => {
    it('the run + due + panel write paths surface an error toast', () => {
        expect(read(RUN_PAGE)).toMatch(/toast\.error\(t\('run\.errors\.completeFailed'\)\)/);
        expect(read(DUE_PAGE)).toMatch(/toast\.error/);
        expect(read('src/components/TestPlansPanel.tsx')).toMatch(/toast\.error/);
    });
});

describe('R3-P2 i18n parity', () => {
    const en = JSON.parse(read('messages/en.json'));
    const bg = JSON.parse(read('messages/bg.json'));
    it('new keys exist in both locales', () => {
        for (const l of [en, bg]) {
            expect(l.controlTests.steps.add).toBeTruthy();
            expect(l.controlTests.run.startTest).toBeTruthy();
            expect(l.controlTests.run.errors.completeFailed).toBeTruthy();
            expect(l.controlTests.due.runFailed).toBeTruthy();
            expect(l.controls.testPlan.saveFailed).toBeTruthy();
            expect(l.panels.testPlans.createFailed).toBeTruthy();
        }
    });
});
