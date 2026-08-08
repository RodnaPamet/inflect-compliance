/**
 * R4-P2 — /tests UI hardening (structural ratchet).
 *
 * PR-2 turned the /tests surface from "optimistic + silent" into
 * "confirmed + honest". This locks the load-bearing wirings so a future
 * refactor can't quietly regress them:
 *   1. Every mutation checks res.ok and reports via toast.
 *   2. Reversible destructive bulk-delete flows through the Epic 67 undo
 *      toast, and a restore endpoint exists so a committed delete is
 *      recoverable.
 *   3. A failed fetch renders an error+retry state, not an empty list —
 *      and never collapses 403/500 into "not found".
 *   4. Completing a run is confirmed; a duplicate run is not forked
 *      (hasPendingRun in the UI + an idempotency guard in the usecase).
 *   5. The integrity verdict is cleared when the evidence set changes.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const RUN_PAGE = 'src/app/t/[tenantSlug]/(app)/tests/runs/[runId]/page.tsx';
const TESTS_PAGE = 'src/app/t/[tenantSlug]/(app)/tests/page.tsx';
const DUE_PAGE = 'src/app/t/[tenantSlug]/(app)/tests/due/page.tsx';
const DASH_PAGE = 'src/app/t/[tenantSlug]/(app)/tests/dashboard/page.tsx';
const PLAN_DETAIL = 'src/components/test-plans/TestPlanDetailView.tsx';
const USECASE = 'src/app-layer/usecases/control-test.ts';
const RESTORE_ROUTE = 'src/app/api/t/[tenantSlug]/tests/plans/bulk/restore/route.ts';
const SCHEMAS = 'src/lib/schemas/index.ts';

describe('R4-P2 (1) run-page mutations are checked + reported', () => {
    const src = read(RUN_PAGE);
    it('retest + unlink surface an error toast on failure', () => {
        expect(src).toMatch(/toast\.error\(t\('run\.errors\.retestFailed'\)\)/);
        expect(src).toMatch(/toast\.error\(t\('run\.errors\.unlinkFailed'\)\)/);
    });
    it('unlink checks res.ok before mutate', () => {
        // the old fire-and-forget DELETE (mutate regardless) is gone
        expect(src).not.toMatch(/await fetch\(apiUrl\(`\/tests\/runs\/\$\{runId\}\/evidence\/\$\{linkId\}`\), \{ method: 'DELETE' \}\);\s*await mutate/);
        expect(src).toMatch(/if \(!res\.ok\) throw new Error\(await res\.text\(\)\);\s*\n\s*\/\/ Removing a link/);
    });
    it('snapshot surfaces the server message, not a blanket failure', () => {
        expect(src).toMatch(/err instanceof Error && err\.message/);
    });
});

describe('R4-P2 (2) complete is confirmed', () => {
    const src = read(RUN_PAGE);
    it('the complete button opens a ConfirmDialog instead of firing directly', () => {
        expect(src).toMatch(/ConfirmDialog/);
        expect(src).toMatch(/confirmingComplete/);
        expect(src).toMatch(/onClick=\{\(\) => setConfirmingComplete\(true\)\}/);
    });
});

describe('R4-P2 (3) integrity verdict is cleared on evidence mutation', () => {
    it('link + unlink both reset integrity', () => {
        const src = read(RUN_PAGE);
        const setNullCount = (src.match(/setIntegrity\(null\)/g) ?? []).length;
        expect(setNullCount).toBeGreaterThanOrEqual(2);
    });
});

describe('R4-P2 (4) error states distinguish 403/404/500', () => {
    it('the run page does not collapse every failure to not-found', () => {
        const src = read(RUN_PAGE);
        expect(src).toMatch(/ApiClientError/);
        expect(src).toMatch(/run\.errors\.forbidden/);
        expect(src).toMatch(/run\.errors\.loadFailed/);
    });
    it('the plan detail view distinguishes forbidden + load-failed', () => {
        const src = read(PLAN_DETAIL);
        expect(src).toMatch(/ApiClientError/);
        expect(src).toMatch(/testPlan\.planForbidden/);
        expect(src).toMatch(/testPlan\.planLoadFailed/);
    });
});

describe('R4-P2 (5) bulk-delete undo + restore endpoint', () => {
    it('tests/page routes bulk-delete through useToastWithUndo', () => {
        const src = read(TESTS_PAGE);
        expect(src).toMatch(/useToastWithUndo/);
        expect(src).toMatch(/triggerUndoToast\(\{/);
        expect(src).toMatch(/list\.bulkDeletedToast/);
    });
    it('a restore usecase + route + schema exist', () => {
        expect(read(USECASE)).toMatch(/export async function bulkRestoreTestPlan/);
        expect(read(RESTORE_ROUTE)).toMatch(/bulkRestoreTestPlan/);
        expect(read(SCHEMAS)).toMatch(/BulkTestPlanRestoreSchema/);
    });
});

describe('R4-P2 (6) error+retry states keep the surface mounted', () => {
    it('tests/page, due, and dashboard all render an ErrorState with retry', () => {
        for (const f of [TESTS_PAGE, DUE_PAGE, DASH_PAGE]) {
            const src = read(f);
            expect(src).toMatch(/ErrorState/);
            expect(src).toMatch(/onRetry=/);
        }
    });
    it('dashboard no longer collapses error into a perpetual skeleton', () => {
        const src = read(DASH_PAGE);
        expect(src).toMatch(/metricsError/);
    });
});

describe('R4-P2 (7) duplicate runs are prevented', () => {
    it('the plan view offers Continue run when a run is pending', () => {
        const src = read(PLAN_DETAIL);
        expect(src).toMatch(/hasPendingRun/);
        expect(src).toMatch(/testPlan\.continueRun/);
    });
    it('createTestRun reuses an open run instead of forking a new one', () => {
        const src = read(USECASE);
        expect(src).toMatch(/status: \{ in: \['PLANNED', 'RUNNING'\] \}/);
        expect(src).toMatch(/if \(existing\) return existing;/);
    });
});

describe('R4-P2 i18n parity', () => {
    const en = JSON.parse(read('messages/en.json'));
    const bg = JSON.parse(read('messages/bg.json'));
    it('new keys exist in both locales', () => {
        for (const l of [en, bg]) {
            expect(l.controlTests.run.errors.retestFailed).toBeTruthy();
            expect(l.controlTests.run.errors.unlinkFailed).toBeTruthy();
            expect(l.controlTests.run.errors.forbidden).toBeTruthy();
            expect(l.controlTests.run.confirmComplete.title).toBeTruthy();
            expect(l.controlTests.run.snapshot.unverifiedHint).toBeTruthy();
            expect(l.controlTests.list.bulkDeletedToast).toBeTruthy();
            expect(l.controlTests.list.loadErrorTitle).toBeTruthy();
            expect(l.controlTests.due.loadErrorTitle).toBeTruthy();
            expect(l.controlTests.dashboard.loadErrorTitle).toBeTruthy();
            expect(l.controls.testPlan.continueRun).toBeTruthy();
            expect(l.controls.testPlan.planForbidden).toBeTruthy();
        }
    });
});
