/**
 * The tools the TOOL RUNNER ENGINE supplies, which the register never granted
 * (Step 2d of `docs/claude-tool-runner-design.md`).
 *
 * The twin of `flue/runtime-tools.ts`, for the same reason: the effective tool
 * set is an intersection the register decides, and a tool an engine hands the
 * model on its own must be REPORTED beside it rather than left out of it. Here
 * the engine is Inflect's own code, so this list is not measured from a
 * runtime: it is the list `toolRunnerToolsFor` adds to, and
 * `tests/unit/agentic/tool-runner-skills.test.ts` holds the two equal.
 *
 * PURE DATA, like its twin: `agent-tool-exposure` reads it, and that usecase
 * must not load the engine.
 */
import type { RuntimeToolCondition } from '@/lib/agentic/flue/runtime-tools';

export interface EngineSuppliedTool {
    /** The tool name exactly as it reaches the model. */
    readonly name: string;
    readonly appearsWhen: RuntimeToolCondition;
    /** What stops this being a hole, in the terms the intersection is stated in. */
    readonly boundedBy: string;
}

/** The name of the engine's skill tool. */
export const ACTIVATE_SKILL_TOOL_NAME = 'activate_skill';

export const TOOL_RUNNER_SUPPLIED_TOOLS: readonly EngineSuppliedTool[] = [
    {
        name: ACTIVATE_SKILL_TOOL_NAME,
        appearsWhen: 'when-skills-mounted',
        boundedBy:
            'On the Tool Runner engine it is Inflect\'s own tool. It returns the instructions of a skill the run '
            + 'mounted through the mount gate and pinned on its row, after re-checking them against the pin, and '
            + 'answers every other name with an error. It reads nothing the run was not already carrying.',
    },
];

/** The names a Tool Runner run is handed beyond its resolved tools, given whether it mounted any skills. */
export function toolRunnerSuppliedToolNamesFor(opts: { skillsMounted: boolean }): string[] {
    return TOOL_RUNNER_SUPPLIED_TOOLS
        .filter((t) => t.appearsWhen === 'always' || opts.skillsMounted)
        .map((t) => t.name)
        .sort();
}
