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
            skills: ['good-skill', 'unrecorded-skill'].map((n) => actual.parseSkillDocument(
                n,
                `---\nname: ${n}\ndescription: Prepare an access review pack.\nlicense: proprietary\nmetadata:\n  version: '1'\n---\nCite every artefact you rely on.\n`,
            )),
            refused: [{ name: 'bad-skill', rules: ['skill.reveal_context'], guardRules: [] }],
        }),
    };
});
// The gate treats `good-skill` as evaluated and refuses `unrecorded-skill`, so
// the resolver's handling of a gate refusal is visible beside its handling of a
// text-scan refusal.
jest.mock('@/lib/agentic/flue/skills/mount-gate', () => {
    const actual = jest.requireActual('@/lib/agentic/flue/skills/mount-gate');
    return {
        ...actual,
        checkSkillMountable: (skill: { name: string }) =>
            skill.name === 'good-skill'
                ? { ok: true, pin: { name: 'good-skill', version: '1', contentHash: 'sha256:aa' } }
                : { ok: false, reason: 'NO_RECORD', detail: 'no evaluation-record.json' },
    };
});
jest.mock('@/lib/agentic/workflow-registry', () => ({
    listWorkflowDefinitions: () => [
        { key: 'review-prep', skills: ['good-skill', 'bad-skill'] },
        { key: 'clean-flow', skills: ['good-skill'] },
    ],
}));

import { SkillLoadError, SkillTextRefusedError } from '@/lib/agentic/flue/skills';
import { SkillNotMountableError } from '@/lib/agentic/flue/skills/mount-gate';
import {
    assertWorkflowCatalogsWithinBudget,
    assertWorkflowSkillsMountable,
    repositorySkillNames,
    resetSkillCache,
    resolveSkillPins,
    resolveSkillsFor,
    selectableRepositorySkillNames,
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

describe('a run that declares an unevaluated skill fails closed (#3666)', () => {
    it('refuses with the gate’s reason', () => {
        expect(() => resolveSkillsFor(['unrecorded-skill'])).toThrow(SkillNotMountableError);
        expect(() => resolveSkillsFor(['unrecorded-skill'])).toThrow(/cannot be mounted: NO_RECORD/);
        expect(() => resolveSkillPins(['good-skill', 'unrecorded-skill'])).toThrow(SkillNotMountableError);
    });

    it('pins the evaluated skill in declaration order', () => {
        expect(resolveSkillPins(['good-skill'])).toEqual([{ name: 'good-skill', version: '1', contentHash: 'sha256:aa' }]);
        expect(resolveSkillPins(undefined)).toEqual([]);
    });

    it('fails CI for a workflow that declares an unevaluated or refused skill', () => {
        expect(() => assertWorkflowSkillsMountable([{ key: 'w', skills: ['good-skill'] }])).not.toThrow();
        expect(() => assertWorkflowSkillsMountable([{ key: 'w', skills: ['unrecorded-skill'] }])).toThrow(SkillNotMountableError);
        expect(() => assertWorkflowSkillsMountable([{ key: 'w', skills: ['bad-skill'] }])).toThrow(SkillTextRefusedError);
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

describe('the shipped names a person may choose (owner decision, 2026-10-30)', () => {
    it('leave out the refused skill, which the mount path refuses a run for', () => {
        expect([...selectableRepositorySkillNames()].sort()).toEqual(['good-skill', 'unrecorded-skill']);
        expect(() => resolveSkillsFor(['bad-skill'])).toThrow(SkillTextRefusedError);
    });

    it('do not narrow the names a tenant skill may not take, which still include it', () => {
        expect([...repositorySkillNames()].sort()).toEqual(['bad-skill', 'good-skill', 'unrecorded-skill']);
    });
});

describe('the Skills tab payload', () => {
    it('lists the refused skill by name, rule ids and the runs it stops', () => {
        const payload = listAgentSkills(makeRequestContext('ADMIN'));
        expect(payload.skills.map((s) => s.name)).toEqual(['good-skill', 'unrecorded-skill']);
        expect(payload.refused).toEqual([
            { name: 'bad-skill', rules: ['skill.reveal_context'], guardRules: [], declaredBy: ['review-prep'] },
        ]);
        // No text field of any kind on a refused row.
        expect(Object.keys(payload.refused[0]).sort()).toEqual(['declaredBy', 'guardRules', 'name', 'rules']);
    });
});
