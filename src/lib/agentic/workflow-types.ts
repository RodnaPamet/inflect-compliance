/**
 * Agentic workflow engine — the declarative workflow contract (Epic Agentic 1A).
 *
 * A workflow is a DECLARATIVE sequence of steps the engine runs. It composes the
 * EXISTING MCP read/propose tools — it adds orchestration + checkpoints, NOT new
 * authority. Every PROPOSE step routes through the propose-not-commit approval
 * queue; a HUMAN_CHECKPOINT pauses the run for a human. The engine can commit
 * nothing a single MCP tool couldn't.
 *
 * Step kinds:
 *   - READ            — call an MCP read tool to gather context.
 *   - PROPOSE         — call an MCP propose tool (queues a proposal, never commits).
 *   - HUMAN_CHECKPOINT— pause the run to AWAITING_APPROVAL until a human acts.
 *   - SYNTHESIS       — reason over accumulated context to produce a summary.
 */

/** Accumulated run state. `outputs` is keyed by each step's `label`. */
export interface WorkflowContext {
    input: Record<string, unknown>;
    outputs: Record<string, unknown>;
}

export interface ReadStepDef {
    kind: 'READ';
    label: string;
    /** The MCP read tool name (e.g. 'get_compliance_posture'). */
    tool: string;
    /** Build the tool arguments from the accumulated context. */
    args?: (ctx: WorkflowContext) => Record<string, unknown>;
    /**
     * May this step FAIL WITHOUT ENDING THE RUN?
     *
     * Default `false`, which is the engine's original behaviour to the letter:
     * a throw marks the run FAILED and the run is over — every step that had
     * already succeeded is stranded in a terminal state `resumeWorkflowRun`
     * refuses. Opting in says this step gathers something the later steps can
     * do without (an optional enrichment read, a best-effort proposal), so its
     * failure is recorded against the STEP and the run carries on.
     *
     * It is NOT a way to make a run quiet. An isolated failure still writes a
     * `FAILED` WorkflowStep row carrying the reason, still emits a metric, and
     * still counts into the `stepFailures` the run's own result reports. A run
     * that completes with `stepFailures > 0` reasoned over less than it meant
     * to, and its caller is handed the number rather than left to query for it.
     *
     * It is also NOT a way past a HALT. A `ContextIntegrityError`, or any error
     * carrying the `agenticFatal` brand (an operator kill, a budget breach),
     * ends the run whatever this flag says — see `isAgenticFatal` in
     * `@/lib/agentic/failure-isolation`. A per-step flag that could override a
     * kill would be the cascade it exists to prevent.
     */
    continueOnFailure?: boolean;
}

export interface ProposeStepDef {
    kind: 'PROPOSE';
    label: string;
    /** The MCP propose tool name (e.g. 'propose_controls'). */
    tool: string;
    /** Build the candidate items from the accumulated context. Empty ⇒ step skipped. */
    buildItems: (ctx: WorkflowContext) => Array<Record<string, unknown>>;
    rationale?: (ctx: WorkflowContext) => string;
    /** See `ReadStepDef.continueOnFailure` — isolate this step's failure, never a halt. */
    continueOnFailure?: boolean;
}

export interface CheckpointStepDef {
    kind: 'HUMAN_CHECKPOINT';
    label: string;
    /**
     * A checkpoint CANNOT opt into failure isolation, and `never` is how that is
     * said to the compiler rather than to a reader.
     *
     * Declaring it (as an always-`undefined` optional) keeps the property
     * readable across the `WorkflowStepDef` union — the executor asks every step
     * the same question — while making `continueOnFailure: true` on a checkpoint
     * a type error. The reason is that a checkpoint's failure is not a step
     * failing at its work: the only things it does are record a PENDING row and
     * park the run, so a throw there means the run could not be parked. Carrying
     * on past that would run the steps a human was supposed to gate.
     */
    continueOnFailure?: never;
}

export interface SynthesisStepDef {
    kind: 'SYNTHESIS';
    label: string;
    /** Produce a summary (and optional structured data) from the context. */
    synthesize: (ctx: WorkflowContext) => { text: string; data?: Record<string, unknown> };
    /** See `ReadStepDef.continueOnFailure` — isolate this step's failure, never a halt. */
    continueOnFailure?: boolean;
}

export type WorkflowStepDef =
    | ReadStepDef
    | ProposeStepDef
    | CheckpointStepDef
    | SynthesisStepDef;

export interface WorkflowDefinition {
    key: string;
    name: string;
    description: string;
    steps: WorkflowStepDef[];
}

/**
 * Hard per-run guardrails for an autonomous multi-step agent. A run that
 * breaches any of these is FAILED (never a half-applied mess — writes are
 * proposals, so nothing is half-committed by design).
 */
export const ENGINE_CAPS = {
    /** Max steps a single run may execute. */
    MAX_STEPS: 50,
    /** Max estimated token/cost budget per run. */
    MAX_TOKENS: 200_000,
    /** Max wall-clock a run may span (across resumes), in ms. */
    WALL_CLOCK_MS: 60 * 60 * 1000,
} as const;

/** Cheap token estimate for a step's output (≈4 chars/token). */
export function estimateTokens(value: unknown): number {
    try {
        return Math.ceil(JSON.stringify(value ?? '').length / 4);
    } catch {
        return 0;
    }
}
