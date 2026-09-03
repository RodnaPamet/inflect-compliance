/**
 * Unified AI-governance self-assessment ratchet.
 *
 * One 30-question onboarding self-assessment whose answers project onto AISVS,
 * ISO 42001 and the EU AI Act ("one assessment, three readouts"). Mirrors the
 * NIS2 self-assessment. This guard locks:
 *   - the fixture has exactly 30 questions across 7 domains, each mapping to ≥1
 *     standard;
 *   - LICENSE: questions are paraphrased (not verbatim AISVS prose); ISO 42001
 *     mappings are clause NUMBERS only; the attribution + not-legal-advice
 *     disclaimer are present;
 *   - the conditional onboarding step is denominator-excluded when no AI
 *     framework / AI-systems flag is set;
 *   - the 3-way coverage readout projects an answer onto EVERY mapped standard;
 *   - conditional (RAG / AGENTIC) questions auto-N/A by architecture;
 *   - gap→finding is explicit, via the existing createFinding, idempotent;
 *   - the tenant models carry RLS + an encrypted `note` + tenant indexes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

import { computeAiGovCoverage, type AiGovScoredQuestion } from '@/app-layer/services/ai-gov-coverage';

const ROOT = path.resolve(__dirname, '../..');
// codeOf() masks comments at the READ SEAM (#2246), so a COMMENT naming a
// thing cannot satisfy an assertion meant to be about CODE. Masking is the
// DEFAULT (`read`) so a new assertion inherits it; `readRaw` is for the files
// where a `//` is content rather than a comment — the `https://` of a URL in
// YAML / JSON / Markdown — and masking would delete real text.
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));

const fixture = JSON.parse(readRaw('prisma/fixtures/ai-governance-self-assessment.json')) as {
    questionSetVersion: number; attribution: string; disclaimer: string;
    domains: Array<{ id: number; code: string; name: string }>;
    questions: Array<{ id: string; domainId: number; criticality: string; conditional: string | null; text: string; mappings: { aisvs: string[]; iso42001: string[]; euAiAct: string[] } }>;
};

describe('AI-governance self-assessment fixture', () => {
    it('has exactly 30 questions across 7 domains', () => {
        expect(fixture.questions).toHaveLength(30);
        expect(fixture.domains).toHaveLength(7);
        expect(new Set(fixture.domains.map((d) => d.id))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
        // Every question hangs off a real domain.
        const domainIds = new Set(fixture.domains.map((d) => d.id));
        for (const q of fixture.questions) expect(domainIds.has(q.domainId)).toBe(true);
        // Unique ids.
        expect(new Set(fixture.questions.map((q) => q.id)).size).toBe(30);
    });

    it('every question maps to at least one standard + a valid criticality', () => {
        for (const q of fixture.questions) {
            const total = q.mappings.aisvs.length + q.mappings.iso42001.length + q.mappings.euAiAct.length;
            expect(total).toBeGreaterThanOrEqual(1);
            expect(['CRITICAL', 'HIGH', 'MEDIUM']).toContain(q.criticality);
        }
    });

    it('LICENSE: paraphrased questions (not verbatim prose); ISO 42001 mappings are clause numbers only', () => {
        for (const q of fixture.questions) {
            expect(q.text.split(/\s+/).length).toBeLessThanOrEqual(45); // a question, not a clause dump
            for (const clause of q.mappings.iso42001) {
                // Clause/Annex numbers only — never embedded ISO prose.
                expect(clause).toMatch(/^(\d+(\.\d+)*|A\.\d+(\.\d+)*)$/);
            }
        }
    });

    it('carries the OWASP CC-BY-SA-4.0 attribution + the not-legal-advice disclaimer', () => {
        expect(fixture.attribution).toMatch(/CC-BY-SA-4\.0/);
        expect(fixture.attribution).toMatch(/OWASP/);
        expect(fixture.disclaimer).toMatch(/not legal advice/i);
    });

    it('has exactly two conditional questions (RAG + AGENTIC)', () => {
        const conds = fixture.questions.filter((q) => q.conditional).map((q) => q.conditional).sort();
        expect(conds).toEqual(['AGENTIC', 'RAG']);
    });
});

describe('AI-governance onboarding step (conditional + denominator-excluded)', () => {
    const onboarding = read('src/app-layer/usecases/onboarding.ts');
    it('adds AI_GOVERNANCE_SELF_ASSESSMENT as a conditional step', () => {
        expect(onboarding).toContain("'AI_GOVERNANCE_SELF_ASSESSMENT'");
        expect(onboarding).toMatch(/step === 'AI_GOVERNANCE_SELF_ASSESSMENT'/);
        // Gated on AI framework selection OR an AI-systems flag.
        expect(onboarding).toMatch(/AISVS|ISO42001|EU_AI_ACT/);
        expect(onboarding).toMatch(/usesAiSystems/);
    });
});

describe('AI-governance 3-way coverage readout', () => {
    it('projects one answer onto every standard it maps to', () => {
        const qs: AiGovScoredQuestion[] = [
            // maps to all three; YES → credits all three (HIGH weight 3)
            { id: 'q1', domainId: 1, criticality: 'HIGH', mappings: { aisvs: ['C2'], iso42001: ['8.2'], euAiAct: ['Art.15'] }, answer: 'YES' },
            // ISO + EU only; NO → 0 credit (CRITICAL weight 4)
            { id: 'q2', domainId: 1, criticality: 'CRITICAL', mappings: { aisvs: [], iso42001: ['6.1'], euAiAct: ['Art.6'] }, answer: 'NO' },
            // AISVS only; PARTIALLY → half credit (MEDIUM weight 2)
            { id: 'q3', domainId: 2, criticality: 'MEDIUM', mappings: { aisvs: ['C6'], iso42001: [], euAiAct: [] }, answer: 'PARTIALLY' },
            // NA → excluded everywhere
            { id: 'q4', domainId: 2, criticality: 'HIGH', mappings: { aisvs: ['C8'], iso42001: ['8.2'], euAiAct: [] }, answer: 'NA' },
        ];
        const r = computeAiGovCoverage(qs);
        // AISVS: q1 (3*1) + q3 (2*0.5) credited = 4 over q1(3)+q3(2)=5 → 80%
        expect(r.aisvs.percent).toBe(80);
        // ISO 42001: q1 (3*1) over q1(3)+q2(4)=7 → 43%
        expect(r.iso42001.percent).toBe(43);
        // EU AI Act: q1 (3*1) over q1(3)+q2(4)=7 → 43%
        expect(r.euAiAct.percent).toBe(43);
        // q2 is a CRITICAL NO → flagged legal-exposure gap.
        expect(r.criticalGaps).toEqual(['q2']);
    });
});

describe('AI-governance gap→finding + RLS/encryption/index', () => {
    const usecase = read('src/app-layer/usecases/ai-gov-self-assessment.ts');

    it('raises findings via the existing createFinding usecase, idempotently', () => {
        expect(usecase).toMatch(/import\s*\{\s*createFinding\s*\}\s*from\s*'\.\/finding'/);
        expect(usecase).toContain('AI_GOV_SELF_ASSESSMENT'); // deterministic marker
        expect(usecase).not.toMatch(/db\.finding\.create|prisma\.finding\.create/);
    });

    it('conditional questions auto-resolve to N/A by architecture', () => {
        expect(usecase).toMatch(/conditionalApplies/);
        expect(usecase).toMatch(/'NA'/);
    });

    it('the tenant models carry RLS + an encrypted note', () => {
        const migration = readRaw('prisma/migrations/20260629140000_add_ai_gov_self_assessment/migration.sql');
        for (const t of ['AiGovSelfAssessment', 'AiGovSelfAssessmentAnswer']) {
            expect(migration).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
            expect(migration).toMatch(new RegExp(`CREATE POLICY tenant_isolation ON "${t}"`));
        }
        expect(read('src/lib/security/encrypted-fields.ts')).toMatch(/AiGovSelfAssessmentAnswer:\s*\['note'\]/);
    });
});
