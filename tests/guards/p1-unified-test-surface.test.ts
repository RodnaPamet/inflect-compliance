/**
 * R3-P1 — unified test surface (structural ratchet).
 *
 * The test subsystem split along manual ControlTestPlan vs automated
 * IntegrationExecution checks with no global reconciliation. This locks the
 * unification:
 *   1. A tenant-wide checks usecase + route exist (checks were per-control only).
 *   2. /tests offers a Plans vs Automated-checks view with a global
 *      tests-vs-checks explanation (was only inline on a control's tabs).
 *   3. The canonical /tests list has a method column.
 *   4. A test plan can be created from /tests (was per-control only).
 *   5. The inherited view notes that automated checks aren't rolled up.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const INTEGRATIONS = 'src/app-layer/usecases/integrations.ts';
const CHECKS_ROUTE = 'src/app/api/t/[tenantSlug]/tests/checks/route.ts';
const TESTS_PAGE = 'src/app/t/[tenantSlug]/(app)/tests/page.tsx';
const CREATE_MODAL = 'src/app/t/[tenantSlug]/(app)/tests/_components/NewTestPlanModal.tsx';
const INHERITED = 'src/components/InheritedTestPlansPanel.tsx';

describe('R3-P1 (1) tenant-wide automated checks', () => {
    it('a tenant-wide listAllControlchecks usecase + /tests/checks route exist', () => {
        expect(read(INTEGRATIONS)).toMatch(/export async function listAllControlChecks/);
        expect(read(CHECKS_ROUTE)).toMatch(/listAllControlChecks/);
    });
});

describe('R3-P1 (2) unified /tests surface', () => {
    const src = read(TESTS_PAGE);
    it('offers a Plans vs Automated-checks view toggle', () => {
        expect(src).toMatch(/'plans' \| 'checks'/);
        expect(src).toMatch(/unified\.tabChecks/);
        // PR-Q — the /tests/checks endpoint literal moved into the canonical
        // CACHE_KEYS.tests.checks() SWR key during the useTenantSWR migration.
        expect(src).toMatch(/CACHE_KEYS\.tests\.checks\(\)|\/tests\/checks/);
    });
    it('explains tests-vs-checks at the global level', () => {
        expect(src).toMatch(/unified\.explanation/);
    });
});

describe('R3-P1 (3) method column on the canonical list', () => {
    it('the /tests plan list renders a method column', () => {
        const src = read(TESTS_PAGE);
        expect(src).toMatch(/id: 'method'/);
        expect(src).toMatch(/colHeaders\.method/);
    });
});

describe('R3-P1 (4) global create', () => {
    it('a test plan can be created from /tests', () => {
        expect(read(TESTS_PAGE)).toMatch(/NewTestPlanModal/);
        expect(read(TESTS_PAGE)).toMatch(/tests-create-plan-btn/);
        const modal = read(CREATE_MODAL);
        expect(modal).toMatch(/\/controls\/\$\{controlId\}\/tests\/plans/);
        // GET /controls returns the `{ rows, truncated }` backfill envelope, not
        // an array — reading anything else stored the envelope and crashed the
        // page on `controls.map`. Lock the `.rows` read + the surfaced error.
        expect(modal).toMatch(/d\.rows/);
        expect(modal).not.toMatch(/d\.items \?\? d/);
        expect(modal).toMatch(/controlsLoadError/);
    });
});

describe('R3-P1 (5) inheritance parity', () => {
    it('the inherited view notes automated checks are not rolled up', () => {
        expect(read(INHERITED)).toMatch(/inherited\.checksNote/);
    });
});

describe('R3-P1 i18n parity', () => {
    const en = JSON.parse(read('messages/en.json'));
    const bg = JSON.parse(read('messages/bg.json'));
    it('new keys exist in both locales', () => {
        for (const l of [en, bg]) {
            expect(l.controlTests.unified.tabChecks).toBeTruthy();
            expect(l.controlTests.unified.explanation).toBeTruthy();
            expect(l.controlTests.colHeaders.method).toBeTruthy();
            expect(l.controlTests.method.MANUAL).toBeTruthy();
            expect(l.panels.inherited.checksNote).toBeTruthy();
        }
    });
});
