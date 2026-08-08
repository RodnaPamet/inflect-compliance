/**
 * R2-P2 — control detail synthesis + lifecycle wiring (structural ratchet).
 *
 * The control detail page was 8 self-fetching tabs the user had to assemble
 * into a judgement, with completion never advancing control state and no
 * concept help. This locks the fixes so they can't silently regress:
 *   1. Test/check completion writes back to control state (attestControlTested).
 *   2. A health synthesis payload + card exist and mount on the Overview.
 *   3. Overview fields carry concept-help tooltips.
 *   4. Lifecycle: run-launch uses client nav; evidence links reach the record;
 *      the overloaded evidence Status column is split.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const CONTROL_TEST = 'src/app-layer/usecases/control/test-plans.ts';
const HEALTH_USECASE = 'src/app-layer/usecases/control/health.ts';
const HEALTH_ROUTE = 'src/app/api/t/[tenantSlug]/controls/[controlId]/health/route.ts';
const HEALTH_CARD = 'src/app/t/[tenantSlug]/(app)/controls/[controlId]/_tabs/ControlHealthCard.tsx';
const DETAIL_PAGE = 'src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx';
const TEST_PLANS = 'src/components/TestPlansPanel.tsx';
const EVIDENCE_SUBTABLE = 'src/components/controls-shared/EvidenceSubTable.tsx';

describe('R2-P2 (1) completion advances control state', () => {
    const src = read(CONTROL_TEST);
    it('defines attestControlTested that writes Control.lastTested', () => {
        expect(src).toMatch(/async function attestControlTested/);
        expect(src).toMatch(/lastTested:/);
    });
    it('both completeTestRun and createAutomatedTestRun attest the control', () => {
        // Two call sites — manual completion + the automated check bridge.
        const calls = src.match(/attestControlTested\(/g) || [];
        // 1 definition reference + 2 call sites = at least 3 occurrences.
        expect(calls.length).toBeGreaterThanOrEqual(3);
    });
});

describe('R2-P2 (2) health synthesis', () => {
    it('the health usecase aggregates test + check + coverage + effectiveness', () => {
        const src = read(HEALTH_USECASE);
        expect(src).toMatch(/getControlHealth/);
        for (const field of ['latestTestResult', 'latestCheckStatus', 'effectiveness', 'coverage']) {
            expect(src).toContain(field);
        }
    });
    it('the health route + card exist and the card mounts on the Overview', () => {
        expect(read(HEALTH_ROUTE)).toMatch(/getControlHealth/);
        expect(read(HEALTH_CARD)).toMatch(/ControlHealthCard/);
        const page = read(DETAIL_PAGE);
        expect(page).toMatch(/<ControlHealthCard controlId=/);
    });
});

describe('R2-P2 (3) concept help on Overview fields', () => {
    it('the detail page attaches concept-help tooltips (ConceptEyebrow + conceptHelp keys)', () => {
        const page = read(DETAIL_PAGE);
        expect(page).toMatch(/ConceptEyebrow/);
        expect(page).toMatch(/conceptHelp\./);
    });
});

describe('R2-P2 (4) lifecycle fixes', () => {
    it('TestPlansPanel launches a run via client navigation, not window.location.href', () => {
        const src = read(TEST_PLANS);
        expect(src).toMatch(/router\.push\(/);
        expect(src).not.toMatch(/window\.location\.href\s*=/);
    });
    it('evidence rows deep-link to the specific record and split the Status column', () => {
        const src = read(EVIDENCE_SUBTABLE);
        expect(src).toMatch(/\/evidence\?ev=/);
        expect(src).toMatch(/id: 'addedBy'/);
    });
});

describe('R2-P2 i18n parity', () => {
    const en = JSON.parse(read('messages/en.json'));
    const bg = JSON.parse(read('messages/bg.json'));
    it('control health + concept-help keys exist in both locales', () => {
        for (const locale of [en, bg]) {
            expect(locale.controls.health.title).toBeTruthy();
            expect(locale.controls.health.testResult.PASS).toBeTruthy();
            expect(locale.controls.health.checkStatus.PASSED).toBeTruthy();
            expect(locale.controls.conceptHelp.frequency).toBeTruthy();
            // Moved to the `sharedPanels` namespace on 2026-08-06.
            // EvidenceSubTable is rendered by FOUR non-control surfaces
            // (Tasks list, Task detail, Risk detail, Asset detail) via
            // AttachedEvidencePanel, so its copy living under `controls`
            // meant a translator editing controls.* was editing four other
            // pages. The key still has to exist in both locales — it just
            // belongs to the component now, not to Controls.
            expect(locale.sharedPanels.evidenceTab.colAddedBy).toBeTruthy();
        }
    });
});
