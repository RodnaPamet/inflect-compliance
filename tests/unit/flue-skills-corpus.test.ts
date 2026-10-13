/**
 * THE SKILL CORPUS LOADS, AND ITS ALWAYS-PRESENT COST IS BOUNDED (#3470).
 *
 * Two different budgets, which the plan treated as one. Skills are
 * progressively disclosed: each mounted skill costs a catalog line — name plus
 * description — in EVERY system prompt on EVERY turn, and its instructions cost
 * nothing until the model activates it. Capping only "total skill payload"
 * bounds the rare case and leaves the per-turn cost unbounded, so both are
 * capped and the catalog one is asserted hardest.
 */
import {
    loadAllSkills,
    loadSkill,
    parseSkillDocument,
    catalogBytes,
    assertCatalogWithinBudget,
    SkillLoadError,
    MAX_CATALOG_BYTES,
    MAX_SKILL_BYTES,
    MAX_DESCRIPTION_CHARS,
    type LoadedSkill,
} from '@/lib/agentic/flue/skills';

describe('the Flue skill corpus', () => {
    const skills = loadAllSkills();

    it('loads every skill the corpus ships, and there are some', () => {
        // A loader that found nothing would pass every per-skill assertion
        // below vacuously.
        expect(skills.length).toBeGreaterThanOrEqual(6);
        expect(skills.map((s) => s.name).sort()).toEqual([
            'dora-register-duties',
            'eu-ai-act-classification',
            'evidence-sufficiency',
            'iso-27001-annex-a-drafting',
            'nis2-article-23-timelines',
            'soa-authoring',
        ]);
    });

    it.each([...skills.map((s) => [s.name, s] as const)])(
        '%s satisfies the Agent Skills frontmatter spec',
        (_name, skill) => {
            const s = skill as LoadedSkill;
            expect(s.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
            expect(s.name.length).toBeLessThanOrEqual(64);
            expect(s.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
            // The description carries the entire routing decision, so it must
            // say WHEN to use the skill, not only what it is.
            expect(s.description).toMatch(/Use when/i);
            expect(Buffer.byteLength(s.instructions, 'utf8')).toBeLessThanOrEqual(MAX_SKILL_BYTES);
        },
    );

    it('every skill declares a licence — an unlicensed skill cannot be audited', () => {
        for (const s of skills) expect(s.license).not.toBe('');
    });

    it('no skill reproduces ISO Annex A control titles (#3478)', () => {
        // The owner's decision: cite control IDENTIFIERS, never the standard's
        // own titles. Spot-checked against real Annex A titles, so this fails
        // if someone later pastes them in for convenience.
        const isoTitles = [
            'Policies for information security',
            'Information security roles and responsibilities',
            'Threat intelligence',
            'Information deletion',
            'Data masking',
        ];
        for (const s of skills) {
            for (const title of isoTitles) {
                expect(s.instructions.toLowerCase()).not.toContain(title.toLowerCase());
            }
        }
    });

    it('the ALWAYS-PRESENT catalog fits its budget, and the budget is real', () => {
        const bytes = catalogBytes(skills);
        expect(bytes).toBeGreaterThan(0);
        expect(bytes).toBeLessThanOrEqual(MAX_CATALOG_BYTES);
        // eslint-disable-next-line no-console
        console.log(`#3470 — skill catalog: ${bytes}/${MAX_CATALOG_BYTES} bytes across ${skills.length} skills`);
    });

    it('refuses a catalog that would exceed the per-turn budget', () => {
        // The positive control. Without it, a budget check over a corpus that
        // happens to fit asserts nothing about the check.
        const bloated: LoadedSkill[] = Array.from({ length: 40 }, (_, i) => ({
            ...skills[0],
            name: `filler-${i}`,
            description: 'x'.repeat(200),
        }));
        expect(() => assertCatalogWithinBudget(bloated)).toThrow(SkillLoadError);
        expect(() => assertCatalogWithinBudget(bloated)).toThrow(/every turn/);
    });

    it('refuses a skill whose frontmatter name does not match its directory', () => {
        // A copied skill that kept its old name is a load error rather than a
        // silently renamed one — the spec requires the two to agree.
        const doc = '---\nname: other\ndescription: Use when testing.\nlicense: proprietary\n---\nbody';
        expect(() => parseSkillDocument('mine', doc)).toThrow(/does not match its directory/);
    });

    it('refuses a skill that declares no licence', () => {
        const doc = '---\nname: mine\ndescription: Use when testing.\n---\nbody';
        expect(() => parseSkillDocument('mine', doc)).toThrow(/license is required/);
    });

    it('refuses a description over the spec ceiling, and an empty one', () => {
        const long = '---\nname: mine\ndescription: ' + 'x'.repeat(1100) + '\nlicense: p\n---\nbody';
        expect(() => parseSkillDocument('mine', long)).toThrow(/description exceeds/);
        const none = '---\nname: mine\ndescription:\nlicense: p\n---\nbody';
        expect(() => parseSkillDocument('mine', none)).toThrow(/description is required/);
    });

    it('refuses instructions over the per-skill budget, and empty ones', () => {
        const fat = '---\nname: mine\ndescription: Use when testing.\nlicense: p\n---\n' + 'x'.repeat(9000);
        expect(() => parseSkillDocument('mine', fat)).toThrow(/instructions exceed/);
        const empty = '---\nname: mine\ndescription: Use when testing.\nlicense: p\n---\n   ';
        expect(() => parseSkillDocument('mine', empty)).toThrow(/instructions are empty/);
    });

    it('refuses a missing skill directory', () => {
        expect(() => loadSkill('does-not-exist')).toThrow(/could not read SKILL.md/);
    });
});

describe('resolving a workflow definition\'s declared skills', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveSkillsFor, resetSkillCache } = require('@/lib/agentic/flue/skills/resolve');
    beforeEach(() => resetSkillCache());

    it('resolves declared names to documents the binding can carry', () => {
        const got = resolveSkillsFor(['soa-authoring', 'evidence-sufficiency']);
        expect(got.map((s: { name: string }) => s.name)).toEqual(['soa-authoring', 'evidence-sufficiency']);
        // DOCUMENTS, not references — the agent receives text it cannot widen,
        // never the ability to go and read a seventh skill off disk.
        expect(Object.keys(got[0]).sort()).toEqual(['description', 'instructions', 'name']);
    });

    it('declaring nothing resolves to nothing, without touching the corpus', () => {
        expect(resolveSkillsFor(undefined)).toEqual([]);
        expect(resolveSkillsFor([])).toEqual([]);
    });

    it('FAILS CLOSED on a skill the corpus does not ship', () => {
        // Dropping it and carrying on would give the run quietly less expertise
        // than its definition claims — a defect that surfaces as a bad answer
        // rather than as a failure.
        expect(() => resolveSkillsFor(['no-such-skill'])).toThrow(/not in the shipped corpus/);
    });

    it('a definition mounting everything still pays a bounded per-turn cost', () => {
        const all = loadAllSkills().map((s) => s.name);
        expect(() => resolveSkillsFor(all)).not.toThrow();
    });
});
