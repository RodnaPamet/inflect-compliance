/**
 * A refused skill cannot be mounted, and the surfaces that report it name the
 * rule ids and never the text (#3667).
 *
 * The corpus is replaced with one holding a refused skill, so the assertions
 * are about what the resolver and the Skills tab usecase DO with a refusal —
 * the shipped corpus has none, and `flue-skills-corpus.test.ts` proves that.
 */
jest.mock('@/lib/agentic/flue/skills', () => {
    const actual = jest.requireActual('@/lib/agentic/flue/skills');
    return {
        ...actual,
        loadSkillCorpus: () => ({
            skills: [actual.parseSkillDocument(
                'good-skill',
                "---\nname: good-skill\ndescription: Prepare an access review pack.\nlicense: proprietary\nmetadata:\n  version: '1'\n---\nCite every artefact you rely on.\n",
            )],
            refused: [{ name: 'bad-skill', rules: ['skill.reveal_context'], guardRules: [] }],
        }),
    };
});
jest.mock('@/lib/agentic/workflow-registry', () => ({
    listWorkflowDefinitions: () => [
        { key: 'review-prep', skills: ['good-skill', 'bad-skill'] },
        { key: 'clean-flow', skills: ['good-skill'] },
    ],
}));

import { SkillLoadError, SkillTextRefusedError } from '@/lib/agentic/flue/skills';
import {
    assertWorkflowCatalogsWithinBudget,
    resetSkillCache,
    resolveSkillsFor,
    workflowCatalogs,
} from '@/lib/agentic/flue/skills/resolve';
import { listAgentSkills } from '@/app-layer/usecases/agent-skills';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => resetSkillCache());

describe('a run that declares a refused skill fails closed', () => {
    it('refuses with the rule ids, not as an unknown skill', () => {
        expect(() => resolveSkillsFor(['good-skill', 'bad-skill'])).toThrow(SkillTextRefusedError);
        expect(() => resolveSkillsFor(['bad-skill'])).toThrow(/refused by the skill text scan \(skill\.reveal_context\)/);
    });

    it('still mounts the clean skill for a workflow that does not declare the refused one', () => {
        expect(resolveSkillsFor(['good-skill']).map((s) => s.name)).toEqual(['good-skill']);
    });

    it('keeps the unknown-name refusal distinct', () => {
        let caught: unknown;
        try {
            resolveSkillsFor(['no-such-skill']);
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(SkillLoadError);
        expect(caught).not.toBeInstanceOf(SkillTextRefusedError);
    });
});

describe('the workflow checks', () => {
    it('reports a declared refused skill instead of throwing, so the tab can be drawn', () => {
        const byKey = Object.fromEntries(workflowCatalogs([
            { key: 'review-prep', skills: ['good-skill', 'bad-skill'] },
        ]).map((w) => [w.key, w]));
        expect(byKey['review-prep'].refused).toEqual(['bad-skill']);
    });

    it('fails CI for a workflow that declares a refused skill', () => {
        expect(() => assertWorkflowCatalogsWithinBudget([{ key: 'review-prep', skills: ['bad-skill'] }]))
            .toThrow(SkillTextRefusedError);
    });
});

describe('the Skills tab payload', () => {
    it('lists the refused skill by name, rule ids and the runs it stops', () => {
        const payload = listAgentSkills(makeRequestContext('ADMIN'));
        expect(payload.skills.map((s) => s.name)).toEqual(['good-skill']);
        expect(payload.refused).toEqual([
            { name: 'bad-skill', rules: ['skill.reveal_context'], guardRules: [], declaredBy: ['review-prep'] },
        ]);
        // No text field of any kind on a refused row.
        expect(Object.keys(payload.refused[0]).sort()).toEqual(['declaredBy', 'guardRules', 'name', 'rules']);
    });
});
