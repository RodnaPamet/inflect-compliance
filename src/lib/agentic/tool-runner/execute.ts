/**
 * THE TOOL RUNNER ENGINE'S LOOP (Step 2b of `docs/claude-tool-runner-design.md`).
 *
 * One runner per run, over the client `clientForRun` built for this run alone.
 * The runner calls the model, runs the tools it asks for, and calls it again;
 * this file decides, after every call, whether the run may go on.
 *
 * ── ONE LOOP BODY, FOR THE PARENT AND EVERY SUB-AGENT (Step 2e, #4594) ─────
 *
 * `runModelLoop` is the loop both the parent and a delegated sub-agent run, with
 * the sub-agent's name as a parameter (null for the parent). A second copy would
 * drift. Its body, per yielded message (one message = one model call):
 *
 *   1. the AI Guard's egress scan on the call's text, which Flue cannot do;
 *   2. a MODEL_CALL step (labelled with the sub-agent, in a child) and an Art 12
 *      row, both naming the digest of the request that produced the call
 *      (`runner.params`), and the run's tokens and step count persisted. The
 *      row's output summary is the call's text only when the scan was clean,
 *      so a secret in model output never reaches the stored summary;
 *   3. the scan's verdict, noted: anything but CLEAN settles the run at the
 *      guard. Noted before the caps (#5372), so a blocked answer that also
 *      crossed a cap still latches the breaker and writes the guard's row;
 *   4. the kill switch, uncached, and then the run's own status: a kill, or an
 *      operator's Abort (#5366), breaks the loop, so the turn's tools never
 *      run;
 *   5. a stop latched by now (a cap, a kill, the breaker, a guard verdict, this
 *      answer's included);
 *   6. the token and wall-clock caps;
 *   7. the stop reason: `refusal`, `max_tokens` and a full context window each
 *      end the loop with a named reason, and run no tool from that turn: the
 *      parent settles the run with it, a child returns it to the parent;
 *   8. in a child, every `tool_use` naming a tool it was not offered
 *      (`delegate` among them) recorded as a FAILED step,
 *      `SUBAGENT_TOOL_NOT_OFFERED`;
 *   9. BEFORE THE NEXT MODEL CALL (owner decision 4 of 2026-11-13): the turn's
 *      tools are run (`runner.generateToolResponse()`, which the runner then
 *      reuses rather than running them twice), and then the kill switch and the
 *      BREAKER are read and one STEPS is charged. The same three happen before
 *      the loop's first call. Both only narrow, in both loops.
 *
 * The body runs BEFORE the runner reads the stop reason and runs the turn's
 * tools, so every `break` in 1-7 happens before any tool of that turn.
 *
 * ── BETWEEN CALLS ───────────────────────────────────────────────────────────
 *
 * A stop found AT a tool (a cap refused, a guard verdict, a kill read when the
 * call finished) aborts the run's signal, so the next request is never sent,
 * and step 9 finds it latched. A child's request signal is
 * `AbortSignal.any([parent, child])`, so every stop the parent latches aborts a
 * child request in flight too.
 *
 * ── SETTLEMENT ──────────────────────────────────────────────────────────────
 *
 * An operator's Abort first, and it writes no settlement: the operator's
 * ABORTED stands (#5366). Then, in the order the Flue engine settles, for the
 * reasons it gives (#4230): a kill, then the breaker (Step 2e), then a cap,
 * then a guard verdict, then the
 * named stop reasons, then the iteration bound, then the empty catalogue, then
 * COMPLETED. Before the first call, a run whose offer would carry a business
 * system's rows to Anthropic with no acknowledgement on record is refused
 * outright (#5364). Model text is
 * never written to the step ledger: it reaches only the decision row's bounded,
 * sanitised summary.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { BetaToolRunnerParams } from '@anthropic-ai/sdk/lib/tools/BetaToolRunner';

import { computeInputDigest } from '@/app-layer/ai/decision-log';
import { guardEgress } from '@/app-layer/ai/guard';
import type { RequestContext } from '@/app-layer/types';
import { latchOnGuardBlock, readBreakerLatch } from '@/lib/agentic/circuit-breaker-store';
import {
    failRun,
    haltRunAtCap,
    haltRunAtGuard,
    haltRunAtKill,
    isRunAborted,
    updateRun,
    type CapBesideKill,
} from '@/lib/agentic/drivers/run-settlement';
import { getRunRow, proposedItemsSoFar } from '@/lib/agentic/drivers/run-store';
import { recordStep } from '@/lib/agentic/drivers/step-recorder';
import type { RunDriverOutcome } from '@/lib/agentic/drivers/types';
import { stepVerdictOf, type StepGuardObservation } from '@/lib/agentic/engine-tools';
import { emptyCatalogueMessage } from '@/lib/agentic/empty-catalogue-message';
import { externalResidencyRefusal, type ExternalAiAcknowledgement } from '@/lib/agentic/external-residency-gate';
import { openDeclaredRunInput, runMessage } from '@/lib/agentic/flue/run-message';
import { SkillLoadError } from '@/lib/agentic/flue/skills';
import { parseMountedSkillPins } from '@/lib/agentic/flue/skills/mount-gate';
import { skillPinDrift } from '@/lib/agentic/flue/skills/resolve';
import { resolveRunSkillMount } from '@/lib/agentic/flue/skills/tenant-mount';
import {
    KILL_SWITCH_DRILL_AGENT_ID,
    killRefusalMessage,
    resolveKillState,
    type KillVerdict,
} from '@/lib/agentic/kill-switch';
import { createRunBudget, resolveRunCaps, type RunBudget, type RunCapHalt } from '@/lib/agentic/run-caps';
import { readTurnCaps } from '@/lib/agentic/turn-caps-policy';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { recordAgentKillRefusal } from '@/lib/observability/integration-metrics';
import { logger } from '@/lib/observability/logger';
import { recordWorkflowContextIntegrityHalt } from '@/lib/observability/metrics';

import { lastRequestShape } from './client';
import { delegateTool, type ChildLoopResult } from './delegate';
import { recordToolRunnerDecision } from './model-decision';
import { lockedParams } from './params';
import { activateSkillTool, skillCatalogueText, type RunSkills } from './skills';
import {
    SerialQueue,
    TOOL_RUNNER_GUARD_SOURCE,
    TurnCallCounter,
    subagentGuardSource,
    subagentOf,
    toolRunnerToolsFor,
    type RunStop,
    type ToolRunBinding,
} from './tools';

const RANK: Record<StepGuardObservation['verdict'], number> = { CLEAN: 0, FLAGGED: 1, QUARANTINED: 2 };

/** The stop reasons that end a run with a named failure, and the message each settles with. */
export const NAMED_STOP_REASONS = {
    refusal:
        'tool_runner_model_refused: the model declined to continue this run. No tool from that turn was run.',
    max_tokens:
        'tool_runner_max_tokens: the model reached its output limit before finishing a turn. No tool from that turn was run.',
    model_context_window_exceeded:
        'tool_runner_context_exhausted: the conversation outgrew the model\'s context window. No tool from that turn was run.',
} as const;

type NamedStopReason = keyof typeof NAMED_STOP_REASONS;

function isNamedStopReason(reason: string | null): reason is NamedStopReason {
    return reason !== null && Object.prototype.hasOwnProperty.call(NAMED_STOP_REASONS, reason);
}

/** The iteration bound ran out with the model still asking for tools. */
export const ITERATIONS_EXHAUSTED_MESSAGE =
    'tool_runner_iterations_exhausted: the run reached its turn limit with the model still calling tools. The remaining work was not done.';

/** A kill-switch read that failed. The run stops rather than carry on unchecked. */
export const KILL_UNREADABLE_MESSAGE =
    'tool_runner_kill_switch_unreadable: the kill switch could not be read, so the run stopped rather than carry on unchecked.';

/** The agent's circuit breaker read OPEN before a model call (Step 2e). */
export const BREAKER_OPEN_MESSAGE =
    'tool_runner_breaker_open: this agent\'s circuit breaker is latched open, so the run stopped before its next model call. An administrator must review and close it.';

/** A breaker read that failed. The run stops rather than carry on unchecked, as for the kill switch. */
export const BREAKER_UNREADABLE_MESSAGE =
    'tool_runner_breaker_unreadable: the circuit breaker could not be read, so the run stopped rather than carry on unchecked.';

/** The text a model call produced, from its text blocks only. */
export function textOf(message: Pick<BetaMessage, 'content'>): string {
    return message.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
}

/** Every token a call spent, cache reads and writes included. */
function tokensOf(message: Pick<BetaMessage, 'usage'>): { total: number; tokensIn: number; tokensOut: number } {
    const u = message.usage;
    const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const tokensIn = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
    const tokensOut = n(u.output_tokens);
    return { total: tokensIn + tokensOut, tokensIn, tokensOut };
}

/** Will the runner send another request after this reply? The SDK continues on these two. */
function asksForAnotherCall(stopReason: string | null): boolean {
    return stopReason === 'tool_use' || stopReason === 'pause_turn';
}

/** The run-wide state both loops share: one budget, one ledger counter, one set of stops, one token total. */
interface LoopRuntime {
    readonly ctx: RequestContext;
    readonly runId: string;
    readonly def: WorkflowDefinition;
    readonly client: Anthropic;
    readonly budget: RunBudget;
    /** The parent's binding: the stops, the kill and breaker reads, the cap latch. */
    readonly binding: ToolRunBinding;
    noteVerdict(o: StepGuardObservation): void;
    /** Add a call's tokens to the run's total, and return the total. */
    addTokens(n: number): number;
    costTokens(): number;
    seq(): number;
    /** Milliseconds since the last activity, and mark now. */
    sinceActivity(): number;
    markActivity(): void;
}

/** One loop: the parent's (no sub-agent) or a delegated sub-agent's. */
interface LoopSpec {
    /** The sub-agent's name, or null for the parent. */
    readonly subagent: string | null;
    /** The binding its tools use: the parent's, or the child's labelled copy. */
    readonly binding: ToolRunBinding;
    readonly params: BetaToolRunnerParams & { stream: false };
    readonly signal: AbortSignal;
    /** Told the loop's turn number before its tools run. */
    readonly onTurn: (turn: number) => void;
    /** A child only: the names it was offered, so any other request is recorded as refused. */
    readonly offeredNames?: ReadonlySet<string>;
    /** A child only: the names the run knows, so a refused request records a known name and never the model's. */
    readonly knownNames?: ReadonlySet<string>;
}

/** Why a model call may not be sent, checked before EVERY model call in BOTH loops (owner decision 4). */
async function stoppedBeforeModelCall(rt: LoopRuntime): Promise<boolean> {
    if (rt.binding.stopped()) return true;
    if (await rt.binding.checkKill()) return true;
    if (await rt.binding.checkBreaker()) return true;
    // Every model call is a step of the run, charged before it is sent. Only
    // narrows: a run may halt at STEPS sooner than it did before (owner
    // decision 4 of 2026-11-13, accepted).
    const halt = rt.budget.charge('STEPS', 1);
    if (halt) {
        rt.binding.stopAtCap(halt);
        return true;
    }
    return false;
}

/**
 * THE ONE LOOP BODY (Step 2e). The parent and every sub-agent run this, with
 * the sub-agent's name as a parameter. See the module header for its order.
 */
async function runModelLoop(rt: LoopRuntime, spec: LoopSpec): Promise<ChildLoopResult & { namedStop: NamedStopReason | null }> {
    const { ctx, runId, def, client, budget } = rt;
    const label = spec.subagent === null ? {} : { subagent: spec.subagent };
    const outputSource = spec.subagent === null ? TOOL_RUNNER_GUARD_SOURCE : subagentGuardSource(spec.subagent);
    let calls = 0;
    let namedStop: NamedStopReason | null = null;
    let lastStopReason: string | null = null;
    let failure: string | null = null;
    let lastText = '';

    if (await stoppedBeforeModelCall(rt)) return { calls, namedStop, lastStopReason, failure, lastText };

    rt.markActivity();
    const runner = client.beta.messages.toolRunner(spec.params, { signal: spec.signal });
    const maxIterations = spec.params.max_iterations ?? Number.POSITIVE_INFINITY;
    try {
        for await (const reply of runner) {
            calls += 1;
            spec.onTurn(calls);
            const request = runner.params;
            const usage = tokensOf(reply);
            const text = textOf(reply);
            lastText = text;
            const costTokens = rt.addTokens(usage.total);

            // 1. The egress scan on the call's text.
            const outcome =
                text.length > 0
                    ? await guardEgress(ctx, text, { source: `${outputSource}-model-output:${runId}:${calls}` })
                    : null;
            const textVerdict = outcome ? stepVerdictOf(outcome) : 'CLEAN';

            // 2. The MODEL_CALL step and the Art 12 row. What went over the wire
            // for this call, by shape only (Step 2H): the run's page shows it,
            // so `thread: false` is read on the run itself.
            const sent = lastRequestShape(client);
            await recordStep(ctx, runId, rt.binding.nextSeq(), 'MODEL_CALL', {
                status: 'DONE',
                label: def.key,
                tokens: usage.total,
                input: {
                    modelCalls: 1,
                    model: reply.model,
                    stopReason: reply.stop_reason,
                    decisionDigest: computeInputDigest(request),
                    wire: sent
                        ? { method: sent.method, path: sent.path, bodyKeys: sent.bodyKeys, threadMember: sent.threadMember }
                        : null,
                },
                ...label,
            });
            await recordToolRunnerDecision(
                ctx,
                runId,
                def,
                request,
                text.length > 0 && textVerdict === 'CLEAN' ? text : null,
                { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut },
                reply.model,
                rt.sinceActivity(),
            );
            await updateRun(ctx, runId, { costTokens, stepCount: rt.seq() });

            // 3. The answer's verdict is NOTED FIRST (#5372), before the caps
            // below can latch, so a QUARANTINED answer that also crossed a cap
            // settles at the guard. The kill is still read: an operator's kill
            // outranks the verdict at settlement, as it does on Flue.
            if (outcome && textVerdict !== 'CLEAN') {
                rt.noteVerdict({
                    toolCallId: spec.subagent === null ? `model-output:${calls}` : `model-output:${spec.subagent}:${calls}`,
                    tool: 'model-output',
                    slice: 'result',
                    verdict: textVerdict,
                    ruleIds: outcome.ruleIds,
                });
            }

            // 4-5. The kill switch and the run's status; a stop latched by now.
            if (await rt.binding.checkKill()) break;
            if (rt.binding.stopped()) break;

            // 6. The token and wall-clock caps.
            const tokenHalt = budget.charge('TOKENS', costTokens - budget.used('TOKENS'));
            if (tokenHalt) {
                rt.binding.stopAtCap(tokenHalt);
                break;
            }
            const runtimeHalt = budget.charge('RUNTIME_MS', 0);
            if (runtimeHalt) {
                rt.binding.stopAtCap(runtimeHalt);
                break;
            }

            // 7. The named stop reasons.
            lastStopReason = reply.stop_reason;
            if (isNamedStopReason(reply.stop_reason)) {
                namedStop = reply.stop_reason;
                break;
            }

            // 8. A child's request for a tool it was not offered: the SDK
            // answers it `not found` and runs nothing, and the ledger says so.
            if (spec.offeredNames) {
                let halted = false;
                for (const block of reply.content) {
                    if (block.type !== 'tool_use' || spec.offeredNames.has(block.name)) continue;
                    const stepHalt = budget.charge('STEPS', 1);
                    if (stepHalt) {
                        rt.binding.stopAtCap(stepHalt);
                        halted = true;
                        break;
                    }
                    spec.binding.onFailure();
                    await recordStep(ctx, runId, rt.binding.nextSeq(), 'TOOL_CALL', {
                        ...(spec.knownNames?.has(block.name) ? { toolCalled: block.name } : {}),
                        status: 'FAILED',
                        label: 'subagent-tool-not-offered',
                        output: { refused: 'SUBAGENT_TOOL_NOT_OFFERED' },
                        ...subagentOf(spec.binding),
                    });
                }
                if (halted) break;
            }

            // 9. Before the next model call: the turn's tools, then the kill
            // switch, the breaker and one STEPS (owner decision 4). The runner
            // reuses the tool response it caches here, so nothing runs twice.
            if (asksForAnotherCall(reply.stop_reason) && calls < maxIterations) {
                await runner.generateToolResponse();
                if (await stoppedBeforeModelCall(rt)) break;
            }
            rt.markActivity();
        }
    } catch (err) {
        // An abort this run asked for is a stop, settled by its cause. Anything
        // else is a failure.
        if (rt.binding.stopped() === null) {
            failure = err instanceof Error ? err.message : String(err);
        }
    }
    return { calls, namedStop, lastStopReason, failure, lastText };
}

export async function executeToolRunnerRun(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    fromSeq: number,
    runStartMs: number,
    client: Anthropic,
    /**
     * Where this run's model calls go, and the tenant's business-data transfer
     * acknowledgement, both decided by the DRIVER before anything was read
     * here (#5364). Required: the transfer gate below refuses on an absent
     * acknowledgement, and a caller that forgot it should not compile.
     */
    route: { readonly providerId: string; readonly externalAiAcknowledgement: ExternalAiAcknowledgement },
): Promise<RunDriverOutcome> {
    // ── The kill switch, before anything is read or sent ────────────────────
    const kill = await resolveKillState(ctx.tenantId, ctx.agentId ?? null);
    if (kill) {
        recordAgentKillRefusal({ scope: kill.scope, drill: ctx.agentId === KILL_SWITCH_DRILL_AGENT_ID });
        const status = await haltRunAtKill(ctx, runId, kill, killRefusalMessage(kill.scope), null, 'tool_runner');
        return { status, stepFailures: 0 };
    }

    const initial = await getRunRow(ctx, runId);
    let costTokens = initial.costTokens ?? 0;

    const declared = openDeclaredRunInput({
        tenantId: ctx.tenantId,
        runId,
        def,
        storedJson: initial.contextJson ?? null,
        storedHash: initial.contextHash ?? null,
    });
    if (!declared.ok) {
        if (declared.integrityCode) recordWorkflowContextIntegrityHalt({ code: declared.integrityCode });
        const status = await failRun(ctx, runId, declared.message);
        return { status, stepFailures: 0 };
    }
    const message = runMessage(def, declared.input);

    // ── The run's skills (Step 2d) ──────────────────────────────────────────
    // Through the ONE resolver every reasoning engine uses, so the gate, the
    // budget and the pins are Flue's: the definition's skills, or the ones a
    // profile's version names, in this run's own tenant. And they must be the
    // ones the row pinned at admission: a deploy, an approval or a retirement
    // between segments would otherwise teach the run something its own row
    // does not describe. Both refusals settle before anything is sent.
    let skills: RunSkills;
    try {
        const mount = await resolveRunSkillMount(ctx, def);
        const drift = skillPinDrift(initial.mountedSkills, mount.pins);
        if (drift) {
            const status = await failRun(ctx, runId, `skill_pin_drift: ${drift}`);
            return { status, stepFailures: 0 };
        }
        // The row's pins when it has them, so an activation is checked against
        // what admission recorded rather than against this segment's reading.
        skills = { documents: mount.documents, pins: parseMountedSkillPins(initial.mountedSkills) ?? mount.pins };
    } catch (err) {
        if (!(err instanceof SkillLoadError)) throw err;
        const status = await failRun(ctx, runId, `skill_not_mountable: ${err.message}`);
        return { status, stepFailures: 0 };
    }

    const invocation = await resolveMcpInvocation(ctx, { actionsAlready: fromSeq });
    const caps = resolveRunCaps(invocation.policyCard?.inForce.value ?? null);
    const budget = createRunBudget({
        caps,
        now: () => Date.now(),
        startedAtMs: runStartMs,
        spent: {
            STEPS: fromSeq,
            TOOL_CALLS: fromSeq,
            PROPOSALS: await proposedItemsSoFar(ctx, runId),
            TOKENS: costTokens,
        },
    });

    // The wall clock, before the first call.
    const preflight = budget.charge('RUNTIME_MS', 0);
    if (preflight) {
        const status = await haltRunAtCap(ctx, runId, preflight, null);
        return { status, stepFailures: 0 };
    }

    // ── The turn caps (#4594), read ONCE for the segment ────────────────────
    // The lower of the organization's ceiling and the workspace's narrowing.
    // Read once so no turn changes cap mid-way: an organization lowering its
    // ceiling reaches the next segment any run reads. A failed read is 0
    // delegations and 1 tool call, and never throws. The same values bind the
    // parent's loop and every sub-agent's.
    const turnCaps = await readTurnCaps(ctx.tenantId, ctx.requestId);
    const turnCalls = new TurnCallCounter(turnCaps.toolCallsPerTurn.value);

    // ── The run's state, shared by both loops and their tools ───────────────
    const controller = new AbortController();
    // ONE object, so a check in the loop sees what a tool's closure latched:
    // locals assigned only inside closures read as never-set to the compiler.
    const state: {
        capHalt: RunCapHalt | null;
        killVerdict: KillVerdict | null;
        killAfterCap: boolean;
        killUnreadable: boolean;
        operatorAborted: boolean;
        breakerOpen: boolean;
        breakerUnreadable: boolean;
        worst: StepGuardObservation['verdict'];
        worstRuleIds: readonly string[];
    } = {
        capHalt: null,
        killVerdict: null,
        killAfterCap: false,
        killUnreadable: false,
        operatorAborted: false,
        breakerOpen: false,
        breakerUnreadable: false,
        worst: 'CLEAN',
        worstRuleIds: [],
    };
    const seen = new Map<string, StepGuardObservation>();
    const origins = new Map<string, number>();
    let seq = fromSeq;
    let stepFailures = 0;
    let lastActivityAt = Date.now();
    // The PARENT's model calls answered in this segment: the number of the turn
    // whose tools the runner is running, since it runs a turn's tools after
    // yielding it.
    let parentCalls = 0;

    const stopped = (): RunStop | null => {
        if (state.operatorAborted) return { kind: 'OPERATOR_ABORT' };
        if (state.killVerdict || state.killUnreadable) return { kind: 'KILL' };
        if (state.breakerOpen || state.breakerUnreadable) return { kind: 'BREAKER' };
        if (state.capHalt) return { kind: 'CAP', halt: state.capHalt };
        if (state.worst !== 'CLEAN') return { kind: 'GUARD' };
        return null;
    };

    const checkKill = async (): Promise<boolean> => {
        let found: KillVerdict | null;
        try {
            found = await resolveKillState(ctx.tenantId, ctx.agentId ?? null);
        } catch (err) {
            // Fail closed: a switch nobody can read is not a switch that is off.
            logger.warn('tool-runner: kill-switch read failed; stopping the run', {
                component: 'agentic',
                runId,
                error: err instanceof Error ? err.message : 'a non-Error value was thrown',
            });
            state.killUnreadable = true;
            controller.abort();
            return true;
        }
        if (!found) {
            // AN OPERATOR'S ABORT STOPS THE RUN WHERE A KILL DOES (#5366). The
            // run row is the switch here: `abortWorkflowRun` wrote ABORTED, and
            // without this read the loop called the model again and settled
            // over it. One indexed read of two columns, beside the kill read.
            // A read that throws is not caught: the loop's failure path stops
            // the run.
            if (!(await isRunAborted(ctx, runId))) return false;
            state.operatorAborted = true;
            controller.abort();
            return true;
        }
        recordAgentKillRefusal({ scope: found.scope, drill: ctx.agentId === KILL_SWITCH_DRILL_AGENT_ID });
        if (state.killVerdict === null) state.killAfterCap = state.capHalt !== null;
        state.killVerdict = found;
        controller.abort();
        return true;
    };

    // THE BREAKER, uncached, before every model call in both loops and at a
    // delegation (Step 2e, owner decision 4). OPEN stops the run, as the funnel
    // refuses every call while it is open; an unreadable latch stops it too,
    // as an unreadable kill switch does. An agent the breaker has never
    // observed reads `null`, which is not a refusal.
    const checkBreaker = async (): Promise<boolean> => {
        if (!ctx.agentId) return false;
        try {
            const latch = await readBreakerLatch(ctx.tenantId, ctx.agentId);
            if (latch?.state !== 'OPEN') return false;
            state.breakerOpen = true;
        } catch (err) {
            logger.warn('tool-runner: circuit-breaker read failed; stopping the run', {
                component: 'agentic',
                runId,
                error: err instanceof Error ? err.message : 'a non-Error value was thrown',
            });
            state.breakerUnreadable = true;
        }
        controller.abort();
        return true;
    };

    const noteVerdict = (o: StepGuardObservation): void => {
        const prior = seen.get(o.toolCallId);
        seen.set(o.toolCallId, prior && RANK[prior.verdict] >= RANK[o.verdict] ? prior : o);
        if (RANK[o.verdict] > RANK[state.worst]) {
            state.worst = o.verdict;
            state.worstRuleIds = o.ruleIds;
        }
        // A verdict stops the run before the next model call, so a flagged
        // result never reaches the model, not even as a refusal.
        if (o.verdict !== 'CLEAN') controller.abort();
    };

    const binding: ToolRunBinding = {
        ctx,
        runId,
        budget,
        subagent: null,
        nextSeq: () => seq++,
        peekSeq: () => seq,
        stopped,
        stopAtCap: (halt) => {
            if (state.capHalt === null) state.capHalt = halt;
            controller.abort();
        },
        checkKill: async () => {
            const killed = await checkKill();
            lastActivityAt = Date.now();
            return killed;
        },
        checkBreaker,
        takeVerdict: (id) => {
            const o = seen.get(id);
            seen.delete(id);
            return o;
        },
        noteOrigin: (id, stepSeq) => {
            origins.set(id, stepSeq);
        },
        originOf: (id) => origins.get(id),
        forgetOrigin: (id) => {
            origins.delete(id);
        },
        onFailure: () => {
            stepFailures += 1;
        },
        admitToolCall: () => turnCalls.admit('parent', parentCalls),
    };

    const rt: LoopRuntime = {
        ctx,
        runId,
        def,
        client,
        budget,
        binding,
        noteVerdict,
        addTokens: (n) => {
            costTokens += n;
            return costTokens;
        },
        costTokens: () => costTokens,
        seq: () => seq,
        sinceActivity: () => Date.now() - lastActivityAt,
        markActivity: () => {
            lastActivityAt = Date.now();
        },
    };

    // ONE queue for every call of the parent, the engine's own included, so the
    // ledger's order is the order the calls were made. A delegation runs its
    // child inside this queue, on the child's own.
    const queue = new SerialQueue();
    const offered = toolRunnerToolsFor(invocation, binding, {
        readOnly: def.readOnly === true,
        ...(def.profile ? { profileTools: def.profile.toolNames } : {}),
        observe: noteVerdict,
        queue,
    });

    // A RUN THAT COULD REACH NOTHING sends nothing. Flue makes one call against
    // an empty catalogue and then settles; this engine settles first, so no
    // tenant content goes out for a run that can do nothing with the answer.
    if (offered.tools.length === 0) {
        const settled = await updateRun(ctx, runId, {
            status: 'EMPTY_CATALOGUE',
            completedAt: new Date(),
            stepCount: seq,
            costTokens,
            // WHY it is empty, from the offer's reasons and the invocation's
            // pinned lists (#5045): "holds no grants" only when it holds none.
            errorMessage: emptyCatalogueMessage('tool_runner', {
                grantedTools: invocation.grantedTools,
                permittedTools: invocation.policyCard?.inForce.value.permittedTools ?? null,
                offeredTools: invocation.offeredTools,
                omitted: offered.omitted,
                ...(def.profile ? { profileTools: def.profile.toolNames } : {}),
            }),
        });
        // Not written over an operator's abort (#5366), and not reported as
        // though it had been.
        if (!settled) return { status: 'ABORTED', stepFailures: 0 };
        return { status: 'EMPTY_CATALOGUE', stepFailures: 1 };
    }

    // ── ROUTING AN ERP'S ROWS OUTSIDE THE DEPLOYMENT IS A TRANSFER (#3872) ──
    //
    // Asked here for the reasons Flue asks it where it does (#5364): AFTER the
    // offer, because a tool withheld from it transfers nothing, and BEFORE the
    // runner sends its first request, because after that the transfer the gate
    // exists to refuse has happened. This engine always calls Anthropic, so a
    // business-system tool in the offer with no acknowledgement on record
    // refuses the whole run — never by dropping those tools and carrying on.
    // A sub-agent's tools are a filter of this offer, so the gate covers them.
    const transferRefusal = externalResidencyRefusal({
        providerId: route.providerId,
        offered: offered.externalConnections.map((c) => ({
            name: c.connectionName,
            connectionId: c.connectionId,
            connectionName: c.connectionName,
            reachesBusinessSystem: c.reachesBusinessSystem,
        })),
        acknowledgement: route.externalAiAcknowledgement,
        enginePrefix: 'tool_runner',
    });
    if (transferRefusal) {
        const status = await failRun(ctx, runId, transferRefusal.message);
        return { status, stepFailures: 0 };
    }

    // The engine's own tools go BESIDE the resolved set, after the empty check
    // above: a run that can read its skills but reach no tenant data still has
    // nothing to do with an answer. `delegate` (Step 2e) is offered to the
    // parent only, and only when the version defines sub-agents.
    const skillTool = activateSkillTool(binding, skills, queue);
    const subagents = def.profile?.subagents ?? [];
    const delegation = delegateTool(
        {
            binding,
            invocation,
            def,
            caps,
            skills,
            subagents,
            turnCaps: {
                delegationsPerTurn: turnCaps.delegationsPerTurn.value,
                toolCallsPerTurn: turnCaps.toolCallsPerTurn.value,
            },
            turnCalls,
            parentTurn: () => parentCalls,
            review: offered.review,
            observe: noteVerdict,
            parentOffered: new Set(offered.tools.map((t) => t.name)),
            parentSignal: controller.signal,
            runLoop: (child) =>
                runModelLoop(rt, {
                    subagent: child.subagent,
                    binding: child.binding,
                    params: child.params,
                    signal: child.signal,
                    onTurn: child.onTurn,
                    offeredNames: child.offeredNames,
                    knownNames: child.knownNames,
                }),
        },
        queue,
    );
    const params = lockedParams({
        def,
        tools: [...offered.tools, ...(skillTool ? [skillTool] : []), ...(delegation ? [delegation] : [])],
        message,
        caps,
        fromSeq,
        skillCatalogue: skillCatalogueText(skills.documents),
        toolCallsPerTurn: turnCaps.toolCallsPerTurn.value,
    });
    logger.info('tool-runner: dispatching', {
        component: 'agentic',
        runId,
        workflow: def.key,
        model: params.model,
        toolsOffered: offered.tools.length,
        toolsOmitted: offered.omitted.length,
        skillsMounted: skills.documents.length,
        subagentsDefined: subagents.length,
        toolCallsPerTurn: turnCaps.toolCallsPerTurn.value,
        toolCallsPerTurnBasis: turnCaps.toolCallsPerTurn.basis,
        delegationsPerTurn: turnCaps.delegationsPerTurn.value,
    });

    const parent = await runModelLoop(rt, {
        subagent: null,
        binding,
        params,
        signal: controller.signal,
        onTurn: (n) => {
            parentCalls = n;
        },
    });

    // ── Settlement ──────────────────────────────────────────────────────────
    await updateRun(ctx, runId, { costTokens, stepCount: seq });

    // The operator's ABORTED is the settlement (#5366). The tokens and steps
    // above are accounting and land; no status, reason or audit row follows.
    if (state.operatorAborted) return { status: 'ABORTED', stepFailures };

    if (state.killVerdict) {
        const beside: CapBesideKill | null = state.capHalt
            ? { halt: state.capHalt, observedFirst: state.killAfterCap ? 'CAP' : 'KILL' }
            : null;
        const status = await haltRunAtKill(
            ctx,
            runId,
            state.killVerdict,
            killRefusalMessage(state.killVerdict.scope),
            beside,
            'tool_runner',
        );
        return { status, stepFailures };
    }
    if (state.killUnreadable) {
        const status = await failRun(ctx, runId, KILL_UNREADABLE_MESSAGE);
        return { status, stepFailures: stepFailures + 1 };
    }
    if (state.breakerOpen || state.breakerUnreadable) {
        const status = await failRun(ctx, runId, state.breakerOpen ? BREAKER_OPEN_MESSAGE : BREAKER_UNREADABLE_MESSAGE);
        return { status, stepFailures: stepFailures + 1 };
    }
    if (state.capHalt) {
        const status = await haltRunAtCap(ctx, runId, state.capHalt, null);
        return { status, stepFailures };
    }
    if (state.worst !== 'CLEAN') {
        if (state.worst === 'QUARANTINED' && ctx.agentId) {
            await latchOnGuardBlock(ctx.tenantId, ctx.agentId, new Date());
        }
        const status = await haltRunAtGuard(ctx, runId, state.worst, state.worstRuleIds, 'tool_runner');
        return { status, stepFailures };
    }
    if (parent.failure !== null) {
        const status = await failRun(ctx, runId, `tool_runner_run_failed: ${parent.failure}`);
        return { status, stepFailures: stepFailures + 1 };
    }
    if (parent.namedStop) {
        const status = await failRun(ctx, runId, NAMED_STOP_REASONS[parent.namedStop]);
        return { status, stepFailures: stepFailures + 1 };
    }
    if (parent.calls === 0 || parent.lastStopReason === 'tool_use' || parent.lastStopReason === 'pause_turn') {
        const status = await failRun(ctx, runId, ITERATIONS_EXHAUSTED_MESSAGE);
        return { status, stepFailures: stepFailures + 1 };
    }

    const completed = await updateRun(ctx, runId, { status: 'COMPLETED', completedAt: new Date(), stepCount: seq, costTokens });
    // Aborted after the last check: the operator's ABORTED stands (#5366).
    if (!completed) return { status: 'ABORTED', stepFailures };
    return { status: 'COMPLETED', stepFailures };
}
