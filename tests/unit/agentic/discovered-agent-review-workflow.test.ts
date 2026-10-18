/**
 * The discovered-agent review workflow and its two IAM skills (#3668, step 1d).
 *
 * Hardening items proved here, against the SHIPPED corpus and the real gate —
 * nothing below is mocked:
 *
 *   • BOTH SKILLS PASS THE EVALUATION GATE AND THE LOAD-TIME SCAN.
 *   • THE WORKFLOW MOUNTS EXACTLY THE TWO SKILLS — the mount test: the resolver
 *     a run uses hands it exactly these two documents and pins exactly these
 *     two, by name, version and hash. `tests/integration/discovered-agent-review.test.ts`
 *     proves the same pin reaches the run row through the real start path.
 *
 * The admission refusal of a run without its required input is proved against
 * a real database in that integration file, which is where "before its row
 * exists" can be observed; this file pins the declaration it refuses on.
 */
import { loadSkillCorpus, type LoadedSkill } from '@/lib/agentic/flue/skills';
import { scanSkillText } from '@/lib/agentic/flue/skills/text-scan';
import { checkSkillMountable } from '@/lib/agentic/flue/skills/mount-gate';
import {
    CASE_KINDS,
    readEvaluationSet,
    skillContentHash,
    type SkillEvaluationSet,
} from '@/lib/agentic/flue/skills/evaluation-record';
import {
    assertWorkflowCatalogsWithinBudget,
    resetSkillCache,
    resolveSkillPins,
    resolveSkillsFor,
} from '@/lib/agentic/flue/skills/resolve';
import { getWorkflowDefinition, listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';
import { selectRunDriver } from '@/lib/agentic/drivers';
import {
    DISCOVERED_AGENT_REVIEW_SKILLS,
    discoveredAgentReviewWorkflow,
} from '@/lib/agentic/workflows/discovered-agent-review';
import type { ReadStepDef, SynthesisStepDef } from '@/lib/agentic/workflow-types';

const KEY = 'discovered-agent-review';
const IAM_SKILLS = ['harness-level-assessment', 'nhi-ownership-attribution'] as const;

const corpus = loadSkillCorpus();
const skillOf = (name: string): LoadedSkill => {
    const s = corpus.skills.find((x) => x.name === name);
    if (!s) throw new Error(`${name} is not a loaded skill`);
    return s;
};

beforeEach(() => resetSkillCache());

describe('both IAM skills pass the evaluation gate and the load-time scan', () => {
    it.each(IAM_SKILLS)('%s loads, and the text scan refuses none of it', (name) => {
        expect(corpus.refused.map((r) => r.name)).not.toContain(name);
        const skill = skillOf(name);
        expect(
            scanSkillText({
                description: skill.description,
                instructions: skill.instructions,
                declaredTools: skill.metadata.tools ? skill.metadata.tools.split(',').map((t) => t.trim()) : [],
            }),
        ).toEqual({ rules: [], guardRules: [] });
    });

    it.each(IAM_SKILLS)('%s passes the mount gate on its committed evaluation record', (name) => {
        const skill = skillOf(name);
        expect(checkSkillMountable(skill)).toEqual({
            ok: true,
            pin: { name, version: '1', contentHash: skillContentHash(skill.instructions) },
        });
    });

    it.each(IAM_SKILLS)('%s: its evaluation set has task, refusal, injection and missing-input cases', (name) => {
        const set = readEvaluationSet(skillOf(name)) as SkillEvaluationSet;
        expect(CASE_KINDS.filter((kind) => !set.cases.some((c) => c.kind === kind))).toEqual([]);
        expect(CASE_KINDS).toEqual(['task', 'refusal', 'injection', 'missing-input']);
    });
});

describe('the workflow mounts exactly the two IAM skills', () => {
    const def = getWorkflowDefinition(KEY);

    it('is registered, and declares the two skills and nothing else', () => {
        expect(def).toBe(discoveredAgentReviewWorkflow);
        expect([...(def?.skills ?? [])]).toEqual([...IAM_SKILLS]);
        expect(DISCOVERED_AGENT_REVIEW_SKILLS).toEqual(IAM_SKILLS);
    });

    it('a run is handed exactly those two documents — the resolver a Flue run uses', () => {
        const mounted = resolveSkillsFor(def?.skills);
        expect(mounted.map((s) => s.name)).toEqual([...IAM_SKILLS]);
        for (const doc of mounted) {
            const shipped = skillOf(doc.name);
            expect(doc).toEqual({ name: shipped.name, description: shipped.description, instructions: shipped.instructions });
        }
    });

    it('and is pinned to exactly those two, by name, version and hash, in declaration order', () => {
        expect(resolveSkillPins(def?.skills)).toEqual(
            IAM_SKILLS.map((name) => ({ name, version: '1', contentHash: skillContentHash(skillOf(name).instructions) })),
        );
    });

    it('asks for the Flue engine, which is the only one that mounts skills', () => {
        if (!def) throw new Error('not registered');
        expect(selectRunDriver(def, 'flue').driver).toBe('flue');
        expect(selectRunDriver(def, 'static').driver).toBe('static');
    });

    it('fits the per-turn catalogue budget', () => {
        if (!def) throw new Error('not registered');
        expect(() => assertWorkflowCatalogsWithinBudget([def])).not.toThrow();
    });

    it('is the only registered workflow that declares either skill', () => {
        const declaring = listWorkflowDefinitions()
            .filter((d) => (d.skills ?? []).some((s) => (IAM_SKILLS as readonly string[]).includes(s)))
            .map((d) => d.key);
        expect(declaring).toEqual([KEY]);
    });
});

describe('its required input, and how it becomes the skills’ input', () => {
    const read = discoveredAgentReviewWorkflow.steps[0] as ReadStepDef;
    const synth = discoveredAgentReviewWorkflow.steps[1] as SynthesisStepDef;

    it('declares discoveredAgentId, which admission refuses a run without', () => {
        expect(discoveredAgentReviewWorkflow.requiredInput).toEqual(['discoveredAgentId']);
    });

    it('reads the agent under the name both skills give their required input', () => {
        for (const name of IAM_SKILLS) expect(skillOf(name).metadata.requiredInput).toBe('discoveredAgent');
        expect(read).toMatchObject({ kind: 'READ', label: 'discoveredAgent', tool: 'get_discovered_agent' });
        expect(read.args?.({ input: { discoveredAgentId: 'da_1' }, outputs: {} })).toEqual({ discoveredAgentId: 'da_1' });
    });

    it.each([
        ['nothing', {}],
        ['a blank id', { discoveredAgentId: '  ' }],
        ['a non-string', { discoveredAgentId: 42 }],
    ])('never reads an agent it was given %s for — the read throws rather than substitute one', (_label, input) => {
        expect(() => read.args?.({ input, outputs: {} })).toThrow(/discoveredAgentId/);
    });

    it('is read-only: no PROPOSE step and no checkpoint', () => {
        expect(discoveredAgentReviewWorkflow.steps.map((s) => s.kind)).toEqual(['READ', 'SYNTHESIS']);
    });

    it('its static synthesis states no level and no owner, only what was read', () => {
        const out = synth.synthesize({
            input: { discoveredAgentId: 'da_1' },
            outputs: {
                discoveredAgent: {
                    discoveredId: 'entra:sp:7a01',
                    scan: { scanRef: 'scan_1', completeness: 'INCOMPLETE' },
                    observations: [{ criterion: 'H1.owner', met: true, evidence: 'x' }],
                },
            },
        });
        expect(out.text).toBe(
            'Discovered agent entra:sp:7a01: 1 criterion observation(s) from scan scan_1 (INCOMPLETE). '
            + 'No level and no owner is stated here.',
        );
        expect(out.data).toEqual({ discoveredAgentId: 'da_1', observations: 1, scanCompleteness: 'INCOMPLETE' });
        const unread = synth.synthesize({ input: { discoveredAgentId: 'da_2' }, outputs: { discoveredAgent: { discoveredId: 'x', scan: null, observations: null } } });
        expect(unread.text).toMatch(/no scan item has been read for it/);
    });
});
