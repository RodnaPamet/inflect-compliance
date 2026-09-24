/**
 * Agentic workflow engine (Epic Agentic 1A) — the orchestration layer over the
 * MCP tools.
 *
 * THE LOAD-BEARING PROPERTY: an agentic workflow does MANY steps, some of which
 * PROPOSE writes. Every write STILL routes through the propose-not-commit
 * approval queue (`runProposeTool` → `createAgentProposal`) — the engine can
 * commit nothing a single MCP tool couldn't. Multi-step ≠ multi-privilege. The
 * engine adds orchestration + checkpoints + guardrails, NOT new authority.
 *
 * Steps execute SYNCHRONOUSLY until the run either completes or hits a
 * HUMAN_CHECKPOINT (→ AWAITING_APPROVAL) — where it PAUSES until a human calls
 * `resumeWorkflowRun`. Every step is an append-only `WorkflowStep` record + a
 * hash-chained audit entry. All tool calls run in the SAME tenant/RLS/permission
 * context as the MCP tools (inherited, not reinvented).
 *
 * "Inherited, not reinvented" is enforced rather than asserted: each execution
 * resolves an `McpInvocation` through `resolveMcpInvocation` — the same builder
 * `/api/mcp` uses — and every step runs on it, so an engine step gets the
 * principal-narrowed context, the per-tool permission check and the
 * deny-by-default tool allowlist that a direct tool call gets. Without that,
 * orchestration would be a way around the allowlist, which is the one thing this
 * engine promises it is not. (A resume re-enters `executeFrom` and therefore
 * re-resolves, so every settled term is re-read across a human checkpoint.)
 *
 * THE CONTEXT IS THE AGENT'S MEMORY, AND IT IS CHAINED. `contextJson`
 * accumulates across steps and every later step reads its instructions out of
 * it, so a value that got in once shapes behaviour long after the interaction
 * that produced it (OWASP ASI06). It is encrypted at rest, which protects
 * confidentiality and says nothing about whether the blob is the one the
 * previous step wrote. So every read validates the envelope against a schema
 * AND verifies a SHA-256 link against `WorkflowRun.contextHash`, and every
 * write re-seals — see `@/lib/agentic/context-integrity`. Any failure HALTS the
 * run (FAILED + the integrity code, an audit row and a metric). Nothing here
 * repairs, coerces or truncates: the executor previously swallowed a JSON parse
 * error and carried on with `{ input: {}, outputs: {} }`, which is a silent
 * memory reset — the worst available outcome and the one this closes.
 *
 * A TOOL RESULT'S PROVENANCE IS READ, NOT DROPPED. `runReadTool` labels every
 * payload with what it is made of and appends that label as a SECOND MCP
 * content block, so `content[0]` stays the exact JSON an external agent parses.
 * This engine used to take `content[0]` and return — so the tagging worked for
 * external clients and did nothing for the surface the product actually runs.
 * `parseToolResult` now returns both halves, the payload still goes into the
 * context unchanged, and the label lands on the step's audit row. It is
 * fail-closed: an absent, unreadable or unrecognised envelope reads as
 * `THIRD_PARTY_INGESTED`.
 *
 * REVOCATION IS CHECKED AT THE TOOL BOUNDARY, NOT AT DISPATCH. `authorizeToolCall`
 * re-reads the credential's live state before EVERY step's tool call, so revoking
 * a key stops a run already in flight at its next step. A status code cannot tell
 * that design from one that checks only at dispatch — both refuse the next
 * request — so the property is tested as "no further tool executed after the
 * revoke", with a spy on the tool itself.
 */
import { WorkflowRunStatus } from '@prisma/client';

import { runInTenantContext, runInGlobalContext } from '@/lib/db/rls-middleware';
import { getPermissionsForRole } from '@/lib/permissions';
import { enqueue } from '@/app-layer/jobs/queue';
import { failRun } from '@/lib/agentic/drivers/run-settlement';
import { parseEnumListFilter } from '@/app-layer/domain/list-filter';
import { assertCanRead, assertCanWrite } from '@/app-layer/policies/common';
import { badRequest, notFound, forbidden } from '@/lib/errors/types';
import { appendAuditEntry } from '@/lib/audit';
import { enforceMcpCapability, resolveMcpInvocation } from '@/lib/mcp/auth';
import { runReadTool } from '@/lib/mcp/tools/registry';
import { runProposeTool } from '@/lib/mcp/tools/propose-tools';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import { evaluateAgentRegistration } from '@/lib/agentic/agent-registration-gate';
import {
    provenanceOfToolResult,
    UNTRUSTED_PROVENANCE,
    type ContentProvenance,
} from '@/lib/agentic/content-provenance';
import { resolvePolicyCardPin } from '@/lib/agentic/policy-card-pin';
import { resolveDriverForRun } from '@/lib/agentic/agent-driver-policy';
import { assertWithinMonthlyBudget } from '@/lib/agentic/monthly-budget-policy';
import { trackInFlightRun, untrackInFlightRun } from '@/lib/agentic/in-flight-runs';
import { getRunRow } from '@/lib/agentic/drivers/run-store';
import { recordDecisionOutcome } from '@/app-layer/ai/decision-log';
import { selectRunDriver, requestedDriver } from '@/lib/agentic/drivers';
import type { RunDriverOutcome } from '@/lib/agentic/drivers';
import type { AgentDriver } from '@/lib/agentic/agent-driver';
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
import {
    describeFailure,
    isAgenticFatal,
} from '@/lib/agentic/failure-isolation';
import type { RequestContext } from '@/app-layer/types';

// ─── Public API ─────────────────────────────────────────────────────

export interface StartWorkflowResult {
    runId: string;
    status: string;
    workflowKey: string;
    /**
     * How many steps FAILED and were isolated (see `continueOnFailure`).
     *
     * On the result rather than left to a query, because a batch that does not
     * say how many members failed is a batch that reports a partial pass as a
     * clean one. Zero is the ordinary answer and the common case; anything else
     * means this run reasoned over less than its definition asked for.
     */
    stepFailures: number;
}

/**
 * Start a workflow run. Run creation requires the `mcp:orchestrate` capability
 * for API-key callers (strictly more privileged than `mcp:propose`); human
 * callers require write permission. Executes synchronously until completion or
 * the first HUMAN_CHECKPOINT.
 */
export async function startWorkflowRun(
    ctx: RequestContext,
    workflowKey: string,
    input: Record<string, unknown> = {},
): Promise<StartWorkflowResult> {
    if (ctx.apiKeyId) {
        enforceMcpCapability(ctx, 'orchestrate');
    } else {
        assertCanWrite(ctx);
    }

    const def = getWorkflowDefinition(workflowKey);
    if (!def) throw badRequest(`Unknown workflow: ${workflowKey}`);

    // PRE-FLIGHT: the tenant's monthly token budget.
    //
    // Here, and not one line later. Every per-run cap in `run-caps.ts` bounds a
    // SINGLE run and halts it at the boundary; nothing accumulates across runs,
    // so a tenant can stay inside every per-run cap and still spend without
    // limit by starting more of them. This is the only axis that spans runs and
    // it is checked exactly once, at the door.
    //
    // It sits ABOVE `createSealedRun` deliberately: a refusal after the row
    // exists leaves a RUNNING run nothing will ever advance, which the
    // `agentic-run-settlement` sweep would later reap as a crashed executor —
    // a refusal wearing the costume of an outage.
    //
    // No-ops for every tenant that has not configured a budget, which is all of
    // them until somebody sets one: a NULL column short-circuits before the
    // aggregate runs.
    await assertWithinMonthlyBudget(ctx);

    const context: WorkflowContext = { input, outputs: {} };

    // WHICH VERSION of this agent's policy card the run opens under. Resolved
    // BEFORE the row is written, because the pin is write-once at the database
    // and a row inserted without it can only ever be filled in by the one
    // NULL → value transition the trigger still permits — which a later segment
    // would have to remember to make.
    //
    // It is the version at the START. A run re-resolves its invocation after
    // every human checkpoint, so a run spanning a card edit is authorized under
    // the newer card for its later segments, and each call's own audit row
    // carries the version that decided it. This column answers the question
    // those rows cannot once the card has moved on: what did this run open
    // under.
    const policyCardVersion = await resolvePolicyCardPin(ctx.tenantId, ctx.agentId);

    // WHICH ENGINE executes this run. Resolved here, beside the card pin,
    // because both are properties of the run's OPENING — the question is "what
    // did this run start under", and both answers stop being recoverable once
    // the configuration moves on.
    //
    // `DRIVER_IMPLEMENTED.flue` has been TRUE since #2770 flipped it. This
    // comment said it was false — written when it was, and left behind when it
    // stopped being — so a reader checking why every run came out `static`
    // was sent to the wrong term. The answer is `static` because no registered
    // WorkflowDefinition sets `driver`, and `selectRunDriver` requires the
    // DEFINITION to request the engine, not merely the deployment to permit it.
    //
    // The decision is resolved and recorded regardless, and that is deliberate
    // — a seam whose first exercise is the diff that also makes it
    // load-bearing has never been observed working. This one is observable
    // from the run's audit entry before it can change any behaviour.
    const driverDecision = await resolveDriverForRun(ctx.tenantId, {
        requestId: ctx.requestId,
        workflowKey,
    });

    // WHAT WILL ACTUALLY WALK IT, which is not the same question.
    //
    // `driverDecision.driver` is what the deployment PERMITS. The definition
    // also gets a say, and `selectRunDriver` resolves any disagreement — and
    // any driver with no implementation — back to static. Recording the
    // permitted value as "which engine walked this run" is therefore a claim
    // about a different thing, and it is true today only because both answers
    // are always `static`.
    //
    // Resolved here, before the audit write, because the entry is appended
    // before the walk begins and a hash-chained row cannot be corrected
    // afterwards. `selectRunDriver` is pure, so asking it twice — once here,
    // once inside `executeFrom` — costs nothing and cannot disagree.
    // Both bound to locals rather than called inside the audit payload. The
    // values are a closed `'static' | 'flue'` union either way; what changes is
    // that `no-raw-prompt-logging` can READ an identifier and cannot open a
    // call, so spelling the call at the sink buys four un-analysable holes in a
    // guard whose whole design is that its blind spots are counted.
    const requested: AgentDriver = requestedDriver(def);
    const chosenDriver: AgentDriver = selectRunDriver(def, driverDecision.driver).driver;

    // ── A FLUE RUN MUST BE VOUCHED FOR BY THE REGISTER ──────────────────────
    //
    // Plan point 1: "A Flue run must resolve an ACTIVE RegisteredAgent and
    // stamp WorkflowRun.agentId." The stamp was here; the resolve was not, and
    // nothing else on this path supplied it — the route calls getTenantCtx and
    // then this function, and `planFlueRun` refuses only on driver, steps and
    // model. So a key bound to a SUSPENDED or RETIRED agent, or a signed-in
    // human with no binding at all, could start a reasoning loop.
    //
    // The human case is the worse one: with `ctx.agentId` null,
    // `buildMcpInvocation` leaves `grantedTools` null, which is NO ALLOWLIST
    // TERM — the deny-by-default tool list is keyed on the registered agent,
    // so an unbound caller skips it rather than being narrowed by it.
    //
    // UNCONDITIONAL, and deliberately stricter than `assertRegisteredAgent`.
    // That helper honours the tenant's `requireRegisteredAgent` toggle, which
    // is right for an MCP call: an unbound caller there still carries the
    // key's own scopes. A Flue run is an autonomous loop that chooses its own
    // tool calls, so "this tenant has not switched enforcement on" is not a
    // reason to let one start unvouched. `standing === 'vouched'` means
    // resolved AND ACTIVE; every other standing refuses here.
    //
    // ABOVE `createSealedRun`, for the reason the budget check above it is:
    // a refusal after the row exists leaves a RUNNING run nothing will
    // advance, which the reaper later reports as a crashed executor — a
    // refusal wearing the costume of an outage.
    if (chosenDriver === 'flue') {
        const gate = await evaluateAgentRegistration(ctx);
        if (gate.standing !== 'vouched') {
            throw forbidden(
                `flue_requires_registered_agent: a Flue run must be started by an ACTIVE ` +
                    `registered agent (standing: ${gate.standing}). The reasoning loop's tool ` +
                    `allowlist is keyed on the register, so an unvouched run would have none.`,
            );
        }
    }

    // Row + first chain link (seq 0, prev null), one transaction. An `input`
    // already over the size cap fails here and no run is created.
    //
    // The pin is passed IN rather than resolved inside: `createSealedRun` owns
    // the seal, not the authority question, and the pin has to be resolved
    // before the row exists because it is write-once at the database.
    const run = await createSealedRun(ctx, workflowKey, context, policyCardVersion, chosenDriver);

    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowRun',
        entityId: run.id,
        action: 'WORKFLOW_RUN_STARTED',
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            workflowKey,
            agentId: ctx.agentId ?? null,
            // The pin, in the trail as well as on the row. The row can be
            // deleted with its tenant; the hash-chained entry is what survives.
            policyCardVersion,
            // Which engine walked this run, and — when it was not the one
            // configured — why not. In the hash-chained trail rather than only
            // in a log line, because "which engine executed this" is a question
            // an incident review asks about a run that has long since finished,
            // and log retention is not the audit trail's retention.
            // THREE facts, because a single one cannot explain an engine
            // choice, and the gaps between them are what an incident review is
            // actually asking about:
            //
            //   driverRequested — what the DEFINITION asked for
            //   driverAllowed   — what the DEPLOYMENT permits (env ∧ tenant ∧
            //                     implemented), with `driverReason` naming why
            //                     when it is not what was configured
            //   driver          — what actually WALKED the run
            //
            // A definition cannot widen its own authority, so `driver` is the
            // intersection and never more than either. Recording only the
            // permitted value — which is what this entry used to do — answers
            // "what was this tenant allowed" under a key that says "which
            // engine walked this run", and those diverge the moment a
            // definition asks for something it cannot have.
            driverRequested: requested,
            driverAllowed: driverDecision.driver,
            driverReason: driverDecision.reason,
            driver: chosenDriver,
        },
        metadataJson: { apiKeyId: ctx.apiKeyId ?? null, agentId: ctx.agentId ?? null },
    }).catch(() => undefined);

    // ── WHERE THE RUN ACTUALLY EXECUTES ─────────────────────────────────────
    //
    // Flue runs go to the WORKER; static runs stay in the request.
    //
    // Not symmetry for its own sake. A static run is a walk over a
    // hand-written step array with no model call in it — bounded by
    // `ENGINE_CAPS.MAX_STEPS`, deterministic, and finished well inside a
    // request. A Flue run is a reasoning loop: it decides for itself how many
    // tools to call and how long to keep going, and the plan is explicit that
    // it belongs in the worker, "never the web tier". The worker also already
    // has the shutdown drain, which is what makes a SIGTERM mid-run survivable.
    //
    // Moving BOTH would change the contract of every existing run — the route
    // returns a terminal status today — for no benefit the static engine needs.
    if (chosenDriver === 'flue') {
        await enqueue('agent-run-execute', { tenantId: ctx.tenantId, runId: run.id });
        // RUNNING is what `createSealedRun` wrote (the column's default), and
        // it is reported rather than a synthesised QUEUED. The reaper already
        // understands a RUNNING row that stops moving; a new enum value would
        // have to be learned by every reader — list page, reaper, breaker —
        // to mean something the existing one already covers.
        return { runId: run.id, status: 'RUNNING', workflowKey, stepFailures: 0 };
    }

    const { status, stepFailures } = await executeFrom(
        ctx,
        run.id,
        def,
        0,
        Date.now(),
        driverDecision.driver,
    );
    return { runId: run.id, status, workflowKey, stepFailures };
}

/**
 * Resume a paused (AWAITING_APPROVAL / PAUSED) run after a human has acted on
 * its checkpoint. A privileged human action. Marks the pending checkpoint DONE
 * and continues from the next step.
 */
export async function resumeWorkflowRun(
    ctx: RequestContext,
    runId: string,
): Promise<{ status: string; stepFailures: number }> {
    assertCanWrite(ctx);
    const { run, def } = await loadRunAndDef(ctx, runId);
    if (run.status !== 'AWAITING_APPROVAL' && run.status !== 'PAUSED') {
        throw badRequest(`Run is ${run.status}, cannot resume`);
    }

    // ── RESOLVED FIRST, BECAUSE THE GATE BELOW NEEDS IT ────────────────────
    //
    // RE-RESOLVED, not inherited from the start. A resume is a fresh
    // authorization moment — the same reason the run re-resolves its
    // invocation and its policy card — and an operator who switched the tenant
    // off a driver between the checkpoint and the approval meant it.
    //
    // Before this, `executeFrom` was called without the argument at all, so a
    // resumed segment took the parameter's `STATIC_DRIVER` default whatever the
    // tenant was configured for, and no audit entry said so either way.
    //
    // HOISTED above the checkpoint close so the register gate can run before
    // anything is mutated: a refusal after the step is DONE and the row is
    // RUNNING leaves a run nothing will advance, which the reaper later reports
    // as a crashed executor — a refusal wearing the costume of an outage. The
    // start path makes the same argument for putting its gate above
    // `createSealedRun`.
    const resumeDecision = await resolveDriverForRun(ctx.tenantId, {
        requestId: ctx.requestId,
        workflowKey: run.workflowKey,
    });
    const resumeRequested: AgentDriver = requestedDriver(def);
    const resumeDriver: AgentDriver = selectRunDriver(def, resumeDecision.driver).driver;

    // ── THE SECOND DOOR INTO THE FLUE ENGINE ───────────────────────────────
    //
    // The start path refuses a Flue run that no ACTIVE `RegisteredAgent`
    // vouches for, and the worker's resume re-checks the agent and rebuilds
    // the run's principal. THIS path did neither. It re-resolved the driver
    // and went straight to `executeFrom` with a signed-in human's context, in
    // which `ctx.agentId` is undefined — `getTenantCtx` sets no `agentId`.
    //
    // What that unbound context does downstream is the whole of the register's
    // authority, silently dropped:
    //
    //   · `grantedTools` resolves null, and `toolIsLoadable` SKIPS the
    //     allowlist term when it is null rather than narrowing by it — the
    //     deny-by-default tool list is keyed on the registered agent;
    //   · both agent-side autonomy terms vanish, so the ceiling is computed
    //     over an empty set and comes back UNCLAMPED — the exact hazard
    //     #2399 closed, where suspending a CRITICAL agent PROMOTED it;
    //   · `settleAtGuard` latches the circuit breaker only when `ctx.agentId`
    //     is set, so a guard block on a resumed segment is never counted;
    //   · the Art 12 row names no AI system.
    //
    // And this is not a rare path — it is the one the guard arms BUILT. A
    // FLAGGED verdict settles the run `AWAITING_APPROVAL` precisely so a human
    // comes here and approves it. Flag, approve, and the continuation ran
    // unvouched, unclamped and unallowlisted.
    //
    // The fix is the worker's, not a new one: re-check the agent is still in
    // service, and restore the binding the run was started under.
    if (resumeDriver === 'flue' && !(await runAgentStillInService(ctx.tenantId, run.agentId))) {
        throw forbidden(
            'resume_agent_no_longer_in_service: the registered agent this run was started ' +
                'by is no longer ACTIVE, so the run does not resume on its behalf. ' +
                'Re-activate the agent, or abort the run.',
        );
    }

    // THE RUN'S BINDING, not the approver's. The human stays the ACTOR — the
    // audit entry below records them and the checkpoint step takes their
    // `userId` — while the execution carries the agent the run was authorised
    // under, so every register term applies to the continuation exactly as it
    // applied to the first segment. Same shape as `rebuildRunContext`'s
    // `...(row.agentId ? { agentId: row.agentId } : {})` on the worker path.
    const execCtx: RequestContext = run.agentId ? { ...ctx, agentId: run.agentId } : ctx;

    // Close the pending checkpoint step (the one that paused the run).
    const resumedFrom = await runInTenantContext(ctx, async (db) => {
        const pending = await db.workflowStep.findFirst({
            where: { runId, tenantId: ctx.tenantId, status: 'PENDING' },
            orderBy: { seq: 'desc' },
        });
        if (pending) {
            await db.workflowStep.update({
                where: { id: pending.id },
                data: { status: 'DONE', actorUserId: ctx.userId },
            });
        }
        await db.workflowRun.update({ where: { id: runId }, data: { status: 'RUNNING' } });
        // ═══ ART 14: A RESUME IS AN ACCEPTANCE ═══
        //
        // The run is the reviewable event for a model call. A Flue run that the
        // content guard FLAGGED parks at AWAITING_APPROVAL precisely so a human
        // decides whether it may go on, and `resumeWorkflowRun` is that
        // decision — so every decision row the run has written so far is
        // ACCEPTED, keyed on the run id the recorder put in `sessionRef`.
        //
        // NOT the proposal digest, which is what the three existing stampers
        // use: that digest is taken over `{ kind, payload, rationale }` and the
        // model-call row's is taken over the run PROMPT. Same shape, different
        // content, never equal — so a digest-keyed stamp here would report
        // `count: 0` and leave the loop looking closed. See
        // `flue/model-decision.ts` for the full argument.
        //
        // In the SAME transaction as the checkpoint close, for the reason
        // `rejectAgentProposal` gives: a human decision recorded on the run but
        // not on the decision log is a register that says a model call is still
        // awaiting a review that has already happened.
        //
        // A static run matches nothing here and that costs one indexed
        // `updateMany` — the engine that writes no decision rows has none to
        // stamp, and branching on the driver would put the engine's identity in
        // a place that does not otherwise need to know it.
        await recordDecisionOutcome(db, ctx, runId, 'ACCEPTED');
        return pending?.seq ?? run.stepCount - 1;
    });

    await appendAuditEntry({
        tenantId: ctx.tenantId, userId: ctx.userId, actorType: 'USER',
        entity: 'WorkflowRun', entityId: runId, action: 'WORKFLOW_RUN_RESUMED',
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            // Which engine walks THIS SEGMENT. `WorkflowRun.driver` records the
            // one the run opened under and deliberately does not move, so the
            // trail is the only place a mid-run change is visible.
            driverRequested: resumeRequested,
            driverAllowed: resumeDecision.driver,
            driverReason: resumeDecision.reason,
            driver: resumeDriver,
        },
    }).catch(() => undefined);

    // THE RUN'S OWN START, not this resume's. `Date.now()` here handed every
    // resumed run a fresh wall clock, so the hour-long `RUNTIME_MS` cap bounded
    // a SEGMENT and not a run — and a workflow with two checkpoints could span
    // three hours while every segment reported itself well inside the ceiling.
    // The same defect `actionsAlready` already fixed for the action budget, on
    // the one axis where the wrong answer looks most like the right one,
    // because a paused run genuinely is not spending anything.
    //
    // A run that sat at a checkpoint for a day has spent a day, and that is the
    // intended reading: `WALL_CLOCK_MS` is documented as "max wall-clock a run
    // may span (ACROSS RESUMES)".
    const { status, stepFailures } = await executeFrom(
        // BOUND, not the bare human context — see the register gate above.
        execCtx,
        runId,
        def,
        resumedFrom + 1,
        run.startedAt.getTime(),
        resumeDecision.driver,
    );
    return { status, stepFailures };
}

/** Abort a run (operator kill-switch). No mutation is left half-applied — writes
 *  are proposals, so aborting simply stops the run. */
export async function abortWorkflowRun(ctx: RequestContext, runId: string): Promise<void> {
    assertCanWrite(ctx);
    const run = await getRunRow(ctx, runId);
    if (['COMPLETED', 'ABORTED', 'FAILED'].includes(run.status)) {
        throw badRequest(`Run is already ${run.status}`);
    }
    await runInTenantContext(ctx, async (db) => {
        await db.workflowRun.update({
            where: { id: runId },
            data: { status: 'ABORTED', completedAt: new Date() },
        });
        // ═══ ART 14: AN ABORT IS A REJECTION ═══
        //
        // The other half of the resume above, and the same key. A human
        // stopping a run refuses what it decided, so its model-call decision
        // rows move PENDING → REJECTED rather than sitting at "awaiting review"
        // for ever after the review that killed the run.
        //
        // One-way, so a run aborted after a resume keeps the ACCEPTED the
        // resume wrote: `recordDecisionOutcome` filters `humanOutcome:
        // 'PENDING'` and the DB trigger enforces the same. That is the right
        // reading — the human accepted what the run had done at the checkpoint,
        // and then refused what it did next.
        await recordDecisionOutcome(db, ctx, runId, 'REJECTED');
    });
    await appendAuditEntry({
        tenantId: ctx.tenantId, userId: ctx.userId, actorType: 'USER',
        entity: 'WorkflowRun', entityId: runId, action: 'WORKFLOW_RUN_ABORTED',
        requestId: ctx.requestId, detailsJson: { category: 'access' },
    }).catch(() => undefined);
}

export async function getWorkflowRun(ctx: RequestContext, runId: string) {
    assertCanRead(ctx);
    const run = await runInTenantContext(ctx, (db) =>
        db.workflowRun.findFirst({
            where: { id: runId, tenantId: ctx.tenantId },
            include: {
                steps: { orderBy: { seq: 'asc' } },
                // WHAT THIS RUN PROPOSED, by step.
                //
                // An explicit SELECT, never the whole row. This usecase is
                // returned VERBATIM by `GET /agent-runs/:id`, so widening the
                // include widens what that route emits — and an `AgentProposal`
                // carries `payloadJson`, the one column the proposals surface
                // deliberately refuses to send to a browser. Naming the fields
                // keeps a convenience here from becoming a leak there.
                //
                // Ordered by `stepSeq` so the grouping a caller does is over a
                // sorted list; `null` sorts first, which is correct for a
                // proposal that names no step.
                proposals: {
                    select: {
                        id: true,
                        kind: true,
                        operation: true,
                        status: true,
                        stepSeq: true,
                        guardVerdict: true,
                        createdAt: true,
                    },
                    orderBy: { stepSeq: 'asc' },
                },
            },
        }),
    );
    if (!run) throw notFound('Workflow run not found');
    return run;
}

export async function listWorkflowRuns(
    ctx: RequestContext,
    opts: { status?: string; take?: number } = {},
) {
    assertCanRead(ctx);
    // `opts.status` is a raw `?status=` query-string value — the `as never`
    // this replaces silenced the compiler but not Prisma, which 500'd on a
    // comma-joined multi-select or a status from another entity's enum.
    const status = parseEnumListFilter<WorkflowRunStatus>(
        opts.status,
        Object.values(WorkflowRunStatus),
        'workflow run status',
    );
    return runInTenantContext(ctx, (db) =>
        db.workflowRun.findMany({
            where: { tenantId: ctx.tenantId, status },
            orderBy: { startedAt: 'desc' },
            take: opts.take ?? 50,
            // HOW MANY PROPOSALS ARE ACTUALLY WAITING on this run.
            //
            // A filtered relation count rather than a join, because the list
            // needs the NUMBER and never the rows. It exists because
            // `AWAITING_APPROVAL` does not mean "there are proposals to
            // approve": a HUMAN_CHECKPOINT pauses a run whether or not it
            // queued anything, and a content-guard flag pauses one that
            // queued nothing at all. Without this the list can only guess,
            // and it guessed wrong in one direction for every such run.
            include: {
                _count: { select: { proposals: { where: { status: 'PENDING' } } } },
            },
        }),
    );
}

// ─── The executor ───────────────────────────────────────────────────


/**
 * Execute a run, and tell this process it is doing so.
 *
 * The tracking lives HERE rather than at the two call sites (`startWorkflowRun`
 * and `resumeWorkflowRun`) so a third caller cannot be added without it. What
 * it buys is at `src/lib/agentic/in-flight-runs.ts`: on SIGTERM the shutdown
 * handler moves exactly these runs to PAUSED, so a rolling deploy leaves them
 * resumable instead of abandoned RUNNING for `agent-run-reaper` to settle to
 * FAILED a wall-clock budget plus ten minutes later.
 *
 * `finally`, not `then` — a run that threw is no longer executing, and leaving
 * it tracked would have the drain pause a row that has already settled.
 */
async function executeFrom(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    fromSeq: number,
    runStartMs: number,
    // NO DEFAULT, deliberately. It was `= STATIC_DRIVER`, and a default is
    // exactly how the resolved decision came to be computed, audited, and then
    // dropped on the floor: both call sites simply omitted the argument and
    // the fallback made that look intentional. Required, the compiler asks
    // every caller the question rather than answering it for them.
    permittedDriver: AgentDriver,
): Promise<RunDriverOutcome> {
    // WHICH ENGINE, resolved here rather than inside the walk. The definition's
    // request is intersected with what the deployment permits, and any
    // disagreement resolves to static — see `selectRunDriver`.
    const { run } = selectRunDriver(def, permittedDriver);

    trackInFlightRun(runId);
    try {
        return await run(ctx, runId, def, fromSeq, runStartMs);
    } finally {
        untrackInFlightRun(runId);
    }
}


// ─── Helpers ────────────────────────────────────────────────────────











/**
 * Create the run row and seal its FIRST chain link (seq 0, prev null) in ONE
 * transaction.
 *
 * Two statements rather than one because the link binds the run id and the id
 * does not exist until the row does. Both in the same transaction so a row can
 * never be committed with a context and no head — that state would read as
 * `CONTEXT_UNSEALED` and halt a run that had done nothing wrong.
 *
 * A caller's `input` that is already over the cap therefore fails HERE and the
 * run is never created: the transaction rolls back and the caller gets a 400
 * naming the cap. That is the same halt-and-report the executor does mid-run,
 * moved to the only place a start can report it — there is no run yet to mark
 * FAILED.
 */
async function createSealedRun(
    ctx: RequestContext,
    workflowKey: string,
    context: WorkflowContext,
    policyCardVersion: number,
    driver: AgentDriver,
): Promise<{ id: string }> {
    try {
        return await runInTenantContext(ctx, async (db) => {
            const created = await db.workflowRun.create({
                data: {
                    tenantId: ctx.tenantId,
                    workflowKey,
                    status: 'RUNNING',
                    startedByUserId: ctx.userId,
                    triggeredViaKeyId: ctx.apiKeyId ?? null,
                    // WHICH registered agent this run belongs to. `null` for a
                    // human-started run — a person is not an agent, and inventing
                    // one to satisfy the column would put a fiction in the
                    // register's own attribution. Written explicitly either way;
                    // `local/require-agent-attribution` refuses a write site that
                    // leaves the field out.
                    agentId: ctx.agentId ?? null,
                    // …and under WHICH VERSION of that agent's declared policy.
                    // `NO_POLICY_CARD` (0) for a human-started run — the question
                    // was asked and the answer was "none", which is a different
                    // fact from the NULL a pre-pinning row carries. Written in
                    // the CREATE, not the seal update below: the pin is
                    // write-once at the database, so the row must arrive
                    // carrying it.
                    policyCardVersion,
                    // …and on WHICH ENGINE. Written in the CREATE rather than
                    // updated after the walk: a run that crashes mid-step still
                    // has to be able to say what was executing it.
                    driver: driver === 'flue' ? 'FLUE' : 'STATIC',
                },
                select: { id: true },
            });
            const sealed = sealContext({
                tenantId: ctx.tenantId,
                runId: created.id,
                seq: 0,
                previousHash: null,
                context,
            });
            await db.workflowRun.update({
                where: { id: created.id },
                data: { contextJson: sealed.json, contextHash: sealed.hash },
            });
            recordWorkflowContextBytes(sealed.bytes);
            return created;
        });
    } catch (err) {
        if (err instanceof ContextIntegrityError) {
            recordWorkflowContextIntegrityHalt({ code: err.code });
            throw badRequest(describeContextHalt(err));
        }
        throw err;
    }
}





/**
 * What the worker did with a queued run.
 *
 * A union rather than an optional field: "it executed and here is the status"
 * and "it correctly declined, for this reason" are different outcomes, and a
 * caller that has to check whether `status` happens to be set will eventually
 * forget to.
 */
export type QueuedRunOutcome =
    | { status: string; stepFailures: number }
    | { skipped: string };

/**
 * EXECUTE A RUN THAT WAS ENQUEUED — the worker's entry point.
 *
 * ── WHY THE PRINCIPAL IS REBUILT, NOT SUBSTITUTED ───────────────────────────
 *
 * The obvious shape, and the one several jobs in this repo already use, is
 * `buildCtx(tenantId)` — find the first active OWNER/ADMIN and run as them.
 * That is right for a sweep that belongs to the platform. It is wrong here,
 * and not by a little: a run's authority is the intersection of the agent's
 * registration, the key's scopes, the autonomy ceiling and the policy card of
 * the principal who STARTED it. Executing it as an admin would hand the run a
 * different — almost certainly wider — authority than the one it was
 * authorised under, in a subsystem whose entire claim is that multi-step does
 * not mean multi-privilege.
 *
 * So the principal comes off the run row, which already records every term:
 * `startedByUserId`, `triggeredViaKeyId`, `agentId`, `policyCardVersion`.
 *
 * ── WHAT IS RE-READ RATHER THAN PINNED, AND WHY ─────────────────────────────
 *
 * The ROLE and the key's SCOPES are read at execution time, not carried from
 * the enqueue. Authority is current: a principal whose membership was revoked
 * between enqueue and execution must not have a queued job act for them, and
 * a key whose scopes were narrowed must not widen again by having been used
 * earlier. The policy card is the deliberate exception — `policyCardVersion`
 * is pinned on the row precisely so a run is judged by the rules in force when
 * it started.
 *
 * FAIL CLOSED: no active membership, no execution. The run is settled FAILED
 * with a message naming the reason rather than left RUNNING for the reaper,
 * because "the person who started this lost access" is an answer an operator
 * wants, and a wedged row is not.
 *
 * ── WHY `fromSeq` COMES FROM THE LEDGER ─────────────────────────────────────
 *
 * Not from the payload. A SIGTERM mid-run leaves the committed steps in place
 * and the row RUNNING; BullMQ retries; this reads how many steps actually
 * landed and resumes after them. A payload-carried index would re-execute a
 * step the run had already committed — and the steps that call tools are not
 * idempotent.
 */
export async function executeQueuedWorkflowRun(
    tenantId: string,
    runId: string,
): Promise<QueuedRunOutcome> {
    // Read the row BEFORE there is a context to read it with — the one place
    // that is unavoidable, and scoped by BOTH ids so a wrong tenant cannot
    // reach another's run even here.
    const row = await runInGlobalContext((db) =>
        db.workflowRun.findFirst({
            where: { id: runId, tenantId },
            select: {
                id: true, tenantId: true, workflowKey: true, status: true,
                startedByUserId: true, triggeredViaKeyId: true, agentId: true,
                stepCount: true, startedAt: true,
            },
        }),
    );
    if (!row) return { skipped: 'NOT_FOUND' };

    // IDEMPOTENT. A retry that arrives after the run already settled — or
    // after a human aborted it — must not restart it. Only a RUNNING row has
    // work left, and BullMQ can deliver a job more than once.
    if (row.status !== 'RUNNING') return { skipped: `NOT_RUNNING:${row.status}` };

    const def = getWorkflowDefinition(row.workflowKey);
    if (!def) {
        await failRun(
            { tenantId, userId: row.startedByUserId ?? 'system' } as RequestContext,
            runId,
            'workflow_definition_missing: the workflow this run was started from no longer exists.',
        );
        return { skipped: 'NO_DEFINITION' };
    }

    if (!(await runAgentStillInService(tenantId, row.agentId))) {
        await failRun(
            { tenantId, userId: row.startedByUserId ?? 'system' } as RequestContext,
            runId,
            'run_agent_no_longer_in_service: the registered agent this run was started by ' +
                'is no longer ACTIVE, so the run does not resume on its behalf.',
        );
        return { skipped: 'AGENT_NOT_ACTIVE' };
    }

    const ctx = await rebuildRunContext(row);
    if (!ctx) {
        await failRun(
            { tenantId, userId: row.startedByUserId ?? 'system' } as RequestContext,
            runId,
            'run_principal_no_longer_authorised: the principal that started this run ' +
                'no longer holds an active membership in this workspace.',
        );
        return { skipped: 'PRINCIPAL_REVOKED' };
    }

    const permitted = (
        await resolveDriverForRun(ctx.tenantId, {
            requestId: ctx.requestId,
            workflowKey: row.workflowKey,
        })
    ).driver;
    const { status, stepFailures } = await executeFrom(
        ctx,
        runId,
        def,
        // The ledger's answer, not the payload's.
        row.stepCount,
        row.startedAt.getTime(),
        permitted,
    );
    return { status, stepFailures };
}


/**
 * Rebuild the principal who started a run, from the row that recorded them.
 *
 * Returns `null` when that principal can no longer act — which is the whole
 * point of the function. A queued job must not be a way for authority to
 * outlive the grant that created it.
 *
 * The API key is re-read for the same reason: `triggeredViaKeyId` says which
 * key started the run, and the SCOPES it carries now are the ones it may use
 * now. A key that was narrowed, or revoked, between enqueue and execution
 * narrows the run with it.
 */
async function rebuildRunContext(row: {
    tenantId: string;
    startedByUserId: string | null;
    triggeredViaKeyId: string | null;
    agentId: string | null;
}): Promise<RequestContext | null> {
    if (!row.startedByUserId) return null;

    const membership = await runInGlobalContext((db) =>
        db.tenantMembership.findFirst({
            where: { tenantId: row.tenantId, userId: row.startedByUserId as string, status: 'ACTIVE' },
            select: { role: true, customRoleId: true },
        }),
    );
    // FAIL CLOSED. No active membership, no context, no execution.
    if (!membership) return null;

    let apiKeyScopes: string[] | undefined;
    if (row.triggeredViaKeyId) {
        const now = new Date();
        const key = await runInGlobalContext((db) =>
            db.tenantApiKey.findFirst({
                where: {
                    id: row.triggeredViaKeyId as string,
                    tenantId: row.tenantId,
                    revokedAt: null,
                    // EXPIRY COUNTS TOO. A key that lapsed while the job sat in
                    // the queue is as gone as a revoked one; only `revokedAt`
                    // would let a run continue on a credential that no live
                    // request could use.
                    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                },
                select: { scopes: true },
            }),
        );
        // A revoked or lapsed key is the same answer as a revoked membership:
        // the grant that authorised this run is gone, so the run does not
        // continue on it.
        if (!key) return null;
        // `scopes` is a Json column holding an array of strings. Narrowed
        // rather than asserted: a malformed value yields NO scopes, which
        // fails closed, where a cast would hand the run whatever was there.
        apiKeyScopes = Array.isArray(key.scopes)
            ? key.scopes.filter((v): v is string => typeof v === 'string')
            : [];
    }

    const appPermissions = getPermissionsForRole(membership.role);
    return {
        // Correlates every log line and audit row of this attempt back to the
        // run, which is what an operator has when they open the page.
        requestId: `agent-run-${row.tenantId}-${row.startedByUserId}`,
        userId: row.startedByUserId,
        tenantId: row.tenantId,
        role: membership.role,
        // Derived from the granular set exactly as `risk-appetite-jobs`
        // does — the coarse five are a projection of it, not a second source.
        permissions: {
            canRead: appPermissions.risks.view,
            canWrite: appPermissions.risks.edit,
            canAdmin: appPermissions.admin.manage,
            canAudit: appPermissions.audits.view,
            canExport: appPermissions.reports.export,
        },
        appPermissions,
        // NOT `actorType: 'JOB'`. The worker is only where this runs; the run
        // was asked for by a person or a key, and the audit trail must keep
        // saying so or a review cannot tell an agent's work from a sweep's.
        ...(row.triggeredViaKeyId ? { apiKeyId: row.triggeredViaKeyId, apiKeyScopes } : {}),
        ...(row.agentId ? { agentId: row.agentId } : {}),
    } as RequestContext;
}

/**
 * Is the agent this run was started by STILL in service?
 *
 * The gap this closes, found by an adversarial review of point 1: the worker
 * re-read the membership and failed closed on revocation, re-read the key and
 * failed closed on revoke or expiry — and then restored `ctx.agentId` with no
 * check of the agent at all. The one principal that IS an agent was the one
 * principal not re-validated.
 *
 * Authority is current, exactly as it is for the membership and the key. An
 * agent suspended or retired while its run sat in the queue must not have that
 * run resume on its behalf — suspension is an operator stopping an agent, and
 * a queue is not a way around it.
 *
 * Returns true when there is no agent to check. A run with no `agentId` cannot
 * be a Flue run (the start path now refuses those), so this is the static
 * engine's row and the register has nothing to say about it.
 */
async function runAgentStillInService(tenantId: string, agentId: string | null): Promise<boolean> {
    if (!agentId) return true;
    const agent = await runInGlobalContext((db) =>
        db.registeredAgent.findFirst({
            where: { id: agentId, tenantId, status: 'ACTIVE' },
            select: { id: true },
        }),
    );
    return Boolean(agent);
}

async function loadRunAndDef(ctx: RequestContext, runId: string) {
    const run = await getRunRow(ctx, runId);
    const def = getWorkflowDefinition(run.workflowKey);
    if (!def) throw forbidden('Workflow definition no longer exists');
    return { run, def };
}


