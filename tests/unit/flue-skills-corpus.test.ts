/**
 * THE SKILL CORPUS LOADS, AND ITS ALWAYS-PRESENT COST IS BOUNDED (#3470).
 *
 * Two different budgets, which the plan treated as one. Skills are
 * progressively disclosed: each mounted skill costs a catalog line — name plus
 * description — in EVERY system prompt on EVERY turn, and its instructions cost
 * nothing until the model activates it. Capping only "total skill payload"
 * bounds the rare case and leaves the per-turn cost unbounded, so both are
 * capped and the catalog one is asserted hardest.
 *
 * ── THE MOUNT GATE IS MOCKED HERE, AND ONLY HERE ────────────────────────────
 *
 * The resolution tests below are about the resolver's mechanics — documents in,
 * unknown names refused, the per-turn budget — and the shipped skills have no
 * evaluation records until somebody runs `npm run skills:evaluate` against a
 * model. So the gate treats every skill as evaluated in this file. The gate
 * itself, and the corpus held to the REAL gate, are in
 * `tests/unit/agentic/skill-mount-gate.test.ts`.
 */
jest.mock('@/lib/agentic/flue/skills/mount-gate', () => {
    const actual = jest.requireActual('@/lib/agentic/flue/skills/mount-gate');
    const { skillContentHash } = jest.requireActual('@/lib/agentic/flue/skills/evaluation-record');
    return {
        ...actual,
        checkSkillMountable: (skill: { name: string; instructions: string; metadata: { version?: string } }) => ({
            ok: true,
            pin: { name: skill.name, version: skill.metadata.version ?? '', contentHash: skillContentHash(skill.instructions) },
        }),
    };
});

import {
    loadAllSkills,
    loadSkillCorpus,
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
import { listAgentSkills } from '@/app-layer/usecases/agent-skills';
import { assertWorkflowCatalogsWithinBudget, workflowCatalogs } from '@/lib/agentic/flue/skills/resolve';
import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';

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
            'harness-level-assessment',
            'iso-27001-annex-a-drafting',
            'nhi-ownership-attribution',
            'nis2-article-23-timelines',
            'soa-authoring',
        ]);
    });

    it('every shipped skill passes the load-time text scan (#3667)', () => {
        // `loadAllSkills` silently omits a refused skill, so the name list above
        // would also catch one — but as a missing name. This says why.
        expect(loadSkillCorpus().refused).toEqual([]);
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

    it('every WORKFLOW\'s always-present catalogue fits the budget; the corpus as a whole need not', () => {
        // The budget binds what a run pays per turn, which is what its workflow
        // declares — not the corpus (owner decision, 2026-10-17, #3661).
        expect(() => assertWorkflowCatalogsWithinBudget(listWorkflowDefinitions())).not.toThrow();
        for (const w of workflowCatalogs(listWorkflowDefinitions())) {
            expect(w.bytes).toBeLessThanOrEqual(MAX_CATALOG_BYTES);
        }
    });

    it('refuses a workflow whose declared skills exceed the per-turn budget, and one declaring an unknown skill', () => {
        // Positive control for the per-workflow check: the shipped workflows
        // fit, so without this the assertion above could be checking nothing.
        const everything = { key: 'mounts-everything-twice', skills: [...skills, ...skills].map((s) => s.name) };
        expect(catalogBytes([...skills, ...skills])).toBeGreaterThan(MAX_CATALOG_BYTES);
        expect(() => assertWorkflowCatalogsWithinBudget([everything])).toThrow(/every turn/);
        expect(() => assertWorkflowCatalogsWithinBudget([{ key: 'w', skills: ['no-such-skill'] }])).toThrow(SkillLoadError);
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

    it('refuses a run whose mounted skills exceed the per-turn budget', () => {
        // The run-time half of the per-workflow budget (#3661). The corpus may
        // outgrow one prompt; a run may not. Declaring the corpus twice is over
        // budget for any corpus of six or more skills, so this cannot pass by
        // the corpus happening to be small.
        const all = loadAllSkills().map((s) => s.name);
        expect(() => resolveSkillsFor([...all, ...all])).toThrow(/every turn/);
    });
});


describe('the Skills tab payload', () => {
    it('projects the corpus onto the fields an assessor reads', () => {
        const payload = listAgentSkills({ tenantId: 't', tenantSlug: 't', userId: 'u' } as never);
        expect(payload.skills.length).toBeGreaterThanOrEqual(6);
        const one = payload.skills[0];
        expect(Object.keys(one).sort()).toEqual([
            'declaredBy', 'description', 'instructionBytes', 'license', 'name', 'sourceRef', 'version',
        ]);
        // The INSTRUCTIONS are deliberately absent: they are prompt text, and
        // the tab's question is "what did the agent know", which name,
        // description and provenance answer. The procedure lives in the repo.
        expect(one).not.toHaveProperty('instructions');
    });

    it('reports the largest per-workflow catalogue cost beside its budget', () => {
        const payload = listAgentSkills({ tenantId: 't', tenantSlug: 't', userId: 'u' } as never);
        const largest = Math.max(0, ...workflowCatalogs(listWorkflowDefinitions()).map((w) => w.bytes));
        expect(payload.catalogBytes).toBe(largest);
        expect(payload.catalogBytes).toBeLessThanOrEqual(payload.catalogBudgetBytes);
        expect(payload.catalogBudgetBytes).toBe(MAX_CATALOG_BYTES);
    });

    it('names the workflows that declare each skill, and says so when none do', () => {
        const payload = listAgentSkills({ tenantId: 't', tenantSlug: 't', userId: 'u' } as never);
        for (const s of payload.skills) expect(Array.isArray(s.declaredBy)).toBe(true);
    });
});
