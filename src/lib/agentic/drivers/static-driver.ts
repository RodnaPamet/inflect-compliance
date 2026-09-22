/**
 * The STATIC run driver — the engine that has executed every agentic run in
 * this product, moved here unchanged.
 *
 * ## What this is, and what it deliberately is not
 *
 * This file is an EXTRACTION, not a rewrite. Every declaration below was moved
 * verbatim out of `src/app-layer/usecases/workflow-runs.ts`; the bodies are
 * byte-identical to what was there before, and a test asserts it. The point was
 * to create the seam a second driver can plug into without changing what the
 * first one does — so any behaviour difference here would be a defect, not a
 * design.
 *
 * ## The seam
 *
 * `runStaticDriver` walks a `WorkflowDefinition`'s hand-written step array:
 * READ steps call `runReadTool`, PROPOSE steps call `runProposeTool`,
 * HUMAN_CHECKPOINT parks the run, SYNTHESIS fills a deterministic template.
 * There is no model call anywhere in it, which is the gap an external agent
 * runtime is being evaluated to fill.
 *
 * Everything that makes a run SAFE stays outside this file and is not the
 * driver's to decide: the register, the policy card, the autonomy ceiling, the
 * kill switch and the credential gate all live behind `runReadTool`, and the
 * per-run caps are composed by `run-caps.ts` and merely charged here. A second
 * driver inherits all of it by calling the same funnel.
 */
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { appendAuditEntry } from '@/lib/audit';
import { recordStep, type StepRecord } from './step-recorder';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { runReadTool } from '@/lib/mcp/tools/registry';
import { runProposeTool } from '@/lib/mcp/tools/propose-tools';
import {
    provenanceOfToolResult,
    UNTRUSTED_PROVENANCE,
    type ContentProvenance,
} from '@/lib/agentic/content-provenance';
import {
    estimateTokens,
    type WorkflowContext,
    type WorkflowDefinition,
} from '@/lib/agentic/workflow-types';
import {
    createRunBudget,
    ENGINE_RUN_CAPS,
    resolveRunCaps,
    RUN_CAP_KINDS,
    type RunBudget,
    type RunCapHalt,
} from '@/lib/agentic/run-caps';
import {
    ContextIntegrityError,
    describeContextHalt,
    openSealedContext,
    sealContext,
    type OpenedContext,
} from '@/lib/agentic/context-integrity';
import {
    recordAgenticFanOutHalt,
    recordAgenticMemberFailure,
    recordAgentRunCapHalt,
    recordAgentRunCapUtilisation,
    recordWorkflowContextBytes,
    recordWorkflowContextIntegrityHalt,
} from '@/lib/observability/metrics';
import { describeFailure, isAgenticFatal } from '@/lib/agentic/failure-isolation';

import { getRunRow } from './run-store';

/**
 * Execute steps from `fromSeq` until completion or a HUMAN_CHECKPOINT. Returns
 * the run's resulting status. A thrown step marks the run FAILED (never a
 * half-applied mutation — writes are proposals).
 *
 * ## The five SPEND caps, and the one WEIGH cap
 *
 * Five axes bound what a run may spend — steps, tool calls, proposed items,
 * tokens and wall clock — and all five are resolved once into a `RunBudget`
 * (`src/lib/agentic/run-caps.ts`) rather than checked inline. The budget is the
 * composition of the engine's global ceiling with this agent's own policy card,
 * strictest wins; an agent with NO card gets the engine ceiling rather than no
 * ceiling at all, which is the hole that composition closes.
 *
 * EVERY ONE OF THEM HALTS. None trims and continues. A run given the first
 * hundred of five hundred proposals, or the first forty of sixty steps, is a
 * run that looks like it finished and reasoned over a subset nobody chose —
 * and nothing downstream can tell it apart, because the evidence that would say
 * so is the evidence that was dropped. So a breach returns through
 * `haltRunAtCap`, which records WHICH cap fired and HOW MUCH work was left.
 *
 * The SIXTH cap is not a spend cap and is enforced elsewhere: it bounds what a
 * single persisted context may WEIGH. A run can sit far inside its token budget
 * while one tool output makes its memory unbounded. Over the cap the run HALTS
 * too — see `commitContext`.
 */
interface ExecuteOutcome {
    status: string;
    /** Steps that failed and were ISOLATED in this segment. Never a silent zero. */
    stepFailures: number;
}


/** What one tool call handed back: its payload, and what that payload is made of. */
interface ParsedToolResult {
    /**
     * `content[0]`, parsed. THE CONTRACT: this is the exact JSON every external
     * MCP agent already parses, and it is what goes into the run context and
     * the step row. Nothing below wraps, shifts or annotates it.
     */
    output: unknown;
    /**
     * The trust label the tool stamped on that payload, read back off the
     * envelope block beside it.
     *
     * This block existed and this engine dropped it. `runReadTool` appends a
     * provenance envelope as a SECOND content block precisely so `content[0]`
     * can stay untouched — which works for an external client that reads the
     * whole result, and did nothing at all for the engine the product actually
     * runs, because this function took `content[0]` and returned. The tagging
     * was real for the surface it was built against and absent for the one that
     * executes workflows.
     *
     * FAIL-CLOSED: no block, an unparseable one, or a label this build does not
     * know all read as `THIRD_PARTY_INGESTED` — see `provenanceOfToolResult`.
     * A propose tool emits no envelope at all, so a PROPOSE step lands here
     * legitimately, and untrusted is the right answer for it too.
     */
    provenance: ContentProvenance;
}

async function executeSteps(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    fromSeq: number,
    runStartMs: number,
): Promise<ExecuteOutcome> {
    // ONE read for the run row, and it carries three things: the cost so far,
    // the sealed context, and its chain head. (It used to be two reads — one in
    // `loadContext`, one in `currentCost` — of the same row.)
    const initial = await getRunRow(ctx, runId);
    let stepCount = fromSeq;
    let costTokens = initial.costTokens ?? 0;
    // Steps this segment failed on and CONTINUED past. Every early return below
    // carries it, so no exit from this function can report a run without saying
    // how much of it did not work.
    let stepFailures = 0;

    // The run's memory, opened under verification. A failure here is a HALT,
    // not a reset: `openSealedContext` has no path that returns a context it
    // could not verify, and this function has no path that continues without
    // one.
    //
    // The lower bound comes from the APPEND-ONLY step ledger, not from the run
    // row. Restoring an earlier `(contextJson, contextHash)` pair rolls the
    // memory back and the chain still verifies — the link is recomputed from the
    // very envelope being replayed, so it agrees with itself. The ledger is a
    // different table and the same restore does not move it, so it still
    // remembers how far this run actually got. `undefined` when the ledger has
    // nothing to say (a fresh run, or steps recorded before the column existed),
    // which leaves the pre-existing checks exactly as they were.
    const minSeq = await highestRecordedContextSeq(ctx, runId);

    let opened: OpenedContext;
    try {
        opened = openRunContext(ctx, runId, initial, minSeq);
    } catch (err) {
        if (err instanceof ContextIntegrityError) {
            return { status: await haltRun(ctx, runId, err), stepFailures };
        }
        throw err;
    }
    let context = opened.context;
    let chainSeq = opened.seq;
    let chainHash = opened.hash;

    // Resolved ONCE per execution, and that is now safe in a way it was not.
    //
    // The invocation carries the SETTLED terms — the principal's membership, the
    // agent's tool grants, the autonomy ceiling — which are read here and reused
    // for every step. The term that can change mid-run, CREDENTIAL REVOCATION,
    // is deliberately not one of them: `authorizeToolCall` re-reads it at every
    // tool boundary, uncached. So a key revoked while this loop is running stops
    // the very next step rather than riding out the run.
    //
    // The comment this replaces said a revoke "lands on the next run, which is
    // the same freshness a direct tool call gets between requests". That was the
    // defect stated as a design: a run is exactly where the two differ, because
    // a run keeps executing after the operator has acted.
    // `actionsAlready: fromSeq` is what keeps the policy card's PER-RUN action
    // budget a property of the RUN rather than of the segment. This function is
    // re-entered after every human checkpoint with a fresh invocation, so a
    // counter that started at zero here would hand a run one full budget per
    // checkpoint — and a run with three checkpoints would quietly get four.
    const invocation = await resolveMcpInvocation(ctx, { actionsAlready: fromSeq });

    // The run's budget, composed from the engine's global ceiling and this
    // agent's own policy card — strictest wins, and an agent with NO card gets
    // the engine ceiling rather than no ceiling. See `run-caps.ts`.
    //
    // Seeded from what earlier SEGMENTS of this run already spent, for the
    // reason `actionsAlready` above exists: a counter that starts at zero here
    // hands a run one full budget per human checkpoint, so a workflow with
    // three checkpoints would quietly get four.
    const budget = createRunBudget({
        caps: resolveRunCaps(invocation.policyCard?.inForce.value ?? null),
        now: () => Date.now(),
        // The RUN's start, not this segment's: a run that sat at a checkpoint
        // for a day has spent a day of its wall clock.
        startedAtMs: runStartMs,
        spent: {
            STEPS: fromSeq,
            // At most one tool call per step, and the same proxy
            // `resolveMcpInvocation` is handed — so the engine's budget and the
            // card's bind on the same call rather than one call apart.
            TOOL_CALLS: fromSeq,
            PROPOSALS: await proposedItemsSoFar(ctx, runId),
            TOKENS: costTokens,
        },
    });

    for (let seq = fromSeq; seq < def.steps.length; seq++) {
        // ── Caps. Every one of them HALTS — nothing here trims and continues. ──
        //
        // Charged BEFORE the step so a refusal means the step was never
        // entered, which is the same pre-execution property the policy card
        // has at the tool boundary: "the tool function was never called" is a
        // testable claim; "it returned an error" is not.
        const runtimeHalt = budget.charge('RUNTIME_MS', 0);
        if (runtimeHalt) {
            const status = await haltRunAtCap(ctx, runId, runtimeHalt, def.steps.length - seq);
            return { status, stepFailures };
        }
        const stepHalt = budget.charge('STEPS', 1);
        if (stepHalt) {
            const status = await haltRunAtCap(ctx, runId, stepHalt, def.steps.length - seq);
            return { status, stepFailures };
        }
        // Abort/pause may have been requested between steps.
        const live = await getRunRow(ctx, runId);
        if (live.status === 'ABORTED' || live.status === 'PAUSED') {
            return { status: live.status, stepFailures };
        }

        // RE-OPEN THE CONTEXT FROM THE ROW AT EVERY STEP, rather than trusting
        // the copy this function is holding. That is what makes "a tampered
        // context is caught at the NEXT step" true rather than asserted: the
        // between-steps window is real (a HUMAN_CHECKPOINT can pause a run for
        // days, and `resumeWorkflowRun` re-enters here), and a verifier that
        // only ever checks its own in-memory value would see nothing that
        // happened in it. The row is already being fetched for the abort check,
        // so this costs no extra query.
        try {
            // `chainSeq` is the position this run has already committed, so a
            // re-read below it is a ROLLBACK, not a legitimate advance. A pause
            // may legitimately move the context FORWARD (a checkpoint approval
            // commits), never backward.
            const reopened = openRunContext(ctx, runId, live, chainSeq);
            context = reopened.context;
            chainSeq = reopened.seq;
            chainHash = reopened.hash;
        } catch (err) {
            if (err instanceof ContextIntegrityError) {
                return { status: await haltRun(ctx, runId, err), stepFailures };
            }
            throw err;
        }

        const step = def.steps[seq];
        try {
            if (step.kind === 'HUMAN_CHECKPOINT') {
                await recordStep(ctx, runId, seq, 'HUMAN_CHECKPOINT', {
                    status: 'PENDING', label: step.label,
                }, chainSeq);
                await commitContext(ctx, runId, context, chainSeq + 1, chainHash, {
                    status: 'AWAITING_APPROVAL',
                    stepCount: seq + 1,
                });
                return { status: 'AWAITING_APPROVAL', stepFailures };
            }

            if (step.kind === 'READ') {
                // RETURNED, NOT AWAITED, here and at every cap halt inside this
                // `try`: a `return` inside a `try` is not routed to the `catch`
                // below, so a halt cannot be re-reported as a step failure —
                // which would overwrite the cap an operator needs to read with
                // a tool error that did not happen.
                const readHalt = budget.charge('TOOL_CALLS', 1);
                if (readHalt) {
                    const status = await haltRunAtCap(ctx, runId, readHalt, def.steps.length - seq);
                    return { status, stepFailures };
                }
                const args = step.args ? step.args(context) : {};
                const result = await runReadTool(invocation, step.tool, args);
                // `output` is content[0] and ONLY content[0] — the context keeps
                // the exact shape every workflow definition's `args(context)`
                // and `buildItems(context)` already indexes into. The label
                // rides alongside it into the step record instead.
                const { output, provenance } = parseToolResult(result);
                context.outputs[step.label] = output;
                costTokens += estimateTokens(output);
                await recordStep(ctx, runId, seq, 'READ', { toolCalled: step.tool, input: args, output, provenance, status: 'DONE', label: step.label }, chainSeq);
            } else if (step.kind === 'PROPOSE') {
                const items = step.buildItems(context);
                if (items.length === 0) {
                    await recordStep(ctx, runId, seq, 'PROPOSE', { toolCalled: step.tool, status: 'SKIPPED', label: step.label }, chainSeq);
                } else {
                    // BOTH axes, and both before the tool runs. The proposal
                    // budget is charged for every ITEM, because one propose
                    // call carrying five hundred items is one tool call — so a
                    // per-call cap bounds proposal flooding not at all.
                    //
                    // `items.length` is charged whole. There is deliberately no
                    // `items.slice(0, remaining)` here: a run given the first
                    // hundred of five hundred proposals produces a review queue
                    // that reads as the agent's considered output, and nobody
                    // chose that subset.
                    const proposalHalt = budget.charge('PROPOSALS', items.length);
                    if (proposalHalt) {
                        const status = await haltRunAtCap(ctx, runId, proposalHalt, def.steps.length - seq);
                        return { status, stepFailures };
                    }
                    const proposeHalt = budget.charge('TOOL_CALLS', 1);
                    if (proposeHalt) {
                        const status = await haltRunAtCap(ctx, runId, proposeHalt, def.steps.length - seq);
                        return { status, stepFailures };
                    }
                    const rationale = step.rationale ? step.rationale(context) : undefined;
                    const result = await runProposeTool(invocation, step.tool, { items, rationale });
                    const { output, provenance } = parseToolResult(result);
                    context.outputs[step.label] = output;
                    costTokens += estimateTokens(output);
                    await recordStep(ctx, runId, seq, 'PROPOSE', { toolCalled: step.tool, input: { count: items.length }, output, provenance, status: 'DONE', label: step.label }, chainSeq);
                }
            } else if (step.kind === 'SYNTHESIS') {
                const syn = step.synthesize(context);
                context.outputs[step.label] = syn;
                costTokens += estimateTokens(syn);
                await recordStep(ctx, runId, seq, 'SYNTHESIS', { output: syn, status: 'DONE', label: step.label }, chainSeq);
            } else {
                // EXHAUSTIVE, and fail-closed — point 5 of the integration
                // plan, which asks that `costTokens` accumulate across all
                // kinds "so a loop cannot escape the cap by spending in a kind
                // the counter ignores".
                //
                // The escape it names is not a missing addition; it is this
                // chain having no final arm. `costTokens` only accumulates
                // INSIDE the branches above, so a step kind matching none of
                // them records nothing, charges nothing — and still advances
                // `stepCount` and commits the context. A run could therefore
                // report itself complete having executed a step it silently
                // skipped, and the token delta charged below would be zero.
                //
                // Unreachable today: `WorkflowStepDef` is a closed four-member
                // union and `HUMAN_CHECKPOINT` returned above, so TypeScript
                // narrows `step` to `never` here. That is exactly the value —
                // a FIFTH member cannot be added without this line failing to
                // compile, which is what turns "somebody will remember to
                // charge it" into a build error.
                //
                // `MODEL_CALL` and `TOOL_CALL` are not in that union: they are
                // `WorkflowStepKind` values a driver RECORDS, not step shapes a
                // definition declares, so this driver cannot meet them. The
                // driver that does record them owes its own charging, and
                // `tests/unit/workflow-step-kind-coverage.test.ts` is where
                // that relationship is written down.
                const unhandled: never = step;
                void unhandled;
                const status = await failRun(
                    ctx,
                    runId,
                    `unsupported_step_kind: the static driver cannot execute ` +
                        `${String((step as { kind?: unknown }).kind)} steps`,
                );
                return { status, stepFailures };
            }

            stepCount = seq + 1;
            const committed = await commitContext(ctx, runId, context, chainSeq + 1, chainHash, {
                stepCount,
                costTokens,
            });
            chainSeq = committed.seq;
            chainHash = committed.hash;

            // Tokens are charged AFTER the commit, and that ordering is the
            // whole difference between halting and truncating. The step has
            // already run; its output is real and is now durably recorded.
            // Charging before the commit and halting would throw away work that
            // was actually done — which is a silent loss wearing a cap's
            // clothes. So the completed step keeps its output, and the run
            // stops before the next one.
            const tokenHalt = budget.charge('TOKENS', costTokens - budget.used('TOKENS'));
            if (tokenHalt) {
                const status = await haltRunAtCap(ctx, runId, tokenHalt, def.steps.length - seq - 1);
                return { status, stepFailures };
            }
        } catch (err) {
            // An integrity failure is NOT a step failure and must not be
            // recorded as one: the step ran, the context it produced is the
            // problem. It also must not fall through to `failRun`, which would
            // report a tool error where the finding is a poisoned or oversized
            // memory. Checked first, for both reasons.
            if (err instanceof ContextIntegrityError) {
                return { status: await haltRun(ctx, runId, err), stepFailures };
            }
            const message = err instanceof Error ? err.message : String(err);
            // The step's own row records the failure either way — same row,
            // same reason, in the encrypted `outputJson` where the reason
            // belongs. What the two branches below decide is only whether the
            // RUN survives it.
            await recordStep(ctx, runId, seq, step.kind, { status: 'FAILED', label: step.label, output: { error: message } }, chainSeq);

            // ── "This step failed" vs "this run must not continue" ──
            //
            // Two conditions, and neither is a message match. A FATAL error
            // (`agenticFatal`, or a kill/budget error branded with it) ends the
            // run no matter what the step declared — a per-step opt-in that
            // could outrank a kill would be the cascade the opt-in exists to
            // prevent. Absent a fatal, the step's OWN declaration decides, and
            // its default is the engine's original behaviour: end the run.
            const failure = describeFailure(`${runId}:${seq}`, err);
            if (isAgenticFatal(err) || step.continueOnFailure !== true) {
                if (failure.fatal) {
                    recordAgenticFanOutHalt({ component: 'workflow-step', kind: failure.kind });
                }
                const status = await failRun(ctx, runId, `step ${seq} (${step.kind}) failed: ${message}`);
                return { status, stepFailures };
            }

            // ISOLATED. Counted before anything else, because the whole risk of
            // this branch is that continuing quietly makes the loss invisible:
            // the metric fires, the audit row lands, and the count rides out on
            // the run's own result.
            stepFailures++;
            recordAgenticMemberFailure({ component: 'workflow-step', kind: failure.kind });
            await appendAuditEntry({
                tenantId: ctx.tenantId,
                userId: ctx.userId,
                actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
                entity: 'WorkflowRun',
                entityId: runId,
                action: 'WORKFLOW_STEP_ISOLATED_FAILURE',
                requestId: ctx.requestId,
                // DIGEST, never the message. A step's error text on this path
                // can quote a tool argument or a model's own words, and this
                // row is plaintext, hash-chained and never deleted.
                detailsJson: {
                    category: 'access',
                    stepSeq: seq,
                    stepKind: step.kind,
                    failureKind: failure.kind,
                    failureDigest: failure.digest,
                },
                metadataJson: { agentId: ctx.agentId ?? null },
            }).catch(() => undefined);

            // The run's PROGRESS is committed even though the step failed —
            // this is the half that makes the abort recoverable rather than
            // irrecoverable. The context is unchanged (the failed step wrote
            // nothing into it), but `stepCount` advances, so a later resume or
            // an operator reading the row sees exactly how far the run got.
            stepCount = seq + 1;
            const committed = await commitContext(ctx, runId, context, chainSeq + 1, chainHash, {
                stepCount,
                costTokens,
            });
            chainSeq = committed.seq;
            chainHash = committed.hash;
        }
    }

    // All steps done — complete. Summary = the last SYNTHESIS text, if any.
    const lastSynthesis = [...def.steps].reverse().find((s) => s.kind === 'SYNTHESIS');
    const summaryText =
        lastSynthesis && (context.outputs[lastSynthesis.label] as { text?: string } | undefined)?.text
            ? (context.outputs[lastSynthesis.label] as { text: string }).text
            : null;
    try {
        await commitContext(ctx, runId, context, chainSeq + 1, chainHash, {
            status: 'COMPLETED',
            completedAt: new Date(),
            stepCount,
            costTokens,
            summary: summaryText,
        });
    } catch (err) {
        if (err instanceof ContextIntegrityError) {
            return { status: await haltRun(ctx, runId, err), stepFailures };
        }
        throw err;
    }
    recordRunCapUtilisation(budget);
    return { status: 'COMPLETED', stepFailures };
}

/**
 * The highest context-chain position this run's append-only ledger has seen.
 *
 * `undefined` means the ledger cannot say — a run with no steps yet, or one
 * whose steps predate the column. An absent bound must read as "no constraint",
 * never as zero, or every resumed legacy run would halt.
 */
async function highestRecordedContextSeq(
    ctx: RequestContext,
    runId: string,
): Promise<number | undefined> {
    const top = await runInTenantContext(ctx, (db) =>
        db.workflowStep.aggregate({
            where: { runId, tenantId: ctx.tenantId },
            _max: { contextSeq: true },
        }),
    );
    return top._max.contextSeq ?? undefined;
}


async function updateRun(
    ctx: RequestContext,
    runId: string,
    data: Record<string, unknown>,
): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        db.workflowRun.update({ where: { id: runId }, data: data as never }),
    );
}

/**
 * Mark a run HALTED AT A CAP, and record WHICH cap and how much work is left.
 *
 * Separate from `failRun` on purpose, and the separation is the requirement
 * rather than tidiness. `failRun` says a step went wrong; this says nothing
 * went wrong at all — the run was working exactly as designed and was stopped
 * because it reached a ceiling somebody set. Those are different operator
 * actions (debug the workflow vs. decide whether the ceiling is right), and an
 * `errorMessage` that reads like a tool error sends people to the first one.
 *
 * `stepsNotRun` is the part that makes this a halt rather than a trim. Without
 * it a halted run is indistinguishable from a completed one to anything reading
 * the row: same `FAILED` status a broken step leaves, same absent tail. With
 * it, the remaining work is a recorded number in a hash-chained row that is
 * never deleted — visibly not-done rather than quietly gone.
 *
 * The run stays `FAILED` rather than gaining a `HALTED` status of its own.
 * Adding an enum value is safe to WRITE under a rolling deploy and unsafe to
 * READ: a container still running the old build would fail to deserialise a
 * status its client does not know, taking the whole run list down for the
 * duration of the rollout. The cap is carried by the audit action, the details
 * and the message instead — all three of which an old build reads as strings.
 */
async function haltRunAtCap(
    ctx: RequestContext,
    runId: string,
    halt: RunCapHalt,
    stepsNotRun: number,
): Promise<string> {
    await updateRun(ctx, runId, {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: halt.message,
    });
    recordAgentRunCapHalt({ cap: halt.kind, source: halt.source });
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowRun',
        entityId: runId,
        // A distinct action, not a `WORKFLOW_RUN_FAILED` with a special
        // message. An operator filtering the trail for cap halts must not have
        // to grep prose to find them.
        action: 'WORKFLOW_RUN_CAP_HALTED',
        requestId: ctx.requestId,
        // Every field named at the sink, none spread. All six are structural
        // facts about the ceiling — a cap kind, two integers, a source, and how
        // much work stopped. None of them is content, and none of them can
        // become content when the halt type grows a field.
        detailsJson: {
            category: 'access',
            cap: halt.kind,
            capSource: halt.source,
            limit: halt.limit,
            used: halt.used,
            refused: halt.refused,
            stepsNotRun,
        },
        metadataJson: { apiKeyId: ctx.apiKeyId ?? null, agentId: ctx.agentId ?? null },
    }).catch(() => undefined);
    return 'FAILED';
}

/**
 * How many items this run has ALREADY proposed, across every segment.
 *
 * Read from the append-only step ledger rather than accumulated in memory,
 * because `executeFrom` is re-entered after every human checkpoint: a counter
 * seeded at zero would hand a run with three checkpoints four proposal budgets,
 * which is the exact defect `resolveMcpInvocation`'s `actionsAlready` comment
 * already records for the card's per-run budget.
 *
 * An unreadable or absent count reads as ZERO, not as the cap. A run whose
 * PROPOSE steps predate the recorded count would otherwise halt on resume
 * having done nothing wrong — the same direction `highestRecordedContextSeq`
 * takes for its own missing lower bound.
 */
async function proposedItemsSoFar(ctx: RequestContext, runId: string): Promise<number> {
    const steps = await runInTenantContext(ctx, (db) =>
        db.workflowStep.findMany({
            where: { runId, tenantId: ctx.tenantId, kind: 'PROPOSE', status: 'DONE' },
            select: { inputJson: true },
            // A run cannot execute more steps than the engine's step cap, so
            // this is the tightest honest bound rather than a round number.
            take: ENGINE_RUN_CAPS.STEPS,
        }),
    );
    let total = 0;
    for (const step of steps) total += proposedItemCount(step.inputJson);
    return total;
}

/** The `{ count }` a PROPOSE step recorded, or 0 when it cannot be read. */
function proposedItemCount(inputJson: string | null): number {
    if (inputJson === null) return 0;
    try {
        const parsed: unknown = JSON.parse(inputJson);
        if (typeof parsed !== 'object' || parsed === null) return 0;
        const count = (parsed as { count?: unknown }).count;
        return typeof count === 'number' && Number.isFinite(count) && count > 0
            ? Math.floor(count)
            : 0;
    } catch {
        return 0;
    }
}

/**
 * How close a run that did NOT halt came to each of its ceilings.
 *
 * Recorded on the way out of a completed run, because a cap that only ever
 * shows up as halts is a cap nobody can plan around — the first time anyone
 * learns the number is too low is when a customer's run dies. A p99 near 100 on
 * any axis is the warning that the next workflow change halts runs.
 */
function recordRunCapUtilisation(budget: RunBudget): void {
    for (const kind of RUN_CAP_KINDS) {
        const limit = budget.caps[kind].limit;
        if (limit <= 0) continue;
        recordAgentRunCapUtilisation({
            cap: kind,
            percent: Math.min(100, (budget.used(kind) / limit) * 100),
        });
    }
}

async function failRun(ctx: RequestContext, runId: string, message: string): Promise<string> {
    await updateRun(ctx, runId, { status: 'FAILED', completedAt: new Date(), errorMessage: message });
    await appendAuditEntry({
        tenantId: ctx.tenantId, userId: ctx.userId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowRun', entityId: runId, action: 'WORKFLOW_RUN_FAILED',
        requestId: ctx.requestId, detailsJson: { category: 'access', reason: message },
    }).catch(() => undefined);
    return 'FAILED';
}

/**
 * Open a run row's context under verification — schema AND chain.
 *
 * This REPLACES a `JSON.parse` wrapped in `try {} catch { return { input: {},
 * outputs: {} } }`. That catch was the whole vulnerability in one line: a
 * context the engine could not read was silently replaced with an empty one and
 * the run carried on, so a corrupted or poisoned memory produced a run that
 * looked healthy and reasoned from state nobody wrote. There is no catch here;
 * the caller halts.
 */
function openRunContext(
    ctx: RequestContext,
    runId: string,
    row: { contextJson: string | null; contextHash: string | null },
    minSeq?: number,
): OpenedContext {
    return openSealedContext({
        tenantId: ctx.tenantId,
        runId,
        storedJson: row.contextJson,
        storedHash: row.contextHash,
        minSeq,
    });
}

/**
 * Seal the context and persist it together with whatever else the caller is
 * writing. `contextJson` and `contextHash` move in ONE statement — a write that
 * updated the blob without the head would present as a chain break at the next
 * step, i.e. the engine would frame itself.
 *
 * Throws `ContextIntegrityError` when the context fails validation or exceeds
 * the size cap, and in that case NOTHING is written: the row keeps the last
 * context that did verify. That is the point — an oversized context halts the
 * run and leaves the previous state intact, rather than being trimmed to fit
 * and carried forward as though it were whole.
 */
async function commitContext(
    ctx: RequestContext,
    runId: string,
    context: WorkflowContext,
    seq: number,
    previousHash: string | null,
    extra: Record<string, unknown>,
): Promise<{ seq: number; hash: string }> {
    const sealed = sealContext({ tenantId: ctx.tenantId, runId, seq, previousHash, context });
    await updateRun(ctx, runId, { ...extra, contextJson: sealed.json, contextHash: sealed.hash });
    recordWorkflowContextBytes(sealed.bytes);
    return { seq: sealed.seq, hash: sealed.hash };
}

/**
 * HALT AND REPORT. The run stops as FAILED carrying the integrity code, an
 * audit row records what failed, and a metric counts it.
 *
 * Everything that leaves this function is a code, a byte count or a SHA-256
 * digest. `describeContextHalt` and `ContextIntegrityError.detail` are both
 * closed shapes for that reason: the raw context is exactly what a poisoning
 * incident would tempt you to log, and the house rule (see `computeInputDigest`
 * in `@/app-layer/ai/decision-log`) is digest-only.
 *
 * Kept separate from `failRun` deliberately — a distinct audit action, so
 * "this run stopped because its memory could not be trusted" is a query rather
 * than a string search through step errors.
 */
async function haltRun(
    ctx: RequestContext,
    runId: string,
    err: ContextIntegrityError,
): Promise<string> {
    const message = describeContextHalt(err);
    await updateRun(ctx, runId, {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: message,
    });
    recordWorkflowContextIntegrityHalt({ code: err.code });
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowRun',
        entityId: runId,
        action: 'WORKFLOW_CONTEXT_INTEGRITY_HALTED',
        requestId: ctx.requestId,
        // `err.detail`'s fields named rather than spread. The type is closed and
        // carries no context CONTENT by construction — but a spread is opaque to
        // `local/no-raw-prompt-logging`, which must then count this position as
        // unjudged, and it would silently carry a future field into a permanent
        // audit row. These five are structural facts about the failure.
        detailsJson: {
            category: 'access',
            code: err.code,
            seq: err.detail.seq ?? null,
            bytes: err.detail.bytes ?? null,
            cap: err.detail.cap ?? null,
            expectedHash: err.detail.expectedHash ?? null,
            observedHash: err.detail.observedHash ?? null,
            blobDigest: err.detail.blobDigest ?? null,
            issueCount: err.detail.issueCount ?? null,
            issueFields: err.detail.issueFields ?? null,
        },
        metadataJson: { apiKeyId: ctx.apiKeyId ?? null, agentId: ctx.agentId ?? null },
    }).catch(() => undefined);
    return 'FAILED';
}

/**
 * Split a tool result into its payload and its provenance.
 *
 * A parse failure on `content[0]` yields `null`, which is the pre-existing
 * behaviour and is left alone: the run carries on with an empty output and the
 * step row records it. The provenance of an unreadable payload is untrusted,
 * which is what the reader returns for a missing block anyway.
 *
 * BOTH READS SIT INSIDE THE `try`, and that is not tidiness. This function's
 * whole contract is that a malformed result degrades to `{ null, untrusted }`
 * instead of ending the run — a step that throws here is caught upstream,
 * recorded FAILED and (absent `continueOnFailure`) fails the whole run. Reading
 * the provenance above the `try`, where a result with no `content` at all would
 * throw past the fallback, turned a shape the engine used to survive into a
 * dead run. Adding a read to this function means adding it inside the `try`.
 */
function parseToolResult(result: { content: Array<{ text: string }> }): ParsedToolResult {
    try {
        return {
            output: JSON.parse(result.content[0]?.text ?? 'null'),
            provenance: provenanceOfToolResult(result),
        };
    } catch {
        return { output: null, provenance: UNTRUSTED_PROVENANCE };
    }
}

/**
 * The static driver's entry point.
 *
 * A thin alias rather than a rename: `executeSteps` is the moved function and
 * keeping its name lets the byte-identity test compare it against the original
 * without a diff that is purely cosmetic.
 */
export const runStaticDriver = executeSteps;

