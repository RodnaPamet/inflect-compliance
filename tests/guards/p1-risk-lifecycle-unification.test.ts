/**
 * P1 — Risk lifecycle unification (create → assess → treat → monitor →
 * status as ONE coherent process).
 *
 * Locks the structural pieces the refactor introduced so a later
 * "simplify" PR can't silently re-scatter the flow or re-fork the
 * treatment vocabulary:
 *
 *   1. ONE canonical treatment vocabulary — the decision↔strategy map is
 *      single-sourced and correct (TREAT↔MITIGATE, TOLERATE↔ACCEPT).
 *   2. The shared options render the canonical labels against the
 *      enum-valid TreatmentDecision values.
 *   3. Step 4 (treat & monitor) exists in the guided assessment panel and
 *      mounts the treatment-plan card there (not scattered on Overview).
 *   4. The treatment-plan owner CTA is wired to a real roster (no
 *      `ownerChoices={[]}`).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    DECISION_TO_STRATEGY,
    TREATMENT_DECISION_META,
    canonicalTreatmentLabelEN,
} from '@/lib/risk-treatment-vocabulary';
import { buildRiskTreatmentOptions } from '@/app/t/[tenantSlug]/(app)/risks/_shared/risk-options';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
//
// LANGUAGE SPLIT. One seam here carries two things. TypeScript-alikes go
// through `read` and are masked. The JSON fixtures go through `readRaw` and
// are NOT: a JSON read is PARSED as data, never matched as text, so masking it
// would only corrupt the parse — `codeOf` lexes TypeScript and a catalogue is
// not that language.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const read = (rel: string) => codeOf(readRaw(rel));
const PANEL = 'src/app/t/[tenantSlug]/(app)/risks/[riskId]/RiskAssessmentPanel.tsx';
const PAGE = 'src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx';

describe('P1 — one canonical treatment vocabulary', () => {
    it('maps each decision to the ISO-current strategy', () => {
        expect(DECISION_TO_STRATEGY).toEqual({
            TREAT: 'MITIGATE',
            TOLERATE: 'ACCEPT',
            TRANSFER: 'TRANSFER',
            AVOID: 'AVOID',
        });
    });

    it('canonical labels read Mitigate/Accept/Transfer/Avoid (not the 4-T words)', () => {
        expect(canonicalTreatmentLabelEN('TREAT')).toBe('Mitigate');
        expect(canonicalTreatmentLabelEN('TOLERATE')).toBe('Accept');
        expect(canonicalTreatmentLabelEN('TRANSFER')).toBe('Transfer');
        expect(canonicalTreatmentLabelEN('AVOID')).toBe('Avoid');
        expect(canonicalTreatmentLabelEN(null)).toBeNull();
    });

    it('options carry enum-valid TreatmentDecision values with canonical label keys', () => {
        const opts = buildRiskTreatmentOptions((k) => k); // identity → returns the key
        expect(opts.map((o) => o.value)).toEqual(['TREAT', 'TOLERATE', 'TRANSFER', 'AVOID']);
        // label resolves through the canonical i18n keys, not the legacy
        // treat/tolerate copy.
        expect(opts.map((o) => o.label)).toEqual([
            'treatmentMitigate',
            'treatmentAccept',
            'treatmentTransfer',
            'treatmentAvoid',
        ]);
    });

    it('the canonical i18n keys exist in both catalogs', () => {
        const en = JSON.parse(readRaw('messages/en.json')).risks;
        const bg = JSON.parse(readRaw('messages/bg.json')).risks;
        for (const meta of Object.values(TREATMENT_DECISION_META)) {
            expect(typeof en[meta.labelKey]).toBe('string');
            expect(typeof bg[meta.labelKey]).toBe('string');
        }
    });
});

describe('P1 — Step 4 (treat & monitor) lives in the guided flow', () => {
    const panel = read(PANEL);

    it('the assessment panel renders a Step 4 card', () => {
        expect(panel).toMatch(/assessment\.step4/);
        expect(panel).toMatch(/id="assessment-treat-monitor"/);
    });

    it('Step 4 continues into treatment decision + review cadence + guided status', () => {
        expect(panel).toMatch(/id="treatment-decision-select"/);
        expect(panel).toMatch(/id="save-review-date-btn"/);
        expect(panel).toMatch(/data-testid="guided-status"/);
    });

    it('the treatment-plan card is mounted inside the assessment panel', () => {
        expect(panel).toMatch(/RiskTreatmentPlanCard/);
    });
});

describe('P1 — treatment-plan owner CTA is fillable', () => {
    const page = read(PAGE);

    it('no dead empty owner roster remains', () => {
        expect(page).not.toMatch(/ownerChoices=\{\[\]\}/);
    });

    it('a real roster is derived and passed to the assessment panel', () => {
        expect(page).toMatch(/treatmentOwnerChoices/);
        expect(page).toMatch(/ownerChoices=\{treatmentOwnerChoices\}/);
    });
});
