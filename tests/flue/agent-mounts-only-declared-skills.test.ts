/**
 * AN AGENT'S LOADED SKILL SET IS EXACTLY WHAT ITS WORKFLOW DECLARES (#3470).
 *
 * The acceptance criterion this file exists for, and it is deliberately
 * BEHAVIOURAL rather than structural: not "the agent iterates
 * `binding.skills`", which a reader can see, but "what reached the model is
 * the declared set and nothing else", which they cannot.
 *
 * ── WHY THAT DISTINCTION IS THE WHOLE POINT ─────────────────────────────────
 *
 * `tests/unit/flue-skills-corpus.test.ts` already covers the RESOLVER:
 * declaring nothing resolves to nothing, an unknown name fails closed, the
 * per-turn budget is enforced. All true, and all about `resolve.ts`.
 *
 * None of it proves the mount. A resolver that answers correctly into an agent
 * that also loaded the corpus by default would pass every one of those cases —
 * the corpus ships several skills, and "implicit global loading" is exactly the
 * failure where a run gets expertise its definition never asked for. That
 * failure is invisible from the resolver's side, and it is not a compile error:
 * `useSkill` can be called as many times as anybody likes.
 *
 * So the observation point is the PROVIDER. A faux response factory receives
 * the `Context` the runtime assembled — system prompt, messages and tools — and
 * a skill that was mounted is in it. What is asserted is therefore the thing
 * the model was actually told.
 *
 * ── SKILLS ARE LAZY, AND THE FIRST DRAFT OF THIS FILE DID NOT KNOW IT ───────
 *
 * Measured, by this file failing. Mounting a skill puts its NAME and
 * DESCRIPTION into the system prompt under `## Available Skills`; the
 * INSTRUCTIONS stay unloaded until the model calls the runtime's
 * `activate_skill` tool. The runtime says so in the prompt it writes: "Skill
 * instructions and supporting resources stay lazy until activation or explicit
 * file reads."
 *
 * So the needles here are the name and the description, which is what a mount
 * actually costs and actually exposes. That also confirms `catalogBytes` was
 * built on the right model — it charges `name: description` per skill per turn
 * and nothing for the instructions, which is exactly the lazy shape rather
 * than a guess at it.
 *
 * ── WHY THIS FILE IMPORTS ALMOST NOTHING ────────────────────────────────────
 *
 * The same reason `agent-serves-the-bound-run` gives: the agent module holds
 * the only VALUE import of `@flue/runtime` in `src/`, so it runs only under
 * this ESM project, and the app graph does not load here at all — an earlier
 * draft of that file imported the tools adapter and died in `pg` before a
 * single assertion ran. The binding carries resolved documents for exactly
 * that reason, and this file builds them by hand rather than reaching for
 * `resolveSkillsFor`, which touches `node:fs`.
 */
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { Context } from '@earendil-works/pi-ai';
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';

import { InflectAgent } from '@/lib/agentic/flue/agent';
import { bindRun, releaseRun, type FlueRunBinding } from '@/lib/agentic/flue/run-binding';
import {
    FLUE_RUNTIME_TOOLS,
    runtimeToolNamesFor,
} from '@/lib/agentic/flue/runtime-tools';

/**
 * Two skill documents with DISTINCTIVE instruction text.
 *
 * Distinctive on purpose: the assertion is a presence/absence pair over one
 * captured context, so the needles must not be able to match each other or
 * anything the runtime writes for itself. A test whose two needles could both
 * be satisfied by one string would report "only the declared one is loaded"
 * from a context carrying both.
 */
const DECLARED: FlueRunBinding['skills'][number] = {
    name: 'sentinel-declared-7f21',
    description: 'SENTINEL-DECLARED-DESC: the one this run asked for.',
    // IN THE BINDING BUT NOT EXPECTED IN THE CONTEXT, which is the lazy
    // contract made visible: a case below asserts this text is absent even
    // from the run that declared the skill.
    instructions: 'SENTINEL-DECLARED-BODY: weigh the evidence before the verdict.',
};
const NOT_DECLARED: FlueRunBinding['skills'][number] = {
    name: 'sentinel-undeclared-b904',
    description: 'SENTINEL-UNDECLARED-DESC: a skill this run did not ask for.',
    instructions: 'SENTINEL-UNDECLARED-BODY: draft the statement of applicability.',
};

/** The context the provider was handed, captured from a response factory. */
async function contextFor(skills: FlueRunBinding['skills'], runId: string): Promise<Context> {
    const faux = fauxProvider();
    let captured: Context | null = null;

    bindRun(runId, {
        // NO TOOLS. A tool would put its own description into the context and
        // give the needles somewhere else to match from; this file is about
        // skills, and the tool path has its own test.
        tools: [],
        modelSpecifier: `${faux.provider.id}/${faux.getModel().id}`,
        skills,
    });
    faux.setResponses([
        (context: Context) => {
            captured = context;
            return fauxAssistantMessage('Done.');
        },
    ]);

    const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
    try {
        const agent = init(InflectAgent, { id: runId });
        await agent.read(
            await agent.dispatch({ message: 'Assess this.', initialData: { runId } }),
        );
    } finally {
        await flue.stop();
        releaseRun(runId);
    }

    if (captured === null) {
        // A NULL CAPTURE IS NOT A PASS. Every assertion below is a substring
        // test over this object, and `JSON.stringify(null)` contains neither
        // needle — so a dispatch that never reached the provider would satisfy
        // all of them. Failing here is what keeps the absence assertions
        // meaningful.
        throw new Error('the provider was never called, so nothing was observed');
    }
    return captured;
}

/** Everything the model was told, as one string. */
const serialise = (ctx: Context): string => JSON.stringify(ctx);

describe('the skills a run mounts', () => {
    it('announces the DECLARED skill, which is the positive control', async () => {
        // Asserted first and on its own, because the absence assertions below
        // are worthless without it: a runtime that dropped every skill would
        // satisfy "the undeclared one is absent" perfectly.
        const text = serialise(await contextFor([DECLARED], 'run-skills-declared'));
        expect(text).toContain('sentinel-declared-7f21');
        expect(text).toContain('SENTINEL-DECLARED-DESC');
    });

    it('does NOT announce a skill the definition did not declare', async () => {
        // THE CRITERION. The corpus ships several skills and the loader can read
        // them all; a run that declared one must be told about one. Implicit
        // global loading is the failure this closes, and it is a behaviour of
        // the mount rather than of the resolver — which cannot see it.
        const text = serialise(await contextFor([DECLARED], 'run-skills-only-declared'));
        expect(text).toContain('sentinel-declared-7f21');
        expect(text).not.toContain('sentinel-undeclared-b904');
        expect(text).not.toContain('SENTINEL-UNDECLARED-DESC');
    });

    it('announces BOTH when both are declared — the absence above is not a cap of one', async () => {
        // Without this, "the undeclared skill is absent" is also satisfied by
        // an agent that mounts only the first element of whatever it is given.
        // Two different defects, one indistinguishable assertion.
        const text = serialise(await contextFor([DECLARED, NOT_DECLARED], 'run-skills-both'));
        expect(text).toContain('sentinel-declared-7f21');
        expect(text).toContain('sentinel-undeclared-b904');
    });

    it('announces NONE when the definition declares none', async () => {
        // `skills: []` is the ordinary case for every static-driver workflow,
        // and it must not be a door into the corpus.
        const text = serialise(await contextFor([], 'run-skills-none'));
        expect(text).not.toContain('sentinel-declared-7f21');
        expect(text).not.toContain('sentinel-undeclared-b904');
    });

    it('keeps the INSTRUCTIONS out of the per-turn prompt', async () => {
        // THE LAZY CONTRACT, pinned rather than assumed. `catalogBytes` charges
        // `name: description` per skill per turn and nothing for the body, and
        // that is only the right budget while this holds. If a runtime upgrade
        // started inlining instructions, the always-present cost of the six
        // shipped skills would jump by their full length with the budget check
        // still reporting green — a cost model measuring something the runtime
        // no longer does.
        const text = serialise(await contextFor([DECLARED], 'run-skills-lazy'));
        expect(text).toContain('sentinel-declared-7f21');
        expect(text).not.toContain('SENTINEL-DECLARED-BODY');
        // And the mechanism the model is told to use instead is present, which
        // is what makes the absence above a deferral rather than a loss.
        expect(text).toContain('activate_skill');
    });
});

describe('the tools a run is handed, beyond the ones it was granted', () => {
    /*
        MEASURED, and recorded here because nothing else in this repo says it.
        A binding carrying `tools: []` — no granted tool at all — still reaches
        the model with a non-empty tool list, and the two cases below are the
        discriminating pair rather than one observation.

        `activate_skill` is CONDITIONAL on a skill being mounted, so its reach
        genuinely follows `binding.skills`, which the driver resolved under the
        caller's authority. It adds none.

        `task` is UNCONDITIONAL. It is in the list for a run with no tools and
        no skills, and it delegates to a subagent — with none declared it has
        no valid `agent` value, and the runtime's own prompt tells the model not
        to call it.

        NEITHER WIDENS REACH TODAY. What they do is make "the effective tool
        set for a run" two different lists: the intersected one this product
        computes and reports — `RegisteredAgentTool` allowlist ∩ API-key
        resource scopes ∩ autonomy ceiling — and the longer one the model is
        actually shown. An auditor asking what a run could call gets the first.

        Pinned as a FACT rather than fixed here: deciding what the product
        should REPORT is not a test's call, and it is filed as its own issue.
        If a runtime upgrade adds a third such tool, or gives `task` a usable
        default agent, these two assertions are where it surfaces.
    */
    it('hands a run with NO tools and NO skills the runtime’s own `task`', async () => {
        const ctx = await contextFor([], 'run-tools-none-declared');
        expect((ctx.tools ?? []).map((t) => t.name).sort()).toEqual(['task']);
    });

    it('adds `activate_skill` only once a skill is mounted', async () => {
        // The CONDITIONAL half, and what makes the case above a measurement of
        // `task` specifically rather than of "the runtime adds tools". One
        // follows what we mounted; the other does not follow anything we said.
        const ctx = await contextFor([DECLARED], 'run-tools-with-a-skill');
        expect((ctx.tools ?? []).map((t) => t.name).sort()).toEqual(['activate_skill', 'task']);
    });

    /*
        ═══ THE DECLARATION IS CHECKED, NOT MERELY WRITTEN DOWN ═══

        `FLUE_RUNTIME_TOOLS` is what the register reports to an operator asking
        what an agent can reach (#3569, owner decision: report them). A list
        that mirrored the runtime BY NAME would go stale the first time a
        version added a third tool — and it would go stale SILENTLY, which is
        the failure mode every hand-maintained mirror has.

        So the two assertions above are re-made against the DECLARATION rather
        than against literals, in both conditions. The literals stay as well:
        together they say "the runtime sends exactly these" and "our list
        predicts exactly that", and only the pair can tell a runtime change
        from a drifted declaration.
    */
    it('the declared runtime-tool list matches what the runtime actually sends', async () => {
        const withoutSkills = await contextFor([], 'run-tools-declared-none');
        expect((withoutSkills.tools ?? []).map((t) => t.name).sort())
            .toEqual(runtimeToolNamesFor({ skillsMounted: false }));

        const withSkills = await contextFor([DECLARED], 'run-tools-declared-some');
        expect((withSkills.tools ?? []).map((t) => t.name).sort())
            .toEqual(runtimeToolNamesFor({ skillsMounted: true }));
    });

    it('every declared runtime tool says what bounds it', () => {
        // The reporting surface renders `boundedBy`, so an empty one would
        // publish a tool with no account of why it is not a hole. Asserted on
        // substance rather than presence: a single word would satisfy a
        // non-empty check.
        for (const tool of FLUE_RUNTIME_TOOLS) {
            expect(tool.boundedBy.length).toBeGreaterThan(80);
        }
        // And the conditions are the two the measurements above distinguish —
        // a third value would mean a case here is not covering it.
        expect(new Set(FLUE_RUNTIME_TOOLS.map((t) => t.appearsWhen)))
            .toEqual(new Set(['always', 'when-skills-mounted']));
    });
});
