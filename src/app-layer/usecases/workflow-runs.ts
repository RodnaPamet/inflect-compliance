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

import { runInTenantContext } from '@/lib/db/rls-middleware';
import { parseEnumListFilter } from '@/app-layer/domain/list-filter';
import { assertCanRead, assertCanWrite } from '@/app-layer/policies/common';
import { badRequest, notFound, forbidden } from '@/lib/errors/types';
import { appendAuditEntry } from '@/lib/audit';
import { enforceMcpCapability, resolveMcpInvocation } from '@/lib/mcp/auth';
import { runReadTool } from '@/lib/mcp/tools/registry';
import { runProposeTool } from '@/lib/mcp/tools/propose-tools';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
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
    // Today every answer is `static`: `DRIVER_IMPLEMENTED.flue` is false, so
    // even a tenant with both switches on falls back with a named reason. The
    // decision is resolved and recorded anyway, and that is deliberate — a seam
    // whose first exercise is the diff that also makes it load-bearing has
    // never been observed working. This one is observable from the run's audit
    // entry before it can change any behaviour.
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
        return pending?.seq ?? run.stepCount - 1;
    });

    // RE-RESOLVED, not inherited from the start. A resume is a fresh
    // authorization moment — the same reason the run re-resolves its invocation
    // and its policy card here — and an operator who switched the tenant off a
    // driver between the checkpoint and the approval meant it.
    //
    // Before this, `executeFrom` was called without the argument at all, so a
    // resumed segment took the parameter's `STATIC_DRIVER` default whatever the
    // tenant was configured for, and no audit entry said so either way.
    const resumeDecision = await resolveDriverForRun(ctx.tenantId, {
        requestId: ctx.requestId,
        workflowKey: run.workflowKey,
    });
    const resumeRequested: AgentDriver = requestedDriver(def);
    const resumeDriver: AgentDriver = selectRunDriver(def, resumeDecision.driver).driver;

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
        ctx,
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
    await runInTenantContext(ctx, (db) =>
        db.workflowRun.update({
            where: { id: runId },
            data: { status: 'ABORTED', completedAt: new Date() },
        }),
    );
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
            include: { steps: { orderBy: { seq: 'asc' } } },
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




async function loadRunAndDef(ctx: RequestContext, runId: string) {
    const run = await getRunRow(ctx, runId);
    const def = getWorkflowDefinition(run.workflowKey);
    if (!def) throw forbidden('Workflow definition no longer exists');
    return { run, def };
}


