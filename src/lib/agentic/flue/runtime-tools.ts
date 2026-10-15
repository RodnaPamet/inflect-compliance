/**
 * The tools the AGENT RUNTIME supplies, which the register never granted.
 *
 * MEASURED, not read from documentation (#3569). A run binding carrying
 * `tools: []` — no granted tool at all — reaches the model with a non-empty
 * tool list, observed through the `Context` a faux provider is handed:
 *
 *     skills: []          →  ['task']
 *     skills: [one]       →  ['activate_skill', 'task']
 *
 * ## Why this file exists rather than a comment
 *
 * This product's claim about agentic reach is an intersection: the effective
 * tool set for a run is `RegisteredAgentTool` allowlist ∩ API-key resource
 * scopes ∩ autonomy ceiling, and a tool absent from it is unreachable however
 * widely the credential is scoped. That claim is true of the tools THIS
 * product supplies and silent about the ones the runtime supplies.
 *
 * Silent is the problem. An auditor asking "what could this run call?" gets
 * the intersected list, and the model was shown a longer one. Neither entry
 * below widens reach today — see each `boundedBy` — so the owner's decision
 * (2026-10-15) was to REPORT them rather than suppress them or give them data
 * rungs: the surfaces that enumerate a run's reachable tools carry these too,
 * labelled as runtime rather than granted.
 *
 * ## This list is CHECKED against the runtime, not merely written down
 *
 * `tests/flue/agent-mounts-only-declared-skills.test.ts` asserts the observed
 * tool names equal what `appearsWhen` predicts, in both conditions. A
 * declaration that mirrored the runtime by name alone would go stale the first
 * time a version added a third tool, and it would go stale SILENTLY — which is
 * the failure mode a hand-maintained mirror always has.
 *
 * ## PURE DATA, and that is load-bearing
 *
 * No import of `@flue/runtime`. `agent-tool-exposure` reads this to answer the
 * register's "what may this agent reach" question, and that usecase reaches
 * Prisma — while the runtime is ESM-only and will not load in that graph. Same
 * reason `refused-capabilities.ts` is data: the one module in `src/` allowed a
 * value import of the runtime is `agent.ts`.
 */

/** When a runtime tool is handed to a run. */
export type RuntimeToolCondition =
    /** Present on every run, whatever it was bound with. */
    | 'always'
    /** Present only once the run mounts at least one skill. */
    | 'when-skills-mounted';

export interface FlueRuntimeTool {
    /** The tool name exactly as it reaches the model. */
    readonly name: string;
    readonly appearsWhen: RuntimeToolCondition;
    /**
     * WHAT STOPS THIS BEING A HOLE, in the terms the intersection is stated
     * in. Not reassurance — the sentence a reviewer checks.
     */
    readonly boundedBy: string;
}

export const FLUE_RUNTIME_TOOLS: readonly FlueRuntimeTool[] = [
    {
        name: 'task',
        appearsWhen: 'always',
        boundedBy:
            'Delegates to a subagent. No subagent is declared, so it has no valid '
            + '`agent` value and the runtime\'s own system prompt tells the model not to '
            + 'call it. Reach becomes real with #3473, whose invariant is that a '
            + "subagent's tools are a subset of the parent's already-intersected set — "
            + 'so this entry is where that work has to be measured against.',
    },
    {
        name: 'activate_skill',
        appearsWhen: 'when-skills-mounted',
        boundedBy:
            'Loads the full instructions of a skill this run already mounted. The '
            + 'mounted set is `binding.skills`, which the driver resolved from the '
            + "workflow definition under the caller's authority, so this reaches nothing "
            + 'the run was not already carrying — it defers a cost rather than widening '
            + 'a set. Its presence is CONDITIONAL on that set being non-empty, which is '
            + 'what distinguishes it from `task`.',
    },
];

/** The names a run is handed, given whether it mounted any skills. */
export function runtimeToolNamesFor(opts: { skillsMounted: boolean }): string[] {
    return FLUE_RUNTIME_TOOLS
        .filter((t) => t.appearsWhen === 'always' || opts.skillsMounted)
        .map((t) => t.name)
        .sort();
}
