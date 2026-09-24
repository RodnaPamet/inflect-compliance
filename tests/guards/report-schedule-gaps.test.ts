/**
 * Report-schedule + polish ratchet.
 *
 * Locks the five gap-closures: risk-scoped scheduled deep-dives,
 * schedule edit, import out-of-scale notice, scenario
 * correlationsDropped, and the two cleanups (treatment-plan doc header,
 * single matrix-config fetch).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
// Applied here rather than per assertion so a new `expect(read(...))` inherits
// it. String literals are KEPT: masking them would silently empty assertions
// that harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike (re-derived per file, not assumed from the directory), so
// `codeOf` is the right lexer and no language split is needed.
import { codeOf, commentsOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
// `readDoc` is the INVERSE mask (#2246), not a raw read. The assertions below
// are about the DOCUMENTATION itself — a docblock header and a scope note — so
// `codeOf` would empty the very text they name. `commentsOf` blanks the CODE
// instead and keeps the comments, which is the same choice stated the other way
// round and reaches far less: 29 kB of usecase down to its comment text.
//
// The `.not.toMatch` on the next-but-one describe block is why this distinction
// has to be exact. A negative over a mask that removes the FORBIDDEN text is
// trivially true; a negative over a mask that removes the OTHER category is
// not. Proved rather than argued — planting `MITIGATE → CLOSED` in a comment of
// risk-treatment-plan.ts still trips the masked view (the guard can still go
// red), while planting it in a code literal does not, which is the false alarm
// worth losing: a status-transition string in code is not the doc header this
// test forbids.
const readDoc = (rel: string) => commentsOf(readRaw(rel));

const REPORTS = read('src/app/t/[tenantSlug]/(app)/risks/reports/page.tsx');
const IMPORT = read('src/app/t/[tenantSlug]/(app)/risks/import/page.tsx');
const SCENARIOS = read('src/app/t/[tenantSlug]/(app)/risks/scenarios/page.tsx');
const PLAN = readDoc('src/app-layer/usecases/risk-treatment-plan.ts');
const PANEL = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/RiskAssessmentPanel.tsx');
const DETAIL = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');
const FAIR = readDoc('src/app/t/[tenantSlug]/(app)/risks/[riskId]/FairAnalysisPanel.tsx');

describe('1. scheduled deep-dive can be risk-scoped', () => {
    it('the schedule-create form picks a risk and sends parameters.riskId', () => {
        expect(REPORTS).toMatch(/selectedIsDeepDive/);
        expect(REPORTS).toMatch(/id="schedule-deepdive-risk"/);
        expect(REPORTS).toMatch(/parameters: \{ riskId \}/);
    });
});

describe('2. schedules can be edited in place', () => {
    it('an edit affordance PATCHes cadence + recipients', () => {
        expect(REPORTS).toMatch(/const startEdit/);
        expect(REPORTS).toMatch(/const saveEdit/);
        expect(REPORTS).toMatch(/schedule-edit-btn-/);
        // Asserted as fields of the patch rather than as one literal call
        // shape. The previous regex pinned the exact argument text, so ADDING a
        // field to the patch broke the guard even though the invariant it
        // protects — an edit sends cadence and recipients — still held.
        const save = REPORTS.slice(
            REPORTS.indexOf('const saveEdit'),
            REPORTS.indexOf('const removeSchedule'),
        );
        expect(save).toMatch(/patch\(\s*id,/);
        expect(save).toMatch(/cadence: editCadence/);
        expect(save).toMatch(/recipients: emails/);
    });

    it('the edit form surfaces the fields a schedule actually stores', () => {
        // `startEdit` seeded only cadence + recipients, so `format` and the
        // deep-dive `riskId` were stored at creation and then neither visible
        // nor editable — a user who scoped a schedule to one risk could not see
        // what it was scoped to. `deliveryDay` is shown read-only because
        // updateSchedule does not accept it, and an editable control that
        // silently does nothing is worse than an honest read-only one.
        expect(REPORTS).toMatch(/setEditFormat/);
        expect(REPORTS).toMatch(/setEditRiskId/);
        expect(REPORTS).toMatch(/schedule-edit-format-/);
        expect(REPORTS).toMatch(/schedule-edit-risk-/);
        expect(REPORTS).toMatch(/scheduleDeliveryDayReadOnly/);
    });

    it('every write affordance on the page is permission-gated', () => {
        // The page had ZERO RequirePermission, so a READER (reports.export =
        // false) was shown eight write buttons, clicked them and got a 403.
        expect(REPORTS).toMatch(/import \{ RequirePermission \}/);
        expect(REPORTS).toMatch(/import \{ UpgradeGate \}/);
        const gates = REPORTS.match(/<RequirePermission resource="reports" action="export">/g) ?? [];
        expect(gates.length).toBeGreaterThanOrEqual(4);
        // PDF/PPTX additionally sit behind the entitlement the risk-report route
        // began enforcing in #1759; CSV deliberately does not.
        const upgrades = REPORTS.match(/<UpgradeGate feature="PDF_EXPORTS">/g) ?? [];
        expect(upgrades.length).toBe(2);
    });

    it('polls only while a run is non-terminal, and surfaces a failure reason', () => {
        // Generation is synchronous inside the POST, so a serverless timeout
        // stranded a run in GENERATING with no refreshInterval and no manual
        // refresh to move it. And `errorMessage` was already on the wire —
        // omitted from the client interface, so FAILED rendered as a bare pill.
        expect(REPORTS).toMatch(/TERMINAL_STATUSES/);
        expect(REPORTS).toMatch(/refreshInterval:\s*\(latest\)/);
        expect(REPORTS).toMatch(/errorMessage: string \| null/);
        expect(REPORTS).toMatch(/run-error-/);
        expect(REPORTS).toMatch(/run-retry-/);
    });
});

describe('3. import flags out-of-scale values per row', () => {
    it('captures the raw out-of-scale value + renders a per-row notice', () => {
        expect(IMPORT).toMatch(/outOfScale/);
        expect(IMPORT).toMatch(/data-testid="import-out-of-scale"/);
        expect(IMPORT).toMatch(/outOfScaleLikelihood|outOfScaleImpact/);
    });
});

describe('4. scenario result surfaces dropped correlations', () => {
    it('the comparison type carries correlationsDropped + a warning renders', () => {
        expect(SCENARIOS).toMatch(/correlationsDropped\?:\s*boolean/);
        expect(SCENARIOS).toMatch(/data-testid="scenario-correlations-dropped"/);
    });
});

describe('5. cleanups', () => {
    it('the treatment-plan doc header reflects MITIGATE → MITIGATED', () => {
        expect(PLAN).toMatch(/MITIGATE → MITIGATED/);
        expect(PLAN).not.toMatch(/MITIGATE → CLOSED/);
    });
    it('the assessment panel takes matrixConfig + does not re-fetch it', () => {
        expect(PANEL).toMatch(/matrixConfig: RiskMatrixConfigShape/);
        expect(PANEL).not.toMatch(/fetch\(apiUrl\('\/risk-matrix-config'\)\)/);
        expect(DETAIL).toMatch(/matrixConfig=\{matrixConfig\}/);
    });
    it('FairAnalysisPanel documents the BIA scope decision', () => {
        expect(FAIR).toMatch(/BIA fields stay out of this panel/);
    });
});
