/**
 * AI-governance onboarding-step framework-gate ratchet.
 *
 * The conditional AI_GOVERNANCE_SELF_ASSESSMENT step appears when an AI
 * framework is among the selected frameworks (or the company AI-systems flag
 * is set) — analogous to NIS2 → NIS2_SELF_ASSESSMENT. Since the framework
 * picker became data-driven (it now feeds the *canonical DB framework keys*
 * into the gate), the gate's hand-maintained `AI_FWS` set MUST stay in sync
 * with the keys the catalogue actually writes. A drift — renaming an AI
 * framework key without updating the gate, or the two gate copies (client +
 * server) diverging — would silently stop the step from appearing.
 *
 * ═══ WHAT WAS WRONG ═══
 *
 * The "%s is a real framework key" case read `prisma/seed.ts` and looked for
 * the literal. `prisma/seed.ts` is not run on a production deploy, so that
 * assertion could not fail while the key it named was undeliverable — and it
 * would fail on the change that FIXED delivery, because a converted framework
 * declares its key in a CatalogFile instead. Five guards in this suite have
 * already reddened exactly that way, each on the commit that first made its
 * framework reachable.
 *
 * The question the gate actually cares about is "does anything the product
 * applies declare this key?", so that is what is asked now, via
 * `declaringSources` — which spans `prisma/seed.ts` AND every fixture a
 * production seeder applies. The case therefore survives a conversion instead
 * of being broken by it.
 *
 * ═══ WHAT IS HONESTLY NOT ASSERTED ═══
 *
 * None of these three frameworks has a CatalogFile today: OWASP-AISVS,
 * ISO42001 and EU-AI-ACT are hand-rolled in `prisma/seed.ts`, so no production
 * writer creates them. Asserting production delivery here would assert
 * something false. The CatalogFile case below therefore arms itself only when
 * a catalogue appears, and records the dev-only reality until then.
 *
 * This locks the linkage end-to-end:
 *   - every AI framework key is declared by something the product applies,
 *   - selecting it makes the step applicable (server gate, behavioural),
 *   - the client + server AI_FWS sets are identical and recognise each key.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isStepApplicable } from '@/app-layer/usecases/onboarding';

import {
    appliedCatalogFor,
    appliedCatalogueStats,
    declaringSources,
    productionDeclaringSources,
} from '../helpers/applied-catalogue';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const STEP = 'AI_GOVERNANCE_SELF_ASSESSMENT';

/** The dev-only seeder, named once so the null-catalogue branch can say so. */
const DEV_SEEDER = 'prisma/seed.ts';

// The canonical AI-framework keys as written into the global Framework table.
// Cross-checked against the applied catalogue below, so a rename on either
// delivery path fails CI here first — forcing this list AND the gate set to be
// updated together.
const AI_FRAMEWORK_KEYS = ['OWASP-AISVS', 'ISO42001', 'EU-AI-ACT'];

describe('AI-governance step — declared keys drive the gate', () => {
    it('the applied catalogue is non-empty', () => {
        // DENOMINATOR. A scan that found no seeders and no fixtures would make
        // every key case below assert against an empty corpus and pass.
        const stats = appliedCatalogueStats();
        expect(stats.seeders.length).toBeGreaterThanOrEqual(5);
        expect(stats.fixtures.length).toBeGreaterThanOrEqual(7);
        expect(stats.bytes).toBeGreaterThan(0);
    });

    it.each(AI_FRAMEWORK_KEYS)('%s is declared by a source the product applies', (key) => {
        // Delivery-path agnostic on purpose: seed.ts today, a CatalogFile the
        // day one lands. Either answer is a real declaration of the key.
        expect(declaringSources(key).length).toBeGreaterThan(0);
    });

    it.each(AI_FRAMEWORK_KEYS)('%s: an applied CatalogFile, where one exists, declares exactly this key', (key) => {
        const catalog = appliedCatalogFor(key);
        if (catalog === null) {
            // No CatalogFile for any AI framework yet — see the docblock. The
            // key is dev-seeded, which is what this records rather than
            // pretending to a production writer that does not exist.
            expect(declaringSources(key)).toContain(DEV_SEEDER);
            return;
        }
        expect(catalog.framework.key).toBe(key);
        expect(catalog.requirements.length).toBeGreaterThan(0);
        expect(productionDeclaringSources(key)).toContain(catalog.file);
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
