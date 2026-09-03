/**
 * AI-governance onboarding-step framework-gate ratchet.
 *
 * The conditional AI_GOVERNANCE_SELF_ASSESSMENT step appears when an AI
 * framework is among the selected frameworks (or the company AI-systems flag
 * is set) — analogous to NIS2 → NIS2_SELF_ASSESSMENT. Since the framework
 * picker became data-driven (it now feeds the *canonical DB framework keys*
 * into the gate), the gate's hand-maintained `AI_FWS` set MUST stay in sync
 * with the keys the seed actually writes. A drift — renaming an AI framework
 * key in the seed without updating the gate, or the two gate copies (client +
 * server) diverging — would silently stop the step from appearing.
 *
 * This locks the linkage end-to-end:
 *   - every seeded AI framework key is a real key in the seed,
 *   - selecting it makes the step applicable (server gate, behavioural),
 *   - the client + server AI_FWS sets are identical and recognise each key.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isStepApplicable } from '@/app-layer/usecases/onboarding';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const STEP = 'AI_GOVERNANCE_SELF_ASSESSMENT';

// The canonical AI-framework keys as seeded into the global Framework table.
// Cross-checked against prisma/seed.ts below, so a seed-side rename fails CI
// here first — forcing this list AND the gate set to be updated together.
const AI_FRAMEWORK_KEYS = ['OWASP-AISVS', 'ISO42001', 'EU-AI-ACT'];

describe('AI-governance step — seeded keys drive the gate', () => {
    const seed = read('prisma/seed.ts');

    it.each(AI_FRAMEWORK_KEYS)('%s is a real framework key in the seed', (key) => {
        expect(seed).toContain(`'${key}'`);
    });

    it.each(AI_FRAMEWORK_KEYS)('selecting %s makes the step applicable (server gate)', (key) => {
        const data = { FRAMEWORK_SELECTION: { selectedFrameworks: [key] } };
        expect(isStepApplicable(STEP as never, data)).toBe(true);
    });

    it('a lowercase legacy value still resolves (case-insensitive gate)', () => {
        const data = { FRAMEWORK_SELECTION: { selectedFrameworks: ['owasp-aisvs'] } };
        expect(isStepApplicable(STEP as never, data)).toBe(true);
    });

    it('the step is NOT applicable without an AI framework or the AI-systems flag', () => {
        expect(isStepApplicable(STEP as never, { FRAMEWORK_SELECTION: { selectedFrameworks: ['ISO27001', 'NIS2'] } })).toBe(false);
        expect(isStepApplicable(STEP as never, {})).toBe(false);
    });

    it('the company AI-systems flag still triggers the step on its own', () => {
        expect(isStepApplicable(STEP as never, { COMPANY_PROFILE: { usesAiSystems: true } })).toBe(true);
    });
});

describe('AI-governance step — client + server gates stay in sync', () => {
    function extractAiFws(src: string): Set<string> | null {
        const m = src.match(/AI_FWS\s*=\s*new Set\(\[([^\]]*)\]\)/);
        if (!m) return null;
        return new Set(
            m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean),
        );
    }

    const clientSet = extractAiFws(read('src/components/onboarding/OnboardingWizard.tsx'));
    const serverSet = extractAiFws(read('src/app-layer/usecases/onboarding.ts'));

    it('both gates declare an AI_FWS set', () => {
        expect(clientSet).not.toBeNull();
        expect(serverSet).not.toBeNull();
    });

    it('the two AI_FWS sets are identical', () => {
        expect([...(clientSet ?? [])].sort()).toEqual([...(serverSet ?? [])].sort());
    });

    it.each(AI_FRAMEWORK_KEYS)('the client gate set recognises %s after normalisation', (key) => {
        const normalised = key.toUpperCase().replace(/\s+/g, '');
        expect(clientSet?.has(normalised)).toBe(true);
    });
});
