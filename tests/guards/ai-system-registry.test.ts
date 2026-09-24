/**
 * EU AI Act AI-System Registry — ratchet.
 *
 * Locks the load-bearing invariants of the registry:
 *   - CLASSIFICATION CORRECTNESS: the deterministic classifier maps the Act's
 *     tiers correctly and cites the driving clause id.
 *   - MAPPING VALIDITY: every requirement code in the tier→obligation map
 *     resolves in IC's seeded AI-Act / ISO 42001 library (no dangling refs).
 *   - PROPOSE-NOT-COMMIT: the conformity generator drafts artifacts through the
 *     approval queue and makes NO direct policy create/publish call.
 *   - AiSystem carries the tenantId-leading index; free-text fields are in the
 *     Epic B manifest AND routed through sanitize.
 *   - AGPL tripwire: no AegisAI-derived code/text/model anywhere in the feature.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    classifyAiSystem,
    ART5_PROHIBITED_PRACTICES,
    ANNEX_III_AREAS,
    ART50_TRANSPARENCY_CASES,
} from '@/lib/eu-ai-act/classification';
import { TIER_OBLIGATIONS, allObligationRefs } from '@/lib/eu-ai-act/obligations';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { codeOf, commentsOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// Masked at the READ seam (#2246 Class A): comments blanked, string
// literals kept, offsets preserved — so a token that survives only in
// a comment can no longer satisfy an assertion below.
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
// `readRawJson` stays RAW: JSON fixtures are parsed, not asserted on, so
// masking has no meaning for them.
const readRawJson = (rel: string) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as { key: string }[];
// `readProvenance` is the INVERSE mask, not a raw read (#2246). The Regulation
// citation below IS a comment, so `codeOf` would delete the thing under test —
// but the answer to that is `commentsOf`, which blanks the CODE and keeps the
// comments, not to read the whole file. Measured on both files: the citation
// counts 1 raw and 1 through `commentsOf`, and 0 through `codeOf`. The reach
// drops from the whole file to its comment text, so a future `'Regulation (EU)
// 2024/1689'` appearing in a string literal cannot satisfy an assertion whose
// subject is the provenance docblock.
const readProvenance = (rel: string) => commentsOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

describe('classification correctness (authored from the Act)', () => {
    it('Article 5 practice → PROHIBITED, citing the clause', () => {
        const r = classifyAiSystem({ prohibitedPractice: 'social_scoring' });
        expect(r.tier).toBe('PROHIBITED');
        expect(r.clauseId).toBe('Art.5(1)(c)');
        expect(r.rationale).toContain('Art.5(1)(c)');
    });

    it('Annex III use-case → HIGH, citing the Annex III item', () => {
        const r = classifyAiSystem({ annexIIIArea: 'employment' });
        expect(r.tier).toBe('HIGH');
        expect(r.clauseId).toBe('Annex III(4)');
        expect(r.rationale).toContain('Annex III(4)');
    });

    it('Article 6(1) product-safety component → HIGH', () => {
        const r = classifyAiSystem({ isAnnexIProductSafetyComponent: true });
        expect(r.tier).toBe('HIGH');
        expect(r.clauseId).toBe('Art.6(1)');
    });

    it('Article 50 transparency case → LIMITED, citing the clause', () => {
        const r = classifyAiSystem({ transparencyCase: 'direct_interaction' });
        expect(r.tier).toBe('LIMITED');
        expect(r.clauseId).toBe('Art.50(1)');
    });

    it('nothing triggered → MINIMAL (Art 95)', () => {
        const r = classifyAiSystem({});
        expect(r.tier).toBe('MINIMAL');
        expect(r.clauseId).toBe('Art.95');
    });

    it('strict precedence: a prohibited practice beats an Annex III area', () => {
        const r = classifyAiSystem({ prohibitedPractice: 'social_scoring', annexIIIArea: 'employment', transparencyCase: 'direct_interaction' });
        expect(r.tier).toBe('PROHIBITED');
    });

    it('every questionnaire option produces a non-empty clause + rationale', () => {
        for (const o of ART5_PROHIBITED_PRACTICES) {
            const r = classifyAiSystem({ prohibitedPractice: o.id });
            expect(r.tier).toBe('PROHIBITED');
            expect(r.clauseId.length).toBeGreaterThan(0);
        }
        for (const o of ANNEX_III_AREAS) {
            const r = classifyAiSystem({ annexIIIArea: o.id });
            expect(r.tier).toBe('HIGH');
        }
        for (const o of ART50_TRANSPARENCY_CASES) {
            const r = classifyAiSystem({ transparencyCase: o.id });
            expect(r.tier).toBe('LIMITED');
        }
    });
});

describe('mapping validity — no dangling requirement refs', () => {
    const euCodes = new Set(readRawJson('prisma/fixtures/eu_ai_act_requirements.json').map((r) => r.key));
    const isoCodes = new Set(readRawJson('prisma/fixtures/iso_42001_requirements.json').map((r) => r.key));

    it('every tier obligation resolves in the seeded AI-Act / ISO 42001 library', () => {
        const dangling: string[] = [];
        for (const ref of allObligationRefs()) {
            const set = ref.framework === 'EU-AI-ACT' ? euCodes : isoCodes;
            if (!set.has(ref.code)) dangling.push(`${ref.framework}:${ref.code}`);
        }
        expect(dangling).toEqual([]);
    });

    it('HIGH pulls the full obligation set; LIMITED pulls transparency', () => {
        const highEu = TIER_OBLIGATIONS.HIGH.filter((r) => r.framework === 'EU-AI-ACT').map((r) => r.code);
        // Art 9–17, 26, 27 all present.
        for (const c of ['Art.9', 'Art.11', 'Art.12', 'Art.14', 'Art.15', 'Art.26', 'Art.27']) {
            expect(highEu).toContain(c);
        }
        expect(TIER_OBLIGATIONS.LIMITED.some((r) => r.code === 'Art.50')).toBe(true);
        expect(TIER_OBLIGATIONS.PROHIBITED.some((r) => r.code === 'Art.5')).toBe(true);
    });
});

describe('propose-not-commit — conformity generator', () => {
    const gen = read('src/app-layer/usecases/ai-system-conformity.ts');

    it('routes drafts through the approval queue (createAgentProposal)', () => {
        expect(gen).toContain('createAgentProposal(');
    });

    it('makes NO direct policy create/publish call', () => {
        // Bare (import-stripped) source must not call these — a draft is never
        // committed/published by the generator.
        const body = gen.replace(/^import[^;]*;/gm, '');
        expect(body).not.toMatch(/\bcreatePolicy\s*\(/);
        expect(body).not.toMatch(/\bcreatePolicyVersion\s*\(/);
        expect(body).not.toMatch(/\bpublishPolicy\s*\(/);
    });
});

describe('schema + security wiring', () => {
    // `.prisma` is lexable — its comments are `//` and its strings are
    // double-quoted — so the concatenated schema is masked too.
    const schema = codeOf(readPrismaSchema());
    const manifest = read('src/lib/security/encrypted-fields.ts');
    const usecase = read('src/app-layer/usecases/ai-system.ts');

    it('AiSystem carries the tenantId-leading riskTier index', () => {
        expect(schema).toMatch(/model AiSystem \{[\s\S]*?@@index\(\[tenantId, riskTier\]\)/);
    });

    it('free-text fields are in the Epic B manifest', () => {
        expect(manifest).toMatch(/AiSystem:\s*\[[^\]]*'purpose'[^\]]*'useContext'/);
    });

    it('the usecase sanitises free text before persisting', () => {
        expect(usecase).toContain("from '@/lib/security/sanitize'");
        expect(usecase).toContain('sanitizePlainText(');
    });
});

describe('AGPL tripwire — no AegisAI-derived material', () => {
    const files = [
        'src/lib/eu-ai-act/classification.ts',
        'src/lib/eu-ai-act/obligations.ts',
        'src/app-layer/usecases/ai-system.ts',
        'src/app-layer/usecases/ai-system-conformity.ts',
        'src/app-layer/repositories/AiSystemRepository.ts',
        'src/app-layer/schemas/ai-system.schemas.ts',
    ];
    it('none of the feature files reference AegisAI', () => {
        const offenders = files.filter((f) => /aegis/i.test(read(f)));
        expect(offenders).toEqual([]);
    });
    it('the domain modules cite the Regulation as provenance', () => {
        // `readProvenance` masks with `commentsOf`. The citation is a
        // docblock line in both files — the subject is the COMMENT, so the
        // reader keeps comments and blanks code rather than reading raw.
        expect(readProvenance('src/lib/eu-ai-act/classification.ts')).toContain(
            'Regulation (EU) 2024/1689',
        );
        expect(readProvenance('src/lib/eu-ai-act/obligations.ts')).toContain(
            'Regulation (EU) 2024/1689',
        );
    });
});
