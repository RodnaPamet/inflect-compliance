import { init, observe } from '@flue/runtime';
import type { FlueEvent, FlueEventContext } from '@flue/runtime';

import type { RequestContext } from '@/app-layer/types';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import type { RunDriverOutcome } from '@/lib/agentic/drivers/types';
import { recordStep } from '@/lib/agentic/drivers/step-recorder';
import { updateRun, failRun, haltRunAtCap, haltRunAtGuard } from '@/lib/agentic/drivers/run-settlement';
import { getRunRow, proposedItemsSoFar } from '@/lib/agentic/drivers/run-store';
import { latchOnGuardBlock } from '@/lib/agentic/circuit-breaker-store';
import { isProposeTool, proposedItemCount } from '@/lib/mcp/tools/propose-tools';
import { createRunBudget, resolveRunCaps, type RunCapHalt } from '@/lib/agentic/run-caps';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
// `computeInputDigest` STAYS, the other three LEAVE. #2786 records the Art 12
// digest on the MODEL_CALL step so the run timeline can link to the decision
// row, and that line lives here; `logAiDecision`, `PrismaTx` and
// `runInTenantContext` moved out with `recordModelDecision` into
// `./model-decision`, which is what made the sessionRef join testable.
import { computeInputDigest } from '@/app-layer/ai/decision-log';
import { logger } from '@/lib/observability/logger';

import { FLUE_USAGE_KEY, InflectAgent, type FlueUsageReport } from './agent';
import { recordModelDecision } from './model-decision';
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


/**
 * ONE MODEL CALL'S OWN USAGE — the leaf level, not a response aggregate.
 *
 * The runtime reports usage at two levels and says which is which: a `turn`
 * event is "one model call", carrying "provider-reported token and cost usage
 * for this single call", and "turn usage is the leaf level — `operation` and
 * `compaction` roll-ups already include it"
 * (`@flue/runtime/docs/reference/events.md`, `ModelResponse.usage`). The hooks
 * report only the roll-up: `useResponseFinish` "runs after the final finish
 * cycle … its `response.usage` and `response.toolCalls` aggregates are final"
 * (`agent-hooks-api.md`), and `useAgentFinish`'s is "the aggregate usage so
 * far". So the hook the agent already declares can never answer "what did THIS
 * call cost", and the event stream is the only surface that can.
 */
interface TurnRecord {
    totalTokens: number;
    tokensIn: number;
    tokensOut: number;
    /** The call's own wall clock. `null` on the aggregate fallback below. */
    durationMs: number | null;
}

// `recordModelDecision` and `aiSystemIdFor` USED TO LIVE HERE. #2791 moved
// them to `./model-decision` so the Art 14 `sessionRef` join could be tested
// against a real database — `execute.ts` statically imports `@flue/runtime`,
// so no CJS suite can load it, and a structural test cannot answer "does the
// value the writer stores equal the value the stamper queries". `settleTurns`
// below calls the extracted function once per TURN rather than once per
// dispatch, which is the whole of this branch.

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
    // The message is computed ONCE and reused: it is dispatched, and it is also
    // what every decision row's `sanitizedInput` digest is taken over. Two
    // calls to `runMessage` are two chances for the digest to stop naming the
    // prompt the model actually saw.
    const message = runMessage(def, fromSeq);

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
    // THE RUN'S WORST GUARD VERDICT, kept separately from `seen`.
    //
    // `seen` is consumed: `takeVerdict` REMOVES each entry as its step is
    // recorded, so by the time the run settles the map is empty and cannot
    // answer "did a guard fire during this run". That is correct for `seen`'s
    // own job and useless for this one, so the fold is kept here as it happens.
    // Rule ids ride along because the settle message names which rule fired and
    // never the content that tripped it.
    let worst: StepGuardObservation['verdict'] = 'CLEAN';
    let worstRuleIds: readonly string[] = [];

    // WHICH STEP a propose call belongs to. `wrapForLedger` allocates the step
    // seq before it invokes the tool and records it here; the adapter's closure
    // reads it back by `toolCallId` on its way into `runProposeTool`, so an
    // `AgentProposal` this run queued names the run and the step that queued
    // it. Keyed rather than held in a field for the same reason the guard
    // observations above are: the runtime may have more than one call in
    // flight, and a shared field would attribute one call's proposals to
    // another's step.
    const stepOfCall = new Map<string, number>();

    /**
     * EVERY MODEL CALL THIS SEGMENT MADE, in the order the runtime reported it.
     *
     * Filled from the event stream rather than from the reply, because the
     * reply cannot answer the question. `turn` is the runtime's per-model-call
     * event — "one model call is one turn" — and `turn.response.usage` is that
     * single call's provider-reported usage; every hook an agent can declare
     * sees only the roll-up (see `TurnRecord` for the citations).
     *
     * `observe()` is isolate-global — "the subscription covers all agents,
     * harnesses, sessions" — so the filter is what makes this THIS run's
     * accounting. `ctx.id` is documented as "the agent instance id; equals the
     * `instanceId` stamped on the context's events", and the instance id is the
     * run id: the dispatch below is `init(InflectAgent, { id: runId })`.
     *
     * The subscriber is deliberately a push onto an array and nothing else. It
     * runs "synchronously from the event emit path", so a DB write here would
     * sit inside the model loop; the runtime's own instruction is to "queue
     * substantial work outside the callback". The queue is drained at every
     * exit below.
     */
    const turns: TurnRecord[] = [];
    const onTurn = (event: FlueEvent, eventCtx: FlueEventContext): void => {
        if (event.type !== 'turn' || eventCtx.id !== runId) return;
        const usage = event.response.usage;
        // Absent "when the provider reported none". Nothing was measured, so
        // nothing is claimed — the same reading `readUsage` takes.
        if (!usage) return;
        // Compaction turns are NOT filtered out. `purpose` distinguishes an
        // agent turn from a summarisation one, but both are model calls that
        // spent a tenant's tokens, and a charge that skipped compaction would
        // under-bill exactly the runs long enough to need it.
        turns.push({
            totalTokens: usage.totalTokens,
            tokensIn: usage.input,
            tokensOut: usage.output,
            durationMs: event.durationMs,
        });
    };
    /**
     * Registered inside the `try` so the `finally` below is its only disposer —
     * `flueToolsFor` and `bindRun` both throw, and a subscriber registered
     * above them would outlive a run that never dispatched.
     */
    let stopObserving: (() => void) | undefined;

    /**
     * CHARGE AND RECORD WHAT THE MODEL CALLS SPENT, then persist it.
     *
     * ── THE ONE PERSIST SEAM FOR `costTokens` ───────────────────────────────
     *
     * Called at the head of the success path AND at the head of the catch, and
     * that pairing is the whole point. `review.check` leaves by throwing on
     * both of its refusal paths, so the catch is the NORMAL exit for a guard
     * block and for a flag — and until this existed every one of those settles
     * wrote a `costTokens` that excluded the segment that had just been spent.
     * The tenant's monthly budget is `_sum: { costTokens }` over `WorkflowRun`
     * (`monthly-budget-policy.ts`), so those tokens were free; worse, a FLAGGED
     * run re-seeds its budget from the row on resume, handing itself back a
     * ceiling it had already spent.
     *
     * `splice` rather than a read: draining makes a second call a no-op, so the
     * catch cannot re-charge turns the success path already recorded.
     */
    const settleTurns = async (finalText: string | null): Promise<void> => {
        const pending = turns.splice(0);
        if (pending.length === 0) return;
        for (const [i, turn] of pending.entries()) {
            costTokens += turn.totalTokens;
            // The settled text belongs to the LAST call and to no other.
            await recordModelDecision(
                ctx,
                // The run id, for the Art 14 `sessionRef` join #2791 added —
                // an identity rather than a second digest, so a human's
                // resume or abort can find every row this run decided.
                runId,
                def,
                message,
                // The settled text belongs to the LAST call and to no other: a
                // response settles when the model stops calling tools, so its
                // text is that turn's output. Giving every row the same text
                // would claim each call produced the whole answer.
                i === pending.length - 1 ? finalText : null,
                // THIS call's tokens, not the dispatch aggregate — the whole
                // point of reading the event stream.
                { tokensIn: turn.tokensIn, tokensOut: turn.tokensOut },
                modelSpecifier,
                turn.durationMs,
            );
        }
        await updateRun(ctx, runId, { costTokens });
    };

    /**
     * Settle the run on its guard verdict, or answer `null` if no guard fired.
     *
     * ONE implementation for both exit paths. The success path and the catch
     * both need this and they need it to agree — two copies is how a flag
     * ends a thrown run correctly and a tidy one silently.
     *
     * The breaker call comes FIRST and only on a block. It is the half that
     * makes a repeat offender stoppable rather than merely recorded, and it is
     * awaited before the settle so a run that blocks and then fails to write
     * its own row has still been counted.
     */
    const settleAtGuard = async (): Promise<RunDriverOutcome | null> => {
        if (worst === 'CLEAN') return null;

        if (worst === 'QUARANTINED' && ctx.agentId) {
            // NEVER throws: `latchOnGuardBlock` swallows its own failure and
            // returns a null result, which is the right direction here. The
            // run is being stopped either way, and a breaker that cannot count
            // must not also prevent the stop from being recorded.
            await latchOnGuardBlock(ctx.tenantId, ctx.agentId, new Date());
        }

        // NO `updateRun({ costTokens })` here, and its absence is the fix
        // rather than an omission: `settleTurns` already persisted the charge
        // before either exit path reached this. A second writer for the same
        // number is how the two drift, and the one that used to sit here wrote
        // a total that excluded the segment it was settling.
        const status = await haltRunAtGuard(ctx, runId, worst, worstRuleIds);
        return { status, stepFailures };
    };

    const offered = flueToolsFor(
        invocation,
        (o) => {
            const prior = seen.get(o.toolCallId);
            seen.set(o.toolCallId, prior && RANK[prior.verdict] >= RANK[o.verdict] ? prior : o);
            if (RANK[o.verdict] > RANK[worst]) {
                worst = o.verdict;
                worstRuleIds = o.ruleIds;
            }
        },
        (toolCallId) => {
            const stepSeq = stepOfCall.get(toolCallId);
            return stepSeq === undefined ? undefined : { runId, stepSeq };
        },
    );
    const latch: CapLatch = { halt: null };
    let seq = fromSeq;
    let stepFailures = 0;

    const tools = offered.tools.map((tool) => wrapForLedger(ctx, runId, tool, latch, budget, {
        nextSeq: () => seq++,
        noteOrigin: (id, stepSeq) => { stepOfCall.set(id, stepSeq); },
        forgetOrigin: (id) => { stepOfCall.delete(id); },
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
        // BEFORE THE DISPATCH, because the stream is live-only: "the
        // subscription sees events emitted after registration; there is no
        // durable replay".
        stopObserving = observe(onTurn);

        logger.info('flue-driver: dispatching', {
            component: 'agentic',
            runId,
            workflow: def.key,
            toolsOffered: tools.length,
            toolsOmitted: offered.omitted.length,
        });

        const agent = init(InflectAgent, { id: runId });
        const receipt = await agent.dispatch({
            message,
            // The RUN ID only. `initialData` is part of the durable record
            // stream and is explicitly not a secrets channel — the authority
            // it addresses stays in this process, in `run-binding`.
            initialData: { runId },
        });
        const reply = await agent.read(receipt);

        // The AGGREGATE, still read — but now only for the two counts the
        // event stream does not give per call, and as the fail-safe below.
        const usage = readUsage(reply.metadata);

        // A SETTLED RESPONSE THAT REPORTED TOKENS AND NO TURNS IS NOT FREE.
        //
        // If the event stream ever stops carrying per-call usage — a provider
        // that reports none per call, a runtime that renames the event — the
        // per-turn charge silently becomes zero and every run bills nothing,
        // which is worse than the aggregate this replaced. So the aggregate
        // stands behind it as ONE call's worth, loudly: under-recording the
        // granularity is a degraded record, under-charging is a hole in the
        // tenant's monthly budget.
        if (turns.length === 0 && usage.totalTokens > 0) {
            logger.warn('flue-driver: no per-call usage was observed; charging the aggregate', {
                component: 'agentic',
                runId,
                workflow: def.key,
                totalTokens: usage.totalTokens,
            });
            turns.push({
                totalTokens: usage.totalTokens,
                tokensIn: usage.tokensIn,
                tokensOut: usage.tokensOut,
                durationMs: null,
            });
        }

        const spent = turns.reduce((n, t) => n + t.totalTokens, 0);
        await recordStep(ctx, runId, seq++, 'MODEL_CALL', {
            status: 'DONE',
            label: def.key,
            // The segment's own spend, summed from the calls that made it —
            // not the response aggregate, so the ledger row and the run row
            // can never be charged from two different numbers.
            tokens: spent,
            // The reply TEXT is deliberately not recorded here. Agent output
            // becomes an `AgentProposal` if it becomes anything, and that row
            // is guarded, diffed and reviewable; a copy in the step ledger
            // would be un-guarded model output in a second, unreviewed place.
            input: {
                toolCalls: usage.toolCalls,
                failedToolCalls: usage.failedToolCalls,
                // HOW MANY MODEL CALLS the dispatch actually made. One ledger
                // row still covers the dispatch — it is the engine's record of
                // the dispatch, and its seq feeds the step caps — but a reader
                // must not have to assume that meant one call.
                modelCalls: turns.length,
                // THE KEY TO THIS STEP'S ART 12 ROWS.
                //
                // `AiDecisionLog` carries no `runId` — deliberately, it is the
                // regulator's record of a DECISION and not of an engine's
                // bookkeeping — so the two are joined on
                // `(tenantId, inputDigest)`. Recording the digest here is what
                // turns that join into a link a reviewer can follow.
                //
                // It is the SAME function `logAiDecision` computes with, over
                // the SAME value `settleTurns` passes as `sanitizedInput`, so
                // the link lands on the rows this dispatch produced. Note the
                // PLURAL: one dispatch now writes one row per model call, and
                // every one of them digests this same dispatched message, so
                // the digest addresses the set rather than a single row.
                //
                // A DIGEST IS NOT CONTENT. It is a sha256 over the sanitised
                // input, already stored on the decision row; recording it adds
                // no prompt text to a ledger that deliberately holds none.
                // `message`, the SAME local `settleTurns` passes as
                // `sanitizedInput` — not a second `runMessage(def, fromSeq)`
                // call. Two spellings of one value is how the step and the row
                // drift into digesting different things while both look right.
                decisionDigest: computeInputDigest(message),
            },
        });

        // The Art 12 rows, beside the ledger row and after it: the step is the
        // engine's own record, the decision rows are the regulator's, and the
        // one that cannot be written must not stop the one that can. This also
        // charges `costTokens` and persists it, before any settle below reads
        // it.
        await settleTurns(reply.text ?? null);

        // A cap that fired mid-dispatch wins over the reply. The submission
        // may well have finished tidily after being refused its tools, and
        // reporting that as a completed run would hide the ceiling.
        if (latch.halt) {
            const status = await haltRunAtCap(ctx, runId, latch.halt, def.steps.length - fromSeq);
            return { status, stepFailures };
        }

        // A GUARD VERDICT OUTLIVES A TIDY FINISH, for the same reason the cap
        // above does. The latch refuses every call after the first flag, so a
        // flagged run usually leaves by throwing — but a flag on the LAST call
        // lets the dispatch finish cleanly, and reporting that as COMPLETED is
        // exactly the "guard ran, recorded its verdict, and changed nothing"
        // shape the adapter's own docstring warns about.
        const guardHalt = await settleAtGuard();
        if (guardHalt) return guardHalt;

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
        // FIRST, BEFORE ANY SETTLE: the calls that happened before the throw
        // happened, and every arm below writes a terminal row. `review.check`
        // leaves by throwing on both of its refusal paths, so this is the
        // NORMAL exit for a guard block and for a flag — not an error path —
        // and a settle that ran before this recorded a spend of zero for a
        // dispatch that had already burned the tenant's tokens.
        //
        // There is no reply here, so no call gets an output summary: the
        // response never settled, and inventing one from a throw would put
        // text in the regulator's record that the model did not finish saying.
        await settleTurns(null);

        // A cap latched before the throw explains the throw: the tool refusals
        // are what the submission failed on. Report the ceiling, not the
        // symptom.
        if (latch.halt) {
            const status = await haltRunAtCap(ctx, runId, latch.halt, def.steps.length - fromSeq);
            return { status, stepFailures };
        }

        // A guard verdict latched before the throw EXPLAINS the throw — the
        // same argument the cap makes immediately above, and the reason this
        // sits below it rather than beside it: a run that hit the cap and was
        // also flagged is a run that hit the cap. `review.check` leaves by
        // throwing on both of its refusal paths, so without this arm every
        // guard block and every flag arrived here and was settled
        // `flue_run_failed: <the throw's message>` — a control outcome
        // reported as a crash.
        const guardHalt = await settleAtGuard();
        if (guardHalt) return guardHalt;

        // `failure`, not `message`: `message` is the dispatched prompt in this
        // scope, and a shadowing `const` here would read as the same thing.
        const failure = err instanceof Error ? err.message : String(err);
        const status = await failRun(ctx, runId, `flue_run_failed: ${failure}`);
        return { status, stepFailures: stepFailures + 1 };
    } finally {
        // UNSUBSCRIBED FIRST. `observe()` is isolate-global and lives as long
        // as the process; a subscriber left behind would keep this run's array
        // reachable and go on filtering every event every later run emits.
        stopObserving?.();
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
        noteOrigin: (toolCallId: string, stepSeq: number) => void;
        forgetOrigin: (toolCallId: string) => void;
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

            // PROPOSALS is charged PER ITEM, not per call. `proposeArgs`
            // accepts up to 20 items in one call and `runProposeTool` queues
            // one PENDING row for each, so charging the call would let a run
            // reach twenty times its proposal cap while the counter read as
            // one. The budget already SEEDS this kind from
            // `proposedItemsSoFar`, which was inert only because nothing on
            // this engine could propose; offering the surface is what makes
            // the seed a cap rather than a number.
            //
            // The predicate is the registry's own, the same one the adapter
            // dispatches on — a second way of deciding "is this a propose
            // tool" is a way for the charge and the funnel to disagree, and
            // the disagreement that matters is a propose call charged nothing.
            const items = isProposeTool(tool.name) ? proposedItemCount(context.data) : 0;
            if (items > 0) {
                const halt = budget.charge('PROPOSALS', items);
                if (halt) {
                    latch.halt = halt;
                    throw new Error(halt.message);
                }
            }

            const seq = ledger.nextSeq();
            // BEFORE the call, because the call is what reads it.
            ledger.noteOrigin(context.toolCallId, seq);
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
            } finally {
                // Symmetrical with `takeVerdict`'s delete, and for the same
                // two reasons: the entry is this call's, and leaving it would
                // both leak for the life of the run and let a later call with
                // a recycled id inherit a step seq that was not its own.
                ledger.forgetOrigin(context.toolCallId);
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
    const empty: FlueUsageReport = {
        totalTokens: 0,
        tokensIn: 0,
        tokensOut: 0,
        toolCalls: 0,
        failedToolCalls: 0,
    };
    const raw = metadata?.[FLUE_USAGE_KEY];
    if (typeof raw !== 'object' || raw === null) return empty;
    const report = raw as Partial<FlueUsageReport>;
    const num = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    return {
        totalTokens: num(report.totalTokens),
        tokensIn: num(report.tokensIn),
        tokensOut: num(report.tokensOut),
        toolCalls: num(report.toolCalls),
        failedToolCalls: num(report.failedToolCalls),
    };
}
