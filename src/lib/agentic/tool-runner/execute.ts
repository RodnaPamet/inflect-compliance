/**
 * THE TOOL RUNNER ENGINE'S LOOP (Step 2b of `docs/claude-tool-runner-design.md`).
 *
 * One runner per run, over the client `clientForRun` built for this run alone.
 * The runner calls the model, runs the tools it asks for, and calls it again;
 * this file decides, after every call, whether the run may go on.
 *
 * ── PER YIELDED MESSAGE (one message = one model call) ──────────────────────
 *
 *   1. the AI Guard's egress scan on the call's text, which Flue cannot do;
 *   2. a MODEL_CALL step and an Art 12 row, both naming the digest of the
 *      request that produced the call (`runner.params`), and the run's tokens
 *      and step count persisted. The row's output summary is the call's text
 *      only when the scan was clean, so a secret in model output never reaches
 *      the stored summary;
 *   3. the kill switch, uncached; a kill breaks the loop, so the turn's tools
 *      never run;
 *   4. a stop latched while the previous turn's tools ran (a cap, a kill, a
 *      guard verdict);
 *   5. the token and wall-clock caps;
 *   6. the scan's verdict: anything but CLEAN settles the run at the guard;
 *   7. the stop reason: `refusal`, `max_tokens` and a full context window each
 *      settle the run with a named reason, and run no tool from that turn.
 *
 * The loop body runs BEFORE the runner reads the stop reason and runs the
 * turn's tools, so every `break` above happens before any tool of that turn.
 *
 * ── BETWEEN CALLS ───────────────────────────────────────────────────────────
 *
 * The runner sends the next request straight after the turn's tools. A stop
 * found AT a tool (a cap refused, a guard verdict, a kill read when the call
 * finished) aborts the run's signal, so that request is never sent: the
 * equivalent of Flue's check before every model call (#4196), placed where this
 * engine can place it.
 *
 * ── SETTLEMENT ──────────────────────────────────────────────────────────────
 *
 * In the order the Flue engine settles, for the reasons it gives (#4230): a
 * kill, then a cap, then a guard verdict, then the named stop reasons, then the
 * iteration bound, then the empty catalogue, then COMPLETED. Model text is
 * never written to the step ledger: it reaches only the decision row's bounded,
 * sanitised summary.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';

import { computeInputDigest } from '@/app-layer/ai/decision-log';
import { guardEgress } from '@/app-layer/ai/guard';
import type { RequestContext } from '@/app-layer/types';
import { latchOnGuardBlock } from '@/lib/agentic/circuit-breaker-store';
import {
    failRun,
    haltRunAtCap,
    haltRunAtGuard,
    haltRunAtKill,
    updateRun,
    type CapBesideKill,
} from '@/lib/agentic/drivers/run-settlement';
import { getRunRow, proposedItemsSoFar } from '@/lib/agentic/drivers/run-store';
import { recordStep } from '@/lib/agentic/drivers/step-recorder';
import type { RunDriverOutcome } from '@/lib/agentic/drivers/types';
import { stepVerdictOf, type StepGuardObservation } from '@/lib/agentic/engine-tools';
import { EMPTY_TOOLSET_MESSAGE } from '@/lib/agentic/flue/empty-toolset-message';
import { openDeclaredRunInput, runMessage } from '@/lib/agentic/flue/run-message';
import {
    KILL_SWITCH_DRILL_AGENT_ID,
    killRefusalMessage,
    resolveKillState,
    type KillVerdict,
} from '@/lib/agentic/kill-switch';
import { createRunBudget, resolveRunCaps, type RunCapHalt } from '@/lib/agentic/run-caps';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { recordAgentKillRefusal } from '@/lib/observability/integration-metrics';
import { logger } from '@/lib/observability/logger';
import { recordWorkflowContextIntegrityHalt } from '@/lib/observability/metrics';

import { recordToolRunnerDecision } from './model-decision';
import { lockedParams } from './params';
import { toolRunnerToolsFor, type RunStop, type ToolRunBinding } from './tools';

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

export async function executeToolRunnerRun(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    fromSeq: number,
    runStartMs: number,
    client: Anthropic,
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
    const message = runMessage(def, fromSeq, declared.input);

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

    // ── The run's state, shared by the loop and its tools ───────────────────
    const controller = new AbortController();
    // ONE object, so a check in the loop sees what a tool's closure latched:
    // locals assigned only inside closures read as never-set to the compiler.
    const state: {
        capHalt: RunCapHalt | null;
        killVerdict: KillVerdict | null;
        killAfterCap: boolean;
        killUnreadable: boolean;
        worst: StepGuardObservation['verdict'];
        worstRuleIds: readonly string[];
    } = { capHalt: null, killVerdict: null, killAfterCap: false, killUnreadable: false, worst: 'CLEAN', worstRuleIds: [] };
    const seen = new Map<string, StepGuardObservation>();
    const origins = new Map<string, number>();
    let seq = fromSeq;
    let stepFailures = 0;
    let lastActivityAt = Date.now();

    const stopped = (): RunStop | null => {
        if (state.killVerdict || state.killUnreadable) return { kind: 'KILL' };
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
        if (!found) return false;
        recordAgentKillRefusal({ scope: found.scope, drill: ctx.agentId === KILL_SWITCH_DRILL_AGENT_ID });
        if (state.killVerdict === null) state.killAfterCap = state.capHalt !== null;
        state.killVerdict = found;
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
        nextSeq: () => seq++,
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
    };

    const offered = toolRunnerToolsFor(invocation, binding, {
        readOnly: def.readOnly === true,
        ...(def.profile ? { profileTools: def.profile.toolNames } : {}),
        observe: noteVerdict,
    });

    // A RUN THAT COULD REACH NOTHING sends nothing. Flue makes one call against
    // an empty catalogue and then settles; this engine settles first, so no
    // tenant content goes out for a run that can do nothing with the answer.
    if (offered.tools.length === 0) {
        await updateRun(ctx, runId, {
            status: 'EMPTY_CATALOGUE',
            completedAt: new Date(),
            stepCount: seq,
            costTokens,
            errorMessage: EMPTY_TOOLSET_MESSAGE,
        });
        return { status: 'EMPTY_CATALOGUE', stepFailures: 1 };
    }

    const params = lockedParams({ def, tools: offered.tools, message, caps, fromSeq });
    logger.info('tool-runner: dispatching', {
        component: 'agentic',
        runId,
        workflow: def.key,
        model: params.model,
        toolsOffered: offered.tools.length,
        toolsOmitted: offered.omitted.length,
    });

    lastActivityAt = Date.now();
    const runner = client.beta.messages.toolRunner(params, { signal: controller.signal });
    let namedStop: NamedStopReason | null = null;
    let lastStopReason: string | null = null;
    let calls = 0;
    let failure: string | null = null;

    try {
        for await (const reply of runner) {
            calls += 1;
            const request = runner.params;
            const usage = tokensOf(reply);
            const text = textOf(reply);
            costTokens += usage.total;

            const outcome =
                text.length > 0
                    ? await guardEgress(ctx, text, { source: `tool-runner-model-output:${runId}:${calls}` })
                    : null;
            const textVerdict = outcome ? stepVerdictOf(outcome) : 'CLEAN';

            await recordStep(ctx, runId, seq++, 'MODEL_CALL', {
                status: 'DONE',
                label: def.key,
                tokens: usage.total,
                input: {
                    modelCalls: 1,
                    model: reply.model,
                    stopReason: reply.stop_reason,
                    decisionDigest: computeInputDigest(request),
                },
            });
            await recordToolRunnerDecision(
                ctx,
                runId,
                def,
                request,
                text.length > 0 && textVerdict === 'CLEAN' ? text : null,
                { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut },
                reply.model,
                Date.now() - lastActivityAt,
            );
            await updateRun(ctx, runId, { costTokens, stepCount: seq });

            if (await checkKill()) break;
            if (stopped()) break;

            const tokenHalt = budget.charge('TOKENS', costTokens - budget.used('TOKENS'));
            if (tokenHalt) {
                binding.stopAtCap(tokenHalt);
                break;
            }
            const runtimeHalt = budget.charge('RUNTIME_MS', 0);
            if (runtimeHalt) {
                binding.stopAtCap(runtimeHalt);
                break;
            }

            if (outcome && textVerdict !== 'CLEAN') {
                noteVerdict({
                    toolCallId: `model-output:${calls}`,
                    tool: 'model-output',
                    slice: 'result',
                    verdict: textVerdict,
                    ruleIds: outcome.ruleIds,
                });
                break;
            }

            lastStopReason = reply.stop_reason;
            if (isNamedStopReason(reply.stop_reason)) {
                namedStop = reply.stop_reason;
                break;
            }
            lastActivityAt = Date.now();
        }
    } catch (err) {
        // An abort this run asked for is a stop, settled below by its cause.
        // Anything else is a failure.
        if (stopped() === null) {
            failure = err instanceof Error ? err.message : String(err);
        }
    }

    // ── Settlement ──────────────────────────────────────────────────────────
    await updateRun(ctx, runId, { costTokens, stepCount: seq });

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
    if (state.capHalt) {
        const status = await haltRunAtCap(ctx, runId, state.capHalt, null);
        return { status, stepFailures };
    }
    if (state.worst !== 'CLEAN') {
        if (state.worst === 'QUARANTINED' && ctx.agentId) {
            await latchOnGuardBlock(ctx.tenantId, ctx.agentId, new Date());
        }
        const status = await haltRunAtGuard(ctx, runId, state.worst, state.worstRuleIds);
        return { status, stepFailures };
    }
    if (failure !== null) {
        const status = await failRun(ctx, runId, `tool_runner_run_failed: ${failure}`);
        return { status, stepFailures: stepFailures + 1 };
    }
    if (namedStop) {
        const status = await failRun(ctx, runId, NAMED_STOP_REASONS[namedStop]);
        return { status, stepFailures: stepFailures + 1 };
    }
    if (calls === 0 || lastStopReason === 'tool_use' || lastStopReason === 'pause_turn') {
        const status = await failRun(ctx, runId, ITERATIONS_EXHAUSTED_MESSAGE);
        return { status, stepFailures: stepFailures + 1 };
    }

    await updateRun(ctx, runId, { status: 'COMPLETED', completedAt: new Date(), stepCount: seq, costTokens });
    return { status: 'COMPLETED', stepFailures };
}
