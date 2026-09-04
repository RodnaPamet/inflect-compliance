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
    ENGINE_CAPS,
    estimateTokens,
    type WorkflowContext,
    type WorkflowDefinition,
} from '@/lib/agentic/workflow-types';
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
    const run = await runInTenantContext(ctx, (db) =>
        db.workflowRun.create({
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
                contextJson: JSON.stringify(context),
            },
            select: { id: true },
        }),
    );

    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowRun',
        entityId: run.id,
        action: 'WORKFLOW_RUN_STARTED',
        requestId: ctx.requestId,
        detailsJson: { category: 'access', workflowKey, agentId: ctx.agentId ?? null },
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
 */
async function executeFrom(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    fromSeq: number,
    runStartMs: number,
): Promise<string> {
    const context = await loadContext(ctx, runId);
    let stepCount = fromSeq;
    let costTokens = await currentCost(ctx, runId);

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
    const invocation = await resolveMcpInvocation(ctx);

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

        const step = def.steps[seq];
        try {
            if (step.kind === 'HUMAN_CHECKPOINT') {
                await recordStep(ctx, runId, seq, 'HUMAN_CHECKPOINT', {
                    status: 'PENDING', label: step.label,
                });
                await updateRun(ctx, runId, { status: 'AWAITING_APPROVAL', stepCount: seq + 1, contextJson: JSON.stringify(context) });
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
            await updateRun(ctx, runId, { stepCount, costTokens, contextJson: JSON.stringify(context) });
        } catch (err) {
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
    await updateRun(ctx, runId, {
        status: 'COMPLETED', completedAt: new Date(), stepCount, costTokens,
        contextJson: JSON.stringify(context), summary: summaryText,
    });
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

async function loadContext(ctx: RequestContext, runId: string): Promise<WorkflowContext> {
    const run = await getRunRow(ctx, runId);
    try {
        return run.contextJson ? (JSON.parse(run.contextJson) as WorkflowContext) : { input: {}, outputs: {} };
    } catch {
        return { input: {}, outputs: {} };
    }
}

async function currentCost(ctx: RequestContext, runId: string): Promise<number> {
    const run = await getRunRow(ctx, runId);
    return run.costTokens ?? 0;
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
