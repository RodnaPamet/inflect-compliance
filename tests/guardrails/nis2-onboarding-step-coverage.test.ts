/**
 * NIS2 onboarding-step coverage ratchet.
 *
 * Locks the conditional NIS2_SELF_ASSESSMENT onboarding step in place:
 * its position in the order, its skippability, the applicability gate, the
 * applicable-step progress denominator, the three permission-gated API
 * routes, and the step component's platform-primitive usage + the
 * load-bearing CC BY 4.0 attribution.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isStepApplicable } from '@/app-layer/usecases/onboarding';
import { ONBOARDING_STEPS, SKIPPABLE_STEPS } from '@/lib/schemas/onboarding';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const STEP = 'NIS2_SELF_ASSESSMENT';

describe('NIS2 onboarding step — registration', () => {
    it('sits right after FRAMEWORK_SELECTION and before ASSET_SETUP in ONBOARDING_STEPS', () => {
        const i = ONBOARDING_STEPS.indexOf(STEP as never);
        expect(i).toBeGreaterThan(-1);
        expect(ONBOARDING_STEPS[i - 1]).toBe('FRAMEWORK_SELECTION');
        // ASSET_SETUP follows the conditional self-assessment slot — NIS2 and
        // AI_GOVERNANCE_SELF_ASSESSMENT both live between the two.
        expect(ONBOARDING_STEPS.indexOf('ASSET_SETUP' as never)).toBeGreaterThan(i);
    });

    it('mirrors the same position in the usecase STEP_ORDER', () => {
        const src = read('src/app-layer/usecases/onboarding.ts');
        // FRAMEWORK_SELECTION is immediately followed by NIS2_SELF_ASSESSMENT;
        // the AI_GOVERNANCE_SELF_ASSESSMENT conditional step follows before
        // ASSET_SETUP.
        expect(src).toMatch(/'FRAMEWORK_SELECTION',\s*(?:\/\/[^\n]*\n\s*)?'NIS2_SELF_ASSESSMENT',/);
    });

    it('is skippable', () => {
        expect(SKIPPABLE_STEPS).toContain(STEP);
    });
});

describe('NIS2 onboarding step — applicability gate', () => {
    it('is applicable only when NIS2 is among the selected frameworks', () => {
        const withNis2 = { FRAMEWORK_SELECTION: { selectedFrameworks: ['SOC2', 'NIS2'] } };
        const without = { FRAMEWORK_SELECTION: { selectedFrameworks: ['SOC2'] } };
        expect(isStepApplicable(STEP as never, withNis2)).toBe(true);
        expect(isStepApplicable(STEP as never, without)).toBe(false);
        expect(isStepApplicable(STEP as never, {})).toBe(false);
    });

    it('matches the wizard picker LOWERCASE key (the real stored value)', () => {
        // The framework picker stores `key: 'nis2'` — the gate must be
        // case-insensitive or the step would never appear.
        const lower = { FRAMEWORK_SELECTION: { selectedFrameworks: ['iso27001', 'nis2'] } };
        expect(isStepApplicable(STEP as never, lower)).toBe(true);
    });

    it('every other step is unconditionally applicable', () => {
        expect(isStepApplicable('ASSET_SETUP' as never, {})).toBe(true);
        expect(isStepApplicable('REVIEW_AND_FINISH' as never, {})).toBe(true);
    });

    it('the progress denominator excludes non-applicable steps', () => {
        const src = read('src/app-layer/usecases/onboarding.ts');
        // The fix: filter STEP_ORDER by isStepApplicable for both numerator
        // and denominator — never the raw STEP_ORDER.length.
        expect(src).toMatch(/applicableSteps\s*=\s*STEP_ORDER\.filter/);
        expect(src).not.toMatch(/completedSteps\.length\s*\/\s*STEP_ORDER\.length/);
    });
});

describe('NIS2 onboarding step — API routes (auth + rate-limited)', () => {
    const base = 'src/app/api/t/[tenantSlug]/onboarding/nis2-assessment';
    const routes: Array<[string, string]> = [
        [`${base}/route.ts`, 'getNis2AssessmentState'],
        [`${base}/answers/[questionId]/route.ts`, 'saveNis2Answer'],
        [`${base}/complete/route.ts`, 'completeNis2Assessment'],
    ];
    it.each(routes)('%s exists, wraps withApiErrorHandling, calls the usecase', (rel, usecase) => {
        const src = read(rel);
        expect(src).toContain('withApiErrorHandling');
        expect(src).toContain(usecase);
    });

    it('the usecases assert onboarding-management authorization', () => {
        const src = read('src/app-layer/usecases/onboarding-nis2.ts');
        // ADMIN gate, mirroring the rest of onboarding.
        const calls = src.match(/assertCanManageOnboarding\(ctx\)/g) ?? [];
        expect(calls.length).toBeGreaterThanOrEqual(3);
    });
});

describe('NIS2 onboarding step — component', () => {
    const src = read('src/components/onboarding/Nis2SelfAssessmentStep.tsx');

    it('renders the CC BY 4.0 attribution (licensing obligation)', () => {
        // Structural (the component imports next-intl ESM, so we read the
        // source rather than import it). The attribution constant must hold
        // the CC BY 4.0 credit AND be rendered in the JSX.
        expect(src).toMatch(/NIS2_ATTRIBUTION_TEXT\s*=[\s\S]*CC BY 4\.0/);
        expect(src).toMatch(/\{NIS2_ATTRIBUTION_TEXT\}/);
        expect(src).toContain('github.com/NISD2/nis2-gap-assessment-schema');
    });

    it('uses the platform primitives (Accordion / RadioGroup / InfoTooltip / StatusBadge)', () => {
        expect(src).toMatch(/from '@\/components\/ui\/accordion'/);
        expect(src).toMatch(/from '@\/components\/ui\/radio-group'/);
        expect(src).toMatch(/InfoTooltip/);
        expect(src).toMatch(/from '@\/components\/ui\/status-badge'/);
        // no hand-rolled radio/select
        expect(src).not.toMatch(/<input[^>]*type=["']radio/);
        expect(src).not.toMatch(/<select\b/);
    });

    it('autosaves each answer via PUT (no batch submit)', () => {
        expect(src).toMatch(/method:\s*'PUT'/);
    });

    it('is wired into the wizard with the conditional case', () => {
        const wiz = read('src/components/onboarding/OnboardingWizard.tsx');
        expect(wiz).toContain('Nis2SelfAssessmentStep');
        expect(wiz).toMatch(/case 'NIS2_SELF_ASSESSMENT'/);
        expect(wiz).toMatch(/computeVisibleSteps/);
    });
});
