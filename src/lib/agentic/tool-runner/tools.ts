/**
 * THE TOOL RUNNER ENGINE'S TOOLS (Step 2b of `docs/claude-tool-runner-design.md`).
 *
 * One runnable tool per tool the run may use, built over the engine-neutral core
 * (`offerToolSet` → `runGuardedTool`), so this engine is offered exactly what
 * Flue is offered and every call goes through the same funnel. Each tool's
 * `run`, in order:
 *
 *   1. refuses if the run has already stopped (a cap, a kill or a guard verdict
 *      latched), so a call the runner starts after a stop never reaches the
 *      funnel;
 *   2. waits for the previous call of this run to finish. The runner starts
 *      every tool call of a turn at once (`Promise.all`), and
 *      `disable_parallel_tool_use` is a request to the model, not a guarantee,
 *      so this queue is what keeps the TOOL_CALL order, the cap charging and the
 *      guard latch exact;
 *   3. charges STEPS, then admits the call against the turn's tool-call cap
 *      (#4594): a call past it is refused with a tool error naming the cap and
 *      recorded as a FAILED TOOL_CALL step, `TOOL_CALLS_PER_TURN_EXCEEDED`, and
 *      the funnel is never asked. Then TOOL_CALLS, the wall clock, and
 *      PROPOSALS per item, BEFORE the call, as Flue's ledger wrapper does: a
 *      refused charge means the funnel was never asked;
 *   4. calls the guarded tool, which runs the egress scan on the arguments, the
 *      funnel (which validates the arguments against the tool's own
 *      `argsSchema`, after its gate) and the scans on the result;
 *   5. writes the TOOL_CALL step, with the guard's verdict and the arguments;
 *   6. reads the kill switch once the call is done, so a kill engaged while it
 *      ran stops the run before the next model call is sent.
 *
 * The arguments are checked here for SHAPE only (an object), and validated by
 * the funnel against the tool's `argsSchema`: one catalogue, one validator, and
 * nothing runs ahead of the funnel's gate.
 *
 * The runnable tool is a plain object of the SDK's type, so this file loads no
 * `@anthropic-ai/*` package (`local/anthropic-client-single-seam`).
 */
import type { BetaRunnableTool, BetaToolRunContext } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';

import type { RequestContext } from '@/app-layer/types';
import { recordStep } from '@/lib/agentic/drivers/step-recorder';
import {
    asToolArgs,
    offerToolSet,
    type OfferedTool,
    type OfferedToolSet,
    type StepGuardObservation,
} from '@/lib/agentic/engine-tools';
import { recordExternalToolDecision } from '@/lib/agentic/flue/tool-decision';
import type { RunBudget, RunCapHalt } from '@/lib/agentic/run-caps';
import {
    TOOL_CALLS_PER_TURN_EXCEEDED,
    evaluateToolCallsPerTurn,
    toolCallsPerTurnRefusalMessage,
    type ToolCallsPerTurnVerdict,
} from '@/lib/agentic/turn-caps';
import type { McpInvocation } from '@/lib/mcp/authorize';
import { isProposeTool, proposedItemCount } from '@/lib/mcp/tools/propose-tools';

/** This engine's name in every guard source its tool calls write. */
export const TOOL_RUNNER_GUARD_SOURCE = 'tool-runner';

/** Why the run stopped, latched by whichever check found it first. */
export type RunStop =
    | { readonly kind: 'CAP'; readonly halt: RunCapHalt }
    | { readonly kind: 'KILL' }
    | { readonly kind: 'OPERATOR_ABORT' }
    | { readonly kind: 'GUARD' };

/** What a run's tools share with the loop that drives them. */
export interface ToolRunBinding {
    readonly ctx: RequestContext;
    readonly runId: string;
    readonly budget: RunBudget;
    /** The next ledger seq. The loop's MODEL_CALL steps take from the same counter. */
    nextSeq(): number;
    /** The latched stop, or null while the run may go on. */
    stopped(): RunStop | null;
    /** Latch a cap halt and abort the request in flight, if any. */
    stopAtCap(halt: RunCapHalt): void;
    /**
     * Read the kill switch, and the run's status for an operator's Abort
     * (#5366); latch and abort when either has stopped the run.
     */
    checkKill(): Promise<boolean>;
    /** The guard's verdict for one call, taken (removed) once its step is written. */
    takeVerdict(toolCallId: string): StepGuardObservation | undefined;
    /** Which step a propose call belongs to, so its proposals name it. Per run, keyed by call. */
    noteOrigin(toolCallId: string, stepSeq: number): void;
    originOf(toolCallId: string): number | undefined;
    forgetOrigin(toolCallId: string): void;
    onFailure(): void;
    /**
     * Admit one tool call against the current turn's tool-call cap (#4594),
     * counted on the way in: an admitted call counts, a refused one does not.
     * Every tool the run offers asks it, the engine's own included.
     */
    admitToolCall(): ToolCallsPerTurnVerdict;
}

/**
 * How many tool calls each turn has made, for one segment (#4594).
 *
 * Keyed by the LOOP and its turn number, so a sub-agent's loop (a later step)
 * counts its own turns without touching the parent's. A segment builds one and
 * drops it with the segment: a resumed run starts its turns afresh, as the
 * model's own turns do.
 */
export class TurnCallCounter {
    private readonly made = new Map<string, number>();

    constructor(private readonly cap: number) {}

    admit(loop: string, turn: number): ToolCallsPerTurnVerdict {
        const key = `${loop}:${turn}`;
        const verdict = evaluateToolCallsPerTurn({ cap: this.cap, madeThisTurn: this.made.get(key) ?? 0 });
        if (verdict.allowed) this.made.set(key, verdict.madeThisTurn + 1);
        return verdict;
    }
}

/**
 * Refuse a call past the turn's tool-call cap: one FAILED TOOL_CALL step naming
 * the refusal and the cap, and the error the model reads. The caller has
 * already charged its STEPS, as every recorded step is charged; nothing else
 * is charged and the funnel is never asked.
 */
export async function refuseOverTurnCap(
    binding: ToolRunBinding,
    toolName: string,
    verdict: ToolCallsPerTurnVerdict,
    input?: Record<string, unknown>,
): Promise<never> {
    const seq = binding.nextSeq();
    binding.onFailure();
    await recordStep(binding.ctx, binding.runId, seq, 'TOOL_CALL', {
        toolCalled: toolName,
        status: 'FAILED',
        label: toolName,
        ...(input ? { input } : {}),
        output: { refused: TOOL_CALLS_PER_TURN_EXCEEDED, cap: verdict.cap, madeThisTurn: verdict.madeThisTurn },
    });
    throw new Error(toolCallsPerTurnRefusalMessage(verdict));
}

/** The message a tool call gets when the run has already stopped. */
export function stoppedMessage(stop: RunStop): string {
    switch (stop.kind) {
        case 'CAP':
            return stop.halt.message;
        case 'KILL':
            return 'This run was stopped by a kill switch.';
        case 'OPERATOR_ABORT':
            return 'This run was aborted by an operator.';
        case 'GUARD':
            return 'This run is stopped for review by the AI guard.';
    }
}

/**
 * Put one offered tool in the runner's shape, or `null` when its input schema is
 * not a JSON Schema object (recorded as `UNCONVERTIBLE_SCHEMA` by the core).
 */
function runnableToolFor(offered: OfferedTool, binding: ToolRunBinding, queue: SerialQueue): BetaRunnableTool<Record<string, unknown>> | null {
    const schema = offered.tool.inputSchema;
    if (schema?.type !== 'object') return null;
    const name = offered.tool.name;
    return {
        type: 'custom',
        name,
        description: offered.tool.description,
        input_schema: schema as { type: 'object'; [key: string]: unknown },
        parse: (content: unknown) => asToolArgs(content),
        run: (args: Record<string, unknown>, context?: BetaToolRunContext) =>
            queue.run(() => ledgeredCall(offered, binding, args, context?.toolUse.id ?? `${name}:unidentified`)),
    };
}

/** One tool call, charged, guarded, funnelled and recorded. */
async function ledgeredCall(
    offered: OfferedTool,
    binding: ToolRunBinding,
    args: Record<string, unknown>,
    toolCallId: string,
): Promise<string> {
    const { ctx, runId, budget } = binding;
    const name = offered.tool.name;

    const before = binding.stopped();
    if (before) throw new Error(stoppedMessage(before));

    const stepHalt = budget.charge('STEPS', 1);
    if (stepHalt) {
        binding.stopAtCap(stepHalt);
        throw new Error(stepHalt.message);
    }
    // Past the turn's tool-call cap: refused here, before the funnel is asked
    // and before any other allowance is charged.
    const turn = binding.admitToolCall();
    if (!turn.allowed) return refuseOverTurnCap(binding, name, turn, args);
    const callHalt = budget.charge('TOOL_CALLS', 1);
    if (callHalt) {
        binding.stopAtCap(callHalt);
        throw new Error(callHalt.message);
    }
    const runtimeHalt = budget.charge('RUNTIME_MS', 0);
    if (runtimeHalt) {
        binding.stopAtCap(runtimeHalt);
        throw new Error(runtimeHalt.message);
    }
    const items = isProposeTool(name) ? proposedItemCount(args) : 0;
    if (items > 0) {
        const halt = budget.charge('PROPOSALS', items);
        if (halt) {
            binding.stopAtCap(halt);
            throw new Error(halt.message);
        }
    }

    const seq = binding.nextSeq();
    binding.noteOrigin(toolCallId, seq);
    const startedAt = Date.now();
    try {
        const result = await offered.run(args, toolCallId);
        const verdict = binding.takeVerdict(toolCallId);
        await recordStep(ctx, runId, seq, 'TOOL_CALL', {
            toolCalled: name,
            status: 'DONE',
            label: name,
            guardVerdict: verdict?.verdict,
            guardRuleIds: verdict?.ruleIds,
            // The arguments the model chose, never the result: the result is
            // tenant content, already guarded on its way to the model.
            input: args,
        });
        await recordExternalToolDecision(ctx, { runId, toolName: name, status: 'DONE', latencyMs: Date.now() - startedAt });
        return result;
    } catch (err) {
        binding.onFailure();
        const verdict = binding.takeVerdict(toolCallId);
        await recordStep(ctx, runId, seq, 'TOOL_CALL', {
            toolCalled: name,
            status: 'FAILED',
            label: name,
            guardVerdict: verdict?.verdict,
            guardRuleIds: verdict?.ruleIds,
            input: args,
            output: { error: err instanceof Error ? err.message : String(err) },
        });
        await recordExternalToolDecision(ctx, { runId, toolName: name, status: 'FAILED', latencyMs: Date.now() - startedAt });
        throw err;
    } finally {
        binding.forgetOrigin(toolCallId);
        // A kill engaged, or an operator's Abort, while this call ran stops the
        // run here, before the runner sends the next model call.
        await binding.checkKill();
    }
}

/** Runs one task at a time, in the order they were queued. */
export class SerialQueue {
    private tail: Promise<unknown> = Promise.resolve();

    run<T>(task: () => Promise<T>): Promise<T> {
        const next = this.tail.then(task, task);
        // The queue continues past a failed task; the failure goes to its caller.
        this.tail = next.catch(() => undefined);
        return next;
    }
}

/**
 * The run's tools: the read surface and, unless the definition is read-only,
 * the propose surface, narrowed to the profile's tools when the run is a
 * profile's. The engine's own `activate_skill` is NOT among them: it is offered
 * beside this set (`skills.ts`), so an empty set still means a run that can
 * reach nothing.
 */
export function toolRunnerToolsFor(
    inv: McpInvocation,
    binding: ToolRunBinding,
    opts: {
        readonly readOnly: boolean;
        readonly profileTools?: readonly string[];
        readonly observe: (o: StepGuardObservation) => void;
        /**
         * The run's one queue, when the caller offers tools of its own beside
         * these (`activate_skill`, Step 2d): every call of the run waits on the
         * same queue, so the ledger's order is the order the calls were made.
         */
        readonly queue?: SerialQueue;
    },
): OfferedToolSet<BetaRunnableTool<Record<string, unknown>>> {
    const queue = opts.queue ?? new SerialQueue();
    return offerToolSet(inv, (offered) => runnableToolFor(offered, binding, queue), {
        sourcePrefix: TOOL_RUNNER_GUARD_SOURCE,
        observe: opts.observe,
        originFor: (toolCallId) => {
            const stepSeq = binding.originOf(toolCallId);
            return stepSeq === undefined ? undefined : { runId: binding.runId, stepSeq };
        },
        readOnly: opts.readOnly,
        ...(opts.profileTools ? { profileTools: opts.profileTools } : {}),
    });
}
