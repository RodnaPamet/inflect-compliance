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
import { resolvePolicyCardPin } from '@/lib/agentic/policy-card-pin';
import {
    ENGINE_CAPS,
    estimateTokens,
    type WorkflowContext,
    type WorkflowDefinition,
} from '@/lib/agentic/workflow-types';
import {
    ContextIntegrityError,
    describeContextHalt,
    openSealedContext,
    sealContext,
    type OpenedContext,
} from '@/lib/agentic/context-integrity';
import {
    recordWorkflowContextBytes,
    recordWorkflowContextIntegrityHalt,
} from '@/lib/observability/metrics';
import type { RequestContext } from '@/app-layer/types';

// ─── Public API ─────────────────────────────────────────────────────

export interface StartWorkflowResult {
    runId: string;
    status: string;
    workflowKey: string;
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

    // Row + first chain link (seq 0, prev null), one transaction. An `input`
    // already over the size cap fails here and no run is created.
    //
    // The pin is passed IN rather than resolved inside: `createSealedRun` owns
    // the seal, not the authority question, and the pin has to be resolved
    // before the row exists because it is write-once at the database.
    const run = await createSealedRun(ctx, workflowKey, context, policyCardVersion);

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
        },
        metadataJson: { apiKeyId: ctx.apiKeyId ?? null, agentId: ctx.agentId ?? null },
    }).catch(() => undefined);

    const status = await executeFrom(ctx, run.id, def, 0, Date.now());
    return { runId: run.id, status, workflowKey };
}

/**
 * Resume a paused (AWAITING_APPROVAL / PAUSED) run after a human has acted on
 * its checkpoint. A privileged human action. Marks the pending checkpoint DONE
 * and continues from the next step.
 */
export async function resumeWorkflowRun(ctx: RequestContext, runId: string): Promise<{ status: string }> {
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

    await appendAuditEntry({
        tenantId: ctx.tenantId, userId: ctx.userId, actorType: 'USER',
        entity: 'WorkflowRun', entityId: runId, action: 'WORKFLOW_RUN_RESUMED',
        requestId: ctx.requestId, detailsJson: { category: 'access' },
    }).catch(() => undefined);

    const status = await executeFrom(ctx, runId, def, resumedFrom + 1, Date.now());
    return { status };
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
 * Execute steps from `fromSeq` until completion or a HUMAN_CHECKPOINT. Returns
 * the run's resulting status. Enforces the per-run step / token / wall-clock
 * caps. A thrown step marks the run FAILED (never a half-applied mutation —
 * writes are proposals).
 *
 * It also enforces the FOURTH cap, which is not in `ENGINE_CAPS` because it
 * bounds a different thing: the other three bound what a run may SPEND, this
 * one bounds what a single persisted context may WEIGH. A run can sit far
 * inside its token budget while one tool output makes its memory unbounded.
 * Over the cap the run HALTS — see `commitContext`; nothing is trimmed to fit.
 */
async function executeFrom(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    fromSeq: number,
    runStartMs: number,
): Promise<string> {
    // ONE read for the run row, and it carries three things: the cost so far,
    // the sealed context, and its chain head. (It used to be two reads — one in
    // `loadContext`, one in `currentCost` — of the same row.)
    const initial = await getRunRow(ctx, runId);
    let stepCount = fromSeq;
    let costTokens = initial.costTokens ?? 0;

    // The run's memory, opened under verification. A failure here is a HALT,
    // not a reset: `openSealedContext` has no path that returns a context it
    // could not verify, and this function has no path that continues without
    // one.
    let opened: OpenedContext;
    try {
        opened = openRunContext(ctx, runId, initial);
    } catch (err) {
        if (err instanceof ContextIntegrityError) return haltRun(ctx, runId, err);
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

    for (let seq = fromSeq; seq < def.steps.length; seq++) {
        // ── Guardrails ──
        if (seq >= ENGINE_CAPS.MAX_STEPS) {
            return failRun(ctx, runId, `step cap (${ENGINE_CAPS.MAX_STEPS}) exceeded`);
        }
        if (Date.now() - runStartMs > ENGINE_CAPS.WALL_CLOCK_MS) {
            return failRun(ctx, runId, 'wall-clock timeout exceeded');
        }
        if (costTokens > ENGINE_CAPS.MAX_TOKENS) {
            return failRun(ctx, runId, `token budget (${ENGINE_CAPS.MAX_TOKENS}) exceeded`);
        }
        // Abort/pause may have been requested between steps.
        const live = await getRunRow(ctx, runId);
        if (live.status === 'ABORTED' || live.status === 'PAUSED') return live.status;

        // RE-OPEN THE CONTEXT FROM THE ROW AT EVERY STEP, rather than trusting
        // the copy this function is holding. That is what makes "a tampered
        // context is caught at the NEXT step" true rather than asserted: the
        // between-steps window is real (a HUMAN_CHECKPOINT can pause a run for
        // days, and `resumeWorkflowRun` re-enters here), and a verifier that
        // only ever checks its own in-memory value would see nothing that
        // happened in it. The row is already being fetched for the abort check,
        // so this costs no extra query.
        try {
            const reopened = openRunContext(ctx, runId, live);
            context = reopened.context;
            chainSeq = reopened.seq;
            chainHash = reopened.hash;
        } catch (err) {
            if (err instanceof ContextIntegrityError) return haltRun(ctx, runId, err);
            throw err;
        }

        const step = def.steps[seq];
        try {
            if (step.kind === 'HUMAN_CHECKPOINT') {
                await recordStep(ctx, runId, seq, 'HUMAN_CHECKPOINT', {
                    status: 'PENDING', label: step.label,
                });
                await commitContext(ctx, runId, context, chainSeq + 1, chainHash, {
                    status: 'AWAITING_APPROVAL',
                    stepCount: seq + 1,
                });
                return 'AWAITING_APPROVAL';
            }

            if (step.kind === 'READ') {
                const args = step.args ? step.args(context) : {};
                const result = await runReadTool(invocation, step.tool, args);
                const output = parseToolResult(result);
                context.outputs[step.label] = output;
                costTokens += estimateTokens(output);
                await recordStep(ctx, runId, seq, 'READ', { toolCalled: step.tool, input: args, output, status: 'DONE', label: step.label });
            } else if (step.kind === 'PROPOSE') {
                const items = step.buildItems(context);
                if (items.length === 0) {
                    await recordStep(ctx, runId, seq, 'PROPOSE', { toolCalled: step.tool, status: 'SKIPPED', label: step.label });
                } else {
                    const rationale = step.rationale ? step.rationale(context) : undefined;
                    const result = await runProposeTool(invocation, step.tool, { items, rationale });
                    const output = parseToolResult(result);
                    context.outputs[step.label] = output;
                    costTokens += estimateTokens(output);
                    await recordStep(ctx, runId, seq, 'PROPOSE', { toolCalled: step.tool, input: { count: items.length }, output, status: 'DONE', label: step.label });
                }
            } else if (step.kind === 'SYNTHESIS') {
                const syn = step.synthesize(context);
                context.outputs[step.label] = syn;
                costTokens += estimateTokens(syn);
                await recordStep(ctx, runId, seq, 'SYNTHESIS', { output: syn, status: 'DONE', label: step.label });
            }

            stepCount = seq + 1;
            const committed = await commitContext(ctx, runId, context, chainSeq + 1, chainHash, {
                stepCount,
                costTokens,
            });
            chainSeq = committed.seq;
            chainHash = committed.hash;
        } catch (err) {
            // An integrity failure is NOT a step failure and must not be
            // recorded as one: the step ran, the context it produced is the
            // problem. It also must not fall through to `failRun`, which would
            // report a tool error where the finding is a poisoned or oversized
            // memory. Checked first, for both reasons.
            if (err instanceof ContextIntegrityError) return haltRun(ctx, runId, err);
            const message = err instanceof Error ? err.message : String(err);
            await recordStep(ctx, runId, seq, step.kind, { status: 'FAILED', label: step.label, output: { error: message } });
            return failRun(ctx, runId, `step ${seq} (${step.kind}) failed: ${message}`);
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
        if (err instanceof ContextIntegrityError) return haltRun(ctx, runId, err);
        throw err;
    }
    return 'COMPLETED';
}

// ─── Helpers ────────────────────────────────────────────────────────

interface StepRecord {
    toolCalled?: string;
    input?: unknown;
    output?: unknown;
    status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';
    label: string;
    actorUserId?: string;
}

async function recordStep(
    ctx: RequestContext,
    runId: string,
    seq: number,
    kind: 'READ' | 'PROPOSE' | 'HUMAN_CHECKPOINT' | 'SYNTHESIS',
    rec: StepRecord,
): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        db.workflowStep.create({
            data: {
                runId, tenantId: ctx.tenantId, seq, kind,
                toolCalled: rec.toolCalled ?? null,
                inputJson: rec.input !== undefined ? JSON.stringify(rec.input) : null,
                outputJson: rec.output !== undefined ? JSON.stringify(rec.output) : null,
                status: rec.status,
                actorUserId: rec.actorUserId ?? null,
            },
        }),
    );
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowStep',
        entityId: `${runId}:${seq}`,
        action: 'WORKFLOW_STEP',
        requestId: ctx.requestId,
        detailsJson: { category: 'access', kind, label: rec.label, tool: rec.toolCalled ?? null, status: rec.status },
        metadataJson: { apiKeyId: ctx.apiKeyId ?? null, runId },
    }).catch(() => undefined);
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

async function failRun(ctx: RequestContext, runId: string, message: string): Promise<string> {
    await updateRun(ctx, runId, { status: 'FAILED', completedAt: new Date(), errorMessage: message });
    await appendAuditEntry({
        tenantId: ctx.tenantId, userId: ctx.userId, actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowRun', entityId: runId, action: 'WORKFLOW_RUN_FAILED',
        requestId: ctx.requestId, detailsJson: { category: 'access', reason: message },
    }).catch(() => undefined);
    return 'FAILED';
}

async function getRunRow(ctx: RequestContext, runId: string) {
    const run = await runInTenantContext(ctx, (db) =>
        db.workflowRun.findFirst({ where: { id: runId, tenantId: ctx.tenantId } }),
    );
    if (!run) throw notFound('Workflow run not found');
    return run;
}

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
): OpenedContext {
    return openSealedContext({
        tenantId: ctx.tenantId,
        runId,
        storedJson: row.contextJson,
        storedHash: row.contextHash,
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

async function loadRunAndDef(ctx: RequestContext, runId: string) {
    const run = await getRunRow(ctx, runId);
    const def = getWorkflowDefinition(run.workflowKey);
    if (!def) throw forbidden('Workflow definition no longer exists');
    return { run, def };
}

function parseToolResult(result: { content: Array<{ text: string }> }): unknown {
    try {
        return JSON.parse(result.content[0]?.text ?? 'null');
    } catch {
        return null;
    }
}
