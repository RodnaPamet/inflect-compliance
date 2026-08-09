/**
 * Risk-quant bugfix ratchet — calibration annualization, PD gate,
 * TRANSFER/AVOID recommendation, and status localization.
 *
 * The behavioural math is covered by tests/unit/loss-calibration.test.ts
 * and tests/unit/risk-correlation.test.ts; this locks the wiring that
 * connects those fixes to the pages/panels so a refactor can't silently
 * revert them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CALIB = read('src/lib/risk/loss-calibration.ts');
const LOSS_PAGE = read('src/app/t/[tenantSlug]/(app)/risks/loss-events/page.tsx');
const CORR = read('src/app-layer/usecases/risk-correlation.ts');
const CORR_PAGE = read('src/app/t/[tenantSlug]/(app)/risks/correlations/page.tsx');
const PANEL = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/RiskAssessmentPanel.tsx');
const DETAIL = read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx');
const PLAN_CARD = read('src/components/risks/RiskTreatmentPlanCard.tsx');

describe('1. calibration annualizes + excludes degenerate bands', () => {
    it('the helper takes observedYears and annualizes the cumulative actual', () => {
        expect(CALIB).toMatch(/observedYears\s*=\s*1/);
        expect(CALIB).toMatch(/const actual = cumulative \/ years/);
        // Degenerate band → insufficientDistribution, not scored.
        expect(CALIB).toMatch(/if \(f\.p90 <= f\.p50\)/);
        expect(CALIB).toMatch(/insufficientDistribution/);
    });
    it('the page passes the observed-year span + excludes no-tail-data risks', () => {
        expect(LOSS_PAGE).toMatch(/computeLossCalibration\(forecasts, actuals, years\)/);
        // no-tail-data filter mirrors tail-language: aleP90 > aleMean.
        expect(LOSS_PAGE).toMatch(/aleP90 as number\) > \(r\.aleMean as number\)/);
    });
});

describe('2. correlations page tests PD, not just PSD', () => {
    it('the usecase surfaces minEigenvalue + a strict isPositiveDefinite', () => {
        expect(CORR).toMatch(/export const PD_EPSILON/);
        expect(CORR).toMatch(/isPositiveDefinite: isPositiveDefinite\(psd\.minEigenvalue\)/);
    });
    it('the page warns on a PSD-but-not-PD matrix before the sim drops it', () => {
        expect(CORR_PAGE).toMatch(/m\.isPositiveSemiDefinite && !m\.isPositiveDefinite/);
        expect(CORR_PAGE).toMatch(/data-testid="correlations-non-pd-warning"/);
        // Green tick ONLY when strictly PD.
        expect(CORR_PAGE).toMatch(/m\.isPositiveDefinite\s*\?\s*'success'/);
    });
});

describe('3. TRANSFER/AVOID is never told to apply MITIGATING', () => {
    it('branches TRANSFER/AVOID to CLOSED', () => {
        expect(PANEL).toMatch(/decision === 'TRANSFER' \|\| decision === 'AVOID'/);
        expect(PANEL).toMatch(/status: 'CLOSED', messageKey: 'assessment\.recommendClosed'/);
    });
});

describe('4. status enums are localized', () => {
    it('the detail header + assessment copy use riskStatusLabel', () => {
        expect(DETAIL).toMatch(/value: riskStatusLabel\(t, risk\.status\)/);
        expect(PANEL).toMatch(/riskStatusLabel\(t, risk\.status\)/);
        expect(PANEL).toMatch(/riskStatusLabel\(t, recommendedStatus\.status\)/);
    });
    it('the plan card badges localize status + strategy (no raw enum)', () => {
        expect(PLAN_CARD).toMatch(/t\(`status\.\$\{plan\.status\}`/);
        expect(PLAN_CARD).toMatch(/t\(`strategy\.\$\{plan\.strategy\}`/);
        expect(PLAN_CARD).not.toMatch(/>\s*\{plan\.status\}\s*</);
        expect(PLAN_CARD).not.toMatch(/>\s*\{plan\.strategy\}\s*</);
    });
});
