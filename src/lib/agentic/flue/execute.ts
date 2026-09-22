import { init } from '@flue/runtime';

import type { RequestContext } from '@/app-layer/types';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import type { RunDriverOutcome } from '@/lib/agentic/drivers/types';
import { recordStep } from '@/lib/agentic/drivers/step-recorder';
import { updateRun, failRun, haltRunAtCap } from '@/lib/agentic/drivers/run-settlement';
import { getRunRow, proposedItemsSoFar } from '@/lib/agentic/drivers/run-store';
import { createRunBudget, resolveRunCaps, type RunCapHalt } from '@/lib/agentic/run-caps';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { logger } from '@/lib/observability/logger';

import { FLUE_USAGE_KEY, InflectAgent, type FlueUsageReport } from './agent';
import { flueModelIsRegistered } from './providers';
import { refusalMessage } from './driver-plan';
import { bindRun, releaseRun } from './run-binding';
import { ensureFlueRuntime } from './runtime-start';
import {
    flueToolsFor,
    type FlueToolDefinition,
    type StepGuardObservation,
} from './tools-adapter';

/**
 * EXECUTING A FLUE RUN: bind, dispatch, record what happened, charge for it.
 *
 * ── LOADED ONLY BY DYNAMIC IMPORT ───────────────────────────────────────────
 *
 * This module's graph reaches `@flue/runtime` and `@earendil-works/pi-ai`,
 * both ESM-only with no `require` condition. `driver.ts` reaches it through
 * `await import('./execute')` on the path that has already decided a Flue run
 * is happening, so no suite that merely touches the driver registry has to
 * load an ESM package.
 *
 * That ONE dynamic edge is the whole boundary, and it names a RELATIVE module
 * rather than an `@flue/*` one on purpose. Inside the boundary the ESM
 * packages are imported STATICALLY — `flue-refused-capabilities` reports any
 * dynamic `@flue/*` import as reaching every name the package exports, which
 * is the correct reading: a dynamic specifier is exactly how a ban on named
 * imports gets routed around. `import { init }` says what is reached and can
 * be checked; `await import('@flue/runtime')` says nothing.
 *
 * ── WHY THE TWO RECORD-ONLY STEP KINDS EXIST ────────────────────────────────
 *
 * `MODEL_CALL` and `TOOL_CALL` have been in `WorkflowStepKind` since the
 * provenance migration with NO WRITER. The static driver cannot meet them:
 * they are not shapes a definition declares but facts about what an engine
 * DID. This is the writer they were added for, and both go through
 * `recordStep` — the one write seam
 * (`tests/guards/workflow-step-single-write-seam.test.ts`) — so each carries
 * its hash-chained audit row exactly as a static step does.
 *
 * ── THE CAPS APPLY HERE TOO, AND THAT IS THE POINT OF THE WRAPPER ───────────
 *
 * An agentic loop is precisely the thing the run caps exist for: it decides
 * for itself how many tools to call and how long to keep going. So the budget
 * is the same `createRunBudget` the static driver builds, seeded the same way
 * from what earlier segments spent, and it is charged at the only place this
 * engine has a per-action boundary — inside each tool call.
 */

/**
 * Severity order for folding a call's two guard slices into one verdict.
 *
 * Written as data rather than as a comparison chain so that adding a fourth
 * verdict is a compile error here — `Record<AgentGuardVerdict, number>` cannot
 * miss a member — rather than a silently wrong ordering.
 */
const RANK: Record<StepGuardObservation['verdict'], number> = {
    CLEAN: 0,
    FLAGGED: 1,
    QUARANTINED: 2,
};

/**
 * A cap that fired mid-dispatch.
 *
 * Held rather than thrown out of the run, because a throw from inside a tool
 * is, to the runtime, a tool error the model may simply try around. The latch
 * refuses every SUBSEQUENT call outright and the run is settled at the cap
 * once the submission is done — so the ceiling is enforced immediately and
 * recorded honestly.
 */
interface CapLatch {
    halt: RunCapHalt | null;
}

/**
 * The message a run's agent is given.
 *
 * The definition's description plus the steps it still has to cover. A Flue
 * run does not WALK the declared steps — that is the static engine's contract
 * — but the steps are the specification of the work, and handing the model the
 * description alone would ask it to infer a plan the definition already
 * states.
 */
function runMessage(def: WorkflowDefinition, fromSeq: number): string {
    const remaining = def.steps.slice(fromSeq);
    const lines = remaining.map((step, i) => `${fromSeq + i + 1}. [${step.kind}] ${step.label}`);
    return [
        def.description,
        '',
        'Cover the following, in order. Use the tools you have been given; do not assume.',
        ...lines,
    ].join('\n');
}

export async function executeFlueRun(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    fromSeq: number,
    runStartMs: number,
    modelSpecifier: string,
): Promise<RunDriverOutcome> {
    // BOOT FIRST, and check the specifier against what actually got
    // registered. An unregistered model would otherwise surface from inside pi
    // as a stream error, mid-run, with the run row already created and an
    // agent already dispatched — where here it is a named refusal naming the
    // configuration gap.
    const providers = await ensureFlueRuntime();
    if (!flueModelIsRegistered(modelSpecifier, providers)) {
        const status = await failRun(ctx, runId, refusalMessage('MODEL_NOT_REGISTERED'));
        return { status, stepFailures: 0 };
    }

    const initial = await getRunRow(ctx, runId);
    let costTokens = initial.costTokens ?? 0;

    // The SETTLED terms — membership, key scopes, policy card, autonomy
    // ceiling — resolved once, here, exactly as the static driver does.
    // `actionsAlready` seeds the per-run action budget with what earlier
    // segments spent, so a run with three checkpoints does not get four.
    const invocation = await resolveMcpInvocation(ctx, { actionsAlready: fromSeq });

    const budget = createRunBudget({
        caps: resolveRunCaps(invocation.policyCard?.inForce.value ?? null),
        now: () => Date.now(),
        // The RUN's start, not this segment's.
        startedAtMs: runStartMs,
        spent: {
            STEPS: fromSeq,
            TOOL_CALLS: fromSeq,
            PROPOSALS: await proposedItemsSoFar(ctx, runId),
            TOKENS: costTokens,
        },
    });

    // ── The wall clock, charged BEFORE dispatch ─────────────────────────────
    //
    // A CEILING WORTH NAMING: this is the only place the runtime cap can be
    // enforced on this engine. A submission is one call, and nothing here can
    // interrupt a model mid-turn — so a run that starts inside its wall clock
    // can finish outside it. The per-tool charge below bounds how far past,
    // since every subsequent tool call re-checks. Upgrade path when that is
    // not tight enough: pass an `AbortSignal` into the dispatch.
    const preflight = budget.charge('RUNTIME_MS', 0);
    if (preflight) {
        const status = await haltRunAtCap(ctx, runId, preflight, def.steps.length - fromSeq);
        return { status, stepFailures: 0 };
    }

    // WHAT THE GUARD SAID, collected per call so the step row can carry it.
    //
    // Keyed by `toolCallId` because tool calls can overlap: a map keyed by
    // tool NAME would let a second call to the same tool overwrite the first's
    // verdict, and the row that lost would be recorded as unscanned.
    //
    // Both slices of one call fold into the WORST verdict seen. A call whose
    // arguments were clean and whose result was flagged is a flagged call —
    // taking the last would report whichever slice happened to finish second.
    const seen = new Map<string, StepGuardObservation>();
    const offered = flueToolsFor(invocation, (o) => {
        const prior = seen.get(o.toolCallId);
        seen.set(o.toolCallId, prior && RANK[prior.verdict] >= RANK[o.verdict] ? prior : o);
    });
    const latch: CapLatch = { halt: null };
    let seq = fromSeq;
    let stepFailures = 0;

    const tools = offered.tools.map((tool) => wrapForLedger(ctx, runId, tool, latch, budget, {
        nextSeq: () => seq++,
        onFailure: () => { stepFailures += 1; },
        // TAKEN, not read: the entry is this call's, and leaving it in the map
        // would both leak for the life of the run and let a later call with a
        // recycled id inherit a verdict that was not its own.
        takeVerdict: (id) => {
            const o = seen.get(id);
            seen.delete(id);
            return o;
        },
    }));

    bindRun(runId, { tools, modelSpecifier });

    try {
        logger.info('flue-driver: dispatching', {
            component: 'agentic',
            runId,
            workflow: def.key,
            toolsOffered: tools.length,
            toolsOmitted: offered.omitted.length,
        });

        const agent = init(InflectAgent, { id: runId });
        const receipt = await agent.dispatch({
            message: runMessage(def, fromSeq),
            // The RUN ID only. `initialData` is part of the durable record
            // stream and is explicitly not a secrets channel — the authority
            // it addresses stays in this process, in `run-binding`.
            initialData: { runId },
        });
        const reply = await agent.read(receipt);

        const usage = readUsage(reply.metadata);
        costTokens += usage.totalTokens;
        await recordStep(ctx, runId, seq++, 'MODEL_CALL', {
            status: 'DONE',
            label: def.key,
            tokens: usage.totalTokens,
            // The reply TEXT is deliberately not recorded here. Agent output
            // becomes an `AgentProposal` if it becomes anything, and that row
            // is guarded, diffed and reviewable; a copy in the step ledger
            // would be un-guarded model output in a second, unreviewed place.
            input: { toolCalls: usage.toolCalls, failedToolCalls: usage.failedToolCalls },
        });

        // A cap that fired mid-dispatch wins over the reply. The submission
        // may well have finished tidily after being refused its tools, and
        // reporting that as a completed run would hide the ceiling.
        if (latch.halt) {
            await updateRun(ctx, runId, { costTokens });
            const status = await haltRunAtCap(ctx, runId, latch.halt, def.steps.length - fromSeq);
            return { status, stepFailures };
        }

        // Tokens charged AFTER the work is recorded, for the reason the static
        // driver charges them after its commit: the turn has already happened
        // and its record is durable, so halting here stops the NEXT thing
        // rather than discarding what was done.
        const tokenHalt = budget.charge('TOKENS', costTokens - budget.used('TOKENS'));
        if (tokenHalt) {
            await updateRun(ctx, runId, { costTokens, stepCount: seq });
            const status = await haltRunAtCap(ctx, runId, tokenHalt, 0);
            return { status, stepFailures };
        }

        await updateRun(ctx, runId, {
            status: 'COMPLETED',
            completedAt: new Date(),
            stepCount: seq,
            costTokens,
        });
        return { status: 'COMPLETED', stepFailures };
    } catch (err) {
        // A cap latched before the throw explains the throw: the tool refusals
        // are what the submission failed on. Report the ceiling, not the
        // symptom.
        if (latch.halt) {
            await updateRun(ctx, runId, { costTokens });
            const status = await haltRunAtCap(ctx, runId, latch.halt, def.steps.length - fromSeq);
            return { status, stepFailures };
        }
        const message = err instanceof Error ? err.message : String(err);
        const status = await failRun(ctx, runId, `flue_run_failed: ${message}`);
        return { status, stepFailures: stepFailures + 1 };
    } finally {
        // The binding is normally CLAIMED by the agent's render. This covers
        // the paths where it never was — a dispatch that threw before the
        // agent rendered — so authority does not sit in the map for the
        // lifetime of the process.
        releaseRun(runId);
    }
}

/**
 * One offered tool, wrapped so the ledger and the budget see every call.
 *
 * WRAPPED rather than re-implemented: the guard sandwich, the funnel and the
 * funnel's audit row all live inside the closure `flueToolsFor` built, and a
 * second path to the tool would be a path around all three.
 */
function wrapForLedger(
    ctx: RequestContext,
    runId: string,
    tool: FlueToolDefinition,
    latch: CapLatch,
    budget: ReturnType<typeof createRunBudget>,
    ledger: {
        nextSeq: () => number;
        onFailure: () => void;
        takeVerdict: (toolCallId: string) => StepGuardObservation | undefined;
    },
): FlueToolDefinition {
    return {
        ...tool,
        run: async (context) => {
            if (latch.halt) throw new Error(latch.halt.message);

            // CHARGED BEFORE THE CALL, so a refusal means the tool function
            // was never invoked — the same pre-execution property the policy
            // card has at the tool boundary, and a testable claim in a way
            // that "it returned an error" is not.
            //
            // Both counters, because on this engine a tool call IS the unit of
            // work: the static driver charges STEPS and TOOL_CALLS together
            // for the same reason, one call per step.
            for (const kind of ['STEPS', 'TOOL_CALLS'] as const) {
                const halt = budget.charge(kind, 1);
                if (halt) {
                    latch.halt = halt;
                    throw new Error(halt.message);
                }
            }

            const seq = ledger.nextSeq();
            try {
                const result = await tool.run(context);
                const verdict = ledger.takeVerdict(context.toolCallId);
                await recordStep(ctx, runId, seq, 'TOOL_CALL', {
                    toolCalled: tool.name,
                    status: 'DONE',
                    label: tool.name,
                    guardVerdict: verdict?.verdict,
                    guardRuleIds: verdict?.ruleIds,
                    // The ARGUMENTS the model chose — not the result. The
                    // result is tenant content, already guarded on its way
                    // back through the adapter; the arguments are what the
                    // model DECIDED to do, they are recorded nowhere else (the
                    // funnel's audit row carries the tool name, the policy
                    // version and the manifest digest, not the input), and
                    // they are the reviewable half.
                    input: context.data,
                });
                return result;
            } catch (err) {
                ledger.onFailure();
                // The verdict is read on THIS path too, and it is the path it
                // matters most on: a guard that blocked or flagged the call
                // left by throwing, so a failed step with no verdict would be
                // indistinguishable from a tool that simply errored.
                const verdict = ledger.takeVerdict(context.toolCallId);
                await recordStep(ctx, runId, seq, 'TOOL_CALL', {
                    toolCalled: tool.name,
                    status: 'FAILED',
                    label: tool.name,
                    guardVerdict: verdict?.verdict,
                    guardRuleIds: verdict?.ruleIds,
                    input: context.data,
                    output: { error: err instanceof Error ? err.message : String(err) },
                });
                throw err;
            }
        },
    };
}

/**
 * The usage the agent reported through response metadata.
 *
 * Defensive because `metadata` is an open, deep-merged surface typed as
 * `Record<string, unknown>` — and because a submission can settle without the
 * finish hook's contribution (an aborted or failed response). A missing report
 * charges zero tokens, which is the honest reading: nothing was measured, so
 * nothing is claimed.
 */
function readUsage(metadata: Record<string, unknown> | undefined): FlueUsageReport {
    const empty: FlueUsageReport = { totalTokens: 0, toolCalls: 0, failedToolCalls: 0 };
    const raw = metadata?.[FLUE_USAGE_KEY];
    if (typeof raw !== 'object' || raw === null) return empty;
    const report = raw as Partial<FlueUsageReport>;
    const num = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    return {
        totalTokens: num(report.totalTokens),
        toolCalls: num(report.toolCalls),
        failedToolCalls: num(report.failedToolCalls),
    };
}
