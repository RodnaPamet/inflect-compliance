import type { WorkflowStepDef } from './workflow-types';

/**
 * Which tool to show against a recorded step.
 *
 * ── WHY THIS IS NOT JUST `step.toolCalled` ──────────────────────────────────
 *
 * The static driver's failure path records the step with NO `toolCalled` — it
 * calls `recordStep` with only a status and an error output. So a READ or
 * PROPOSE that threw lands in the ledger with a NULL tool, and a timeline chip
 * reading the column alone is blank on exactly the steps an operator opened the
 * page to inspect. The successful steps, which need it least, are the only ones
 * that show it.
 *
 * The definition still knows. The driver executes `def.steps[seq]`, so `seq`
 * indexes back into the same array, and a declared READ or PROPOSE carries its
 * `tool` whether or not the attempt got far enough to record one.
 *
 * ── THE ORDER IS THE POINT ──────────────────────────────────────────────────
 *
 * The RECORDED value wins whenever it exists, because it is what actually ran;
 * the declared one is a statement of intent and could in principle differ from
 * it. The fallback fills a hole, it does not override an observation — which is
 * the same rule `WorkflowRun.driver` follows against the tenant's configuration
 * one surface up.
 *
 * Returns `null` for the kinds that legitimately have no tool — SYNTHESIS is a
 * function over accumulated context and HUMAN_CHECKPOINT is a pause — so the
 * caller renders nothing rather than an empty chip.
 */
export function resolveStepTool(
    recorded: string | null,
    declared: WorkflowStepDef | undefined,
): string | null {
    if (recorded) return recorded;
    if (declared && 'tool' in declared && typeof declared.tool === 'string') {
        return declared.tool;
    }
    return null;
}
