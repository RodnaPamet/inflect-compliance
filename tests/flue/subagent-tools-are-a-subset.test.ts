/**
 * A SUBAGENT'S TOOLS ARE A SUBSET OF THE PARENT'S ALREADY-INTERSECTED SET
 * (#3473) — the acceptance criterion of this plan point, and the one the issue
 * is explicit must be behavioural:
 *
 * > A behavioural test that a subagent's tool set is a **strict subset** of the
 * > parent's intersected set, with the key-scope and ceiling terms present —
 * > not a structural assertion about where the set came from.
 *
 * ── WHY A STRUCTURAL ASSERTION WOULD NOT DO ─────────────────────────────────
 *
 * The effective set for a run is `RegisteredAgentTool` allowlist ∩ API-key
 * resource scopes ∩ autonomy ceiling. "The code calls `narrowTools(spec,
 * binding.tools)`" is checkable by grep and proves nothing about what the
 * delegate was actually handed: the runtime renders a delegate "in its own
 * frame, fresh per task", and a frame that re-derived its tools from the
 * register would pass any grep while dropping two of the three terms.
 *
 * So the parent here is bound with a set that is ALREADY NARROW — one tool,
 * standing in for a binding the key scope and the ceiling have already cut
 * down — and the specialist used declares tools the parent does NOT have. If
 * the delegate's set came from anywhere but the parent's binding, the extra
 * ones appear. That is the discriminating observation, and it is only
 * available by rendering the delegate.
 *
 * ── HOW THE DELEGATE'S SET IS OBSERVED ──────────────────────────────────────
 *
 * Through the provider, as everything else in this directory is. The faux
 * response factory receives the `Context` the runtime assembled for whichever
 * agent is being served — so when the delegate's turn runs, `ctx.tools` is the
 * delegate's own list. Captured per call, then separated by which names are
 * present.
 */
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Context } from '@earendil-works/pi-ai';
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { InflectAgent } from '@/lib/agentic/flue/agent';
import { bindRun, releaseRun, type FlueRunBinding } from '@/lib/agentic/flue/run-binding';
import { SPECIALISTS, narrowTools, narrowSkills } from '@/lib/agentic/flue/subagents';
import { _resetDelegationCounts } from '@/lib/agentic/flue/delegation-gate';

/** A tool shaped as the adapter emits one, without importing the adapter. */
function tool(name: string): FlueRunBinding['tools'][number] {
    return {
        name,
        description: `The ${name} tool.`,
        input: v.strictObject({}),
        annotations: { readOnlyHint: true, destructiveHint: false, title: name },
        run: async () => '{}',
    };
}

const SKILL = (name: string): FlueRunBinding['skills'][number] => ({
    name,
    description: `The ${name} skill.`,
    instructions: `SENTINEL-SKILL-${name}`,
});

beforeEach(() => {
    _resetDelegationCounts();
});

/**
 * Dispatch a run whose model delegates once, and report every tool list the
 * provider was asked to serve.
 */
interface Served {
    tools: string[];
    prompt: string;
}

async function toolListsFor(opts: {
    runId: string;
    parentTools: readonly string[];
    parentSkills?: readonly string[];
    delegateTo: string;
}): Promise<Served[]> {
    const faux = fauxProvider();
    const lists: Served[] = [];

    bindRun(opts.runId, {
        tools: opts.parentTools.map(tool),
        skills: (opts.parentSkills ?? []).map(SKILL),
        modelSpecifier: `${faux.provider.id}/${faux.getModel().id}`,
        maxSubagentsPerTurn: 3,
    });

    faux.setResponses([
        // The parent's turn: delegate once.
        (context: Context) => {
            lists.push(served(context));
            return fauxAssistantMessage([
                fauxToolCall('task', { prompt: 'have a look', agent: opts.delegateTo }),
            ]);
        },
        // The delegate's turn: answer, so the task settles.
        (context: Context) => {
            lists.push(served(context));
            return fauxAssistantMessage('delegate answer');
        },
        // The parent again, and a spare.
        (context: Context) => {
            lists.push(served(context));
            return fauxAssistantMessage('parent answer');
        },
        fauxAssistantMessage('spare'),
    ]);

    const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
    try {
        const agent = init(InflectAgent, { id: opts.runId });
        await agent.read(
            await agent.dispatch({ message: 'go', initialData: { runId: opts.runId } }),
        );
    } finally {
        await flue.stop();
        releaseRun(opts.runId);
    }
    return lists;
}

/** The runtime's own tools, which are never a grant. See #3569. */
const RUNTIME_TOOLS = new Set(['task', 'activate_skill']);
const granted = (s: Served): string[] =>
    s.tools.filter((n) => !RUNTIME_TOOLS.has(n)).sort();

const served = (context: Context): Served => ({
    tools: (context.tools ?? []).map((t) => t.name),
    prompt: context.systemPrompt ?? '',
});

/**
 * WHICH SERVED CONTEXT WAS THE DELEGATE'S — by its own instruction text.
 *
 * NOT by "the list without `task` in it", which is what the first draft of
 * this file used and which was wrong in a way that would have passed: the
 * runtime adds `task` to the DELEGATE's list too (#3569 measured it as
 * unconditional), and when the intersection leaves the delegate the parent's
 * only tool the two `granted` lists are IDENTICAL. The selector would then
 * have been reading the parent's context and asserting something true of it.
 *
 * A specialist's `instructions` are the delegate's system prompt and appear in
 * no other context, so they identify it exactly.
 */
function delegateContext(lists: Served[], specName: string): Served | undefined {
    const spec = SPECIALISTS.find((sp) => sp.name === specName);
    if (!spec) throw new Error(`no specialist named ${specName}`);
    const needle = spec.instructions.slice(0, 40);
    return lists.find((l) => l.prompt.includes(needle));
}

describe('the narrowing is an intersection, as a function', () => {
    const spec = SPECIALISTS.find((s) => s.name === 'policy_drafter');

    it('the specialist used by the behavioural cases declares more than the parent will have', () => {
        // THE PREMISE OF EVERY ASSERTION BELOW. If `policy_drafter` did not
        // declare a tool the parent lacks, "the delegate has only the parent's"
        // would be satisfied by a delegate that took its tools from anywhere.
        expect(spec).toBeDefined();
        expect(spec?.tools).toContain('list_controls');
        expect(spec?.tools).toContain('draft_policy');
    });

    it('returns the parent\'s OWN objects, not rebuilt ones', () => {
        // A rebuilt tool would be a second definition of the same name, and the
        // ledger wrapper the driver put around it would be gone — so the step
        // would not be recorded and the cap would not be charged.
        const parent = [tool('list_controls'), tool('list_risks')];
        const out = narrowTools(spec!, parent);
        expect(out).toHaveLength(1);
        expect(out[0]).toBe(parent[0]);
    });

    it('cannot ADD a tool the parent does not have, whatever it declares', () => {
        expect(narrowTools(spec!, [tool('list_risks')]).map((t) => t.name)).toEqual([]);
    });

    it('narrows SKILLS by the same rule', () => {
        // #3470's criterion is that a run's skills are exactly what its
        // workflow declares. A delegate mounting one the parent never declared
        // would widen what the run is taught — the same defect in a different
        // currency, which a tool-only rule would miss.
        const parent = [SKILL('soa-authoring'), SKILL('evidence-sufficiency')];
        expect(narrowSkills(spec!, parent).map((s) => s.name)).toEqual(['soa-authoring']);
    });
});

describe('the delegate is handed a STRICT SUBSET of the parent binding', () => {
    it('gets the parent\'s tools it declares, and NOT the ones the parent lacks', async () => {
        // The parent holds ONE tool — standing in for a binding the API-key
        // scope and the autonomy ceiling have already cut down. `policy_drafter`
        // declares four, including `draft_policy`, a rung-2 PROPOSE tool.
        //
        // So the discriminating observation is `draft_policy`'s ABSENCE from the
        // delegate's list: it is in the specialist's declaration and not in the
        // parent's binding, and a delegate that re-derived from the register
        // would have it.
        const lists = await toolListsFor({
            runId: 'sub-subset',
            parentTools: ['list_controls'],
            delegateTo: 'policy_drafter',
        });

        const delegate = delegateContext(lists, 'policy_drafter');
        // FOUND AT ALL, first: if the delegate never ran, every absence below
        // is vacuous.
        expect(delegate).toBeDefined();
        expect(granted(delegate as Served)).toEqual(['list_controls']);

        // AND NOTHING ANYWHERE SAW `draft_policy`. Asserted across every
        // context the provider served, so a delegate that got it on a later
        // turn is caught too.
        for (const l of lists) expect(granted(l)).not.toContain('draft_policy');
    });

    it('gets NOTHING when it declares nothing the parent holds', async () => {
        // A parent holding only `list_risks` delegating to `policy_drafter`,
        // which declares none of it. An empty tool set is the correct outcome
        // and the delegate still runs — the alternative, inheriting the
        // parent's whole set because the intersection came out empty, is the
        // failure mode a `||` in the wrong place produces.
        const lists = await toolListsFor({
            runId: 'sub-empty',
            parentTools: ['list_risks'],
            delegateTo: 'policy_drafter',
        });
        const delegate = delegateContext(lists, 'policy_drafter');
        expect(delegate).toBeDefined();
        expect(granted(delegate as Served)).toEqual([]);
        // The PARENT still has it — this is about the delegate, and asserting
        // across every context would assert something false about the parent.
        expect(lists.some((l) => granted(l).includes('list_risks'))).toBe(true);
    });

    it('the PARENT keeps its own set — narrowing a delegate narrows nothing else', async () => {
        // `narrowTools` filters a copy, but the mount loops over the same
        // binding four times (once per specialist). A filter that mutated would
        // leave the parent with whatever the last specialist happened to want.
        const lists = await toolListsFor({
            runId: 'sub-parent-intact',
            parentTools: ['list_controls', 'list_risks'],
            delegateTo: 'risk_analyst',
        });
        // The parent is every context that is NOT the delegate's.
        const delegate = delegateContext(lists, 'risk_analyst');
        expect(delegate).toBeDefined();
        const parents = lists.filter((l) => l !== delegate);
        expect(parents.length).toBeGreaterThan(0);
        for (const p of parents) {
            expect(granted(p)).toEqual(['list_controls', 'list_risks']);
        }
        // And the delegate got only what it declares of those two.
        expect(granted(delegate as Served)).toEqual(['list_risks']);
    });

    it('a delegate mounts only the parent\'s DECLARED skills', async () => {
        // The other currency, end to end: the parent declares two skills and
        // `evidence_assessor` declares one of them.
        const lists = await toolListsFor({
            runId: 'sub-skills',
            parentTools: ['list_controls'],
            parentSkills: ['evidence-sufficiency', 'soa-authoring'],
            delegateTo: 'evidence_assessor',
        });
        const delegate = delegateContext(lists, 'evidence_assessor');
        expect(delegate).toBeDefined();
        // Skills are announced by NAME in the prompt and their bodies stay lazy
        // (#3470), so the delegate's catalogue is what is asserted.
        expect(delegate?.prompt).toContain('evidence-sufficiency');
        expect(delegate?.prompt).not.toContain('soa-authoring');
        // And the parent still announces both.
        const parent = lists.find((l) => l !== delegate && l.prompt.includes('soa-authoring'));
        expect(parent).toBeDefined();
    });
});

describe('every specialist is declared to the runtime', () => {
    it('all four are selectable on the `task` tool', async () => {
        // The catalogue the model chooses from. A specialist defined in the
        // data module and never mounted would be undeclared, and the runtime
        // answers an undeclared name with `SubagentNotDeclaredError` — a
        // failure that reads as the model inventing an agent.
        const faux = fauxProvider();
        let prompt = '';
        bindRun('sub-catalog', {
            tools: [],
            skills: [],
            modelSpecifier: `${faux.provider.id}/${faux.getModel().id}`,
            maxSubagentsPerTurn: 3,
        });
        faux.setResponses([
            (context: Context) => {
                prompt = context.systemPrompt ?? '';
                return fauxAssistantMessage('seen');
            },
        ]);
        const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
        try {
            const agent = init(InflectAgent, { id: 'sub-catalog' });
            await agent.read(
                await agent.dispatch({ message: 'go', initialData: { runId: 'sub-catalog' } }),
            );
        } finally {
            await flue.stop();
            releaseRun('sub-catalog');
        }
        for (const spec of SPECIALISTS) {
            expect(prompt).toContain(spec.name);
        }
        // AND THE PROMPT NO LONGER SAYS THERE ARE NONE. Before this change it
        // read "No subagents are currently declared, so the `task` tool has no
        // valid `agent` value" — the sentence #3569 measured. Its absence is
        // the one-line proof that declaring them turned delegation on.
        expect(prompt).not.toContain('No subagents are currently declared');
    });
});
