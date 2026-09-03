/**
 * Digital Sovereignty Posture self-assessment ratchet.
 *
 * One 30-question getting-started self-assessment (6 sovereignty dimensions ×
 * 5 questions) surfaced in onboarding. Mirrors the AI-governance + NIS2
 * self-assessment ratchets. This guard locks:
 *   - the bank shape: exactly 6 dimensions, 5 questions each (30 total), each
 *     question with exactly 5 ordered options scored 0..4, and unique ids;
 *   - LICENSE / positioning: every dimension is clause-REFERENCED (short
 *     identifiers, never regulatory prose), carries a suggestion template, and
 *     the source module states the not-legal-advice + attribution discipline;
 *   - the propose-not-commit boundary: the pure scorer imports NO usecase and
 *     calls NO create-usecase; only the usecase commits, gated by an explicit
 *     per-dimension approval and dedupe;
 *   - the materialize route is error-wrapped + re-scores server-side.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

import {
    DIGITAL_SOVEREIGNTY_ASSESSMENT,
    SOVEREIGNTY_MATURITY_BANDS,
    SOVEREIGNTY_GAP_THRESHOLD,
} from '@/data/self-assessments/digital-sovereignty';
import { isStepApplicable } from '@/app-layer/usecases/onboarding';
import { ONBOARDING_STEPS, SKIPPABLE_STEPS } from '@/lib/schemas/onboarding';

const ROOT = path.resolve(__dirname, '../..');

const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// codeOf() masks comments at the READ SEAM (#2246) — masking is the DEFAULT so
// a new assertion inherits it, rather than each call site having to remember.
// `.json` is read raw (it has no comments, and a `//` inside a string is a URL).
// The ONE assertion that is deliberately about prose — the attribution +
// not-legal-advice banner in the digital-sovereignty docblock — calls
// `readRaw` explicitly, which is what makes that intent visible.
const read = (rel: string) => codeOf(readRaw(rel));

const DATA = 'src/data/self-assessments/digital-sovereignty.ts';
const SCORING = 'src/lib/self-assessments/scoring.ts';
const USECASE = 'src/app-layer/usecases/self-assessment.ts';
const ROUTE = 'src/app/api/t/[tenantSlug]/onboarding/sovereignty-assessment/materialize/route.ts';
const STEP = 'SOVEREIGNTY_SELF_ASSESSMENT';

describe('Digital Sovereignty self-assessment bank', () => {
    it('has exactly 6 dimensions, 5 questions each (30 total), with unique ids', () => {
        const dims = DIGITAL_SOVEREIGNTY_ASSESSMENT.dimensions;
        expect(dims).toHaveLength(6);
        expect(new Set(dims.map((d) => d.id))).toEqual(new Set([1, 2, 3, 4, 5, 6]));

        const allQuestions = dims.flatMap((d) => d.questions);
        expect(allQuestions).toHaveLength(30);
        for (const d of dims) expect(d.questions).toHaveLength(5);

        const ids = allQuestions.map((q) => q.id);
        expect(new Set(ids).size).toBe(30);
    });

    it('every question has exactly 5 ordered options scored 0..4', () => {
        for (const d of DIGITAL_SOVEREIGNTY_ASSESSMENT.dimensions) {
            for (const q of d.questions) {
                expect(q.options).toHaveLength(5);
                expect(q.options.map((o) => o.score)).toEqual([0, 1, 2, 3, 4]);
                for (const o of q.options) expect(o.label.length).toBeGreaterThan(0);
            }
        }
    });

    it('LICENSE: dimensions are clause-REFERENCED (short identifiers, never prose)', () => {
        for (const d of DIGITAL_SOVEREIGNTY_ASSESSMENT.dimensions) {
            expect(d.clauseRefs.length).toBeGreaterThanOrEqual(1);
            for (const ref of d.clauseRefs) {
                // A citation, not a paragraph of regulatory text.
                expect(ref.split(/\s+/).length).toBeLessThanOrEqual(5);
            }
        }
    });

    it('every dimension carries a materialisable suggestion template', () => {
        for (const d of DIGITAL_SOVEREIGNTY_ASSESSMENT.dimensions) {
            expect(d.suggestion.riskTitle.length).toBeGreaterThan(0);
            expect(d.suggestion.controlName.length).toBeGreaterThan(0);
            expect(d.suggestion.clauseRef.length).toBeGreaterThan(0);
            expect(d.labelKey.length).toBeGreaterThan(0);
        }
    });

    it('has ordered, non-overlapping maturity bands and a gap threshold inside 0..4', () => {
        const maxes = SOVEREIGNTY_MATURITY_BANDS.map((b) => b.max);
        expect(maxes).toEqual([...maxes].sort((a, b) => a - b));
        expect(SOVEREIGNTY_GAP_THRESHOLD).toBeGreaterThan(0);
        expect(SOVEREIGNTY_GAP_THRESHOLD).toBeLessThan(4);
    });

    it('positions itself as a self-assessment aid, not legal advice', () => {
        // DELIBERATELY raw: the attribution + disclaimer live in the file's
        // docblock, so this is one of the few assertions that is ABOUT a
        // comment. Masking would (correctly) empty it — see the seam note.
        const src = readRaw(DATA);
        expect(src).toMatch(/not legal advice/i);
        // Attribution to the source model is present.
        expect(src).toMatch(/Digital-?Sovereignty-?Assessment-?Tool/i);
    });
});

describe('propose-not-commit boundary', () => {
    it('the scorer is PURE — it imports no usecase and calls no create-usecase', () => {
        const src = read(SCORING);
        expect(src).not.toMatch(/from '@\/app-layer\/usecases/);
        expect(src).not.toMatch(/createRisk|createControl/);
    });

    it('only the usecase commits — via createRisk / createControl, write-gated', () => {
        const src = read(USECASE);
        expect(src).toContain('assertCanWrite');
        expect(src).toContain('createRisk');
        expect(src).toContain('createControl');
        // Idempotent dedupe by category.
        expect(src).toContain('SELF_ASSESSMENT_CATEGORY');
    });

    it('the materialize route is error-wrapped and validates its body', () => {
        const src = read(ROUTE);
        expect(src).toContain('withApiErrorHandling');
        expect(src).toContain('MaterializeSelfAssessmentSchema');
    });
});

describe('Sovereignty onboarding step (DS-2)', () => {
    it('is registered after AI_GOVERNANCE_SELF_ASSESSMENT and before ASSET_SETUP', () => {
        const i = ONBOARDING_STEPS.indexOf(STEP as never);
        expect(i).toBeGreaterThan(-1);
        expect(ONBOARDING_STEPS[i - 1]).toBe('AI_GOVERNANCE_SELF_ASSESSMENT');
        expect(ONBOARDING_STEPS.indexOf('ASSET_SETUP' as never)).toBe(i + 1);
        // Mirrored in the usecase STEP_ORDER.
        expect(read('src/app-layer/usecases/onboarding.ts')).toContain(`'${STEP}'`);
    });

    it('is skippable', () => {
        expect(SKIPPABLE_STEPS).toContain(STEP);
    });

    it('is applicable ONLY when an EU digital-regulation framework is selected', () => {
        const eu = (fw: string) => ({ FRAMEWORK_SELECTION: { selectedFrameworks: [fw] } });
        for (const fw of ['NIS2', 'nis2', 'DORA', 'EU_AI_ACT', 'EU-AI-ACT']) {
            expect(isStepApplicable(STEP as never, eu(fw))).toBe(true);
        }
        // Non-EU frameworks and an empty selection exclude the step (denominator).
        expect(isStepApplicable(STEP as never, eu('SOC2'))).toBe(false);
        expect(isStepApplicable(STEP as never, eu('ISO27001'))).toBe(false);
        expect(isStepApplicable(STEP as never, {})).toBe(false);
    });

    it('the wizard mirrors the same gate + renders the step component', () => {
        const wiz = read('src/components/onboarding/OnboardingWizard.tsx');
        expect(wiz).toContain('SovereigntySelfAssessmentStep');
        expect(wiz).toMatch(/key === 'SOVEREIGNTY_SELF_ASSESSMENT'/);
        // The generic Continue button is suppressed (the step drives its own).
        expect(wiz).toMatch(/currentStep\.key !== 'SOVEREIGNTY_SELF_ASSESSMENT'/);
    });

    it('the step component uses platform primitives + carries the not-legal-advice disclaimer', () => {
        const src = read('src/components/onboarding/SovereigntySelfAssessmentStep.tsx');
        expect(src).toContain('@/components/ui/accordion');
        expect(src).toContain('@/components/ui/radio-group');
        // The disclaimer copy is localized via next-intl — the component
        // renders it through `t('sovereignty.disclaimer')` and the English
        // catalog holds the not-legal-advice text.
        expect(src).toMatch(/t\(['"]sovereignty\.disclaimer['"]\)/);
        const en = JSON.parse(readRaw('messages/en.json')) as { onboarding: { sovereignty: { disclaimer: string } } };
        expect(en.onboarding.sovereignty.disclaimer).toMatch(/not legal advice/i);
        // Imports the pure bank + scorer directly (stateless, client-scored).
        expect(src).toContain("@/data/self-assessments/digital-sovereignty");
        expect(src).toContain("@/lib/self-assessments/scoring");
    });
});
