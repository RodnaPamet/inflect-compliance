/**
 * Automation execution usecases (Workflow Automation Epic 6).
 *
 * The GRC-critical audit trail: a paginated, PII-scrubbed history of every
 * rule firing, plus a manual re-trigger that replays a rule through the
 * dispatcher as a fresh execution.
 */
import { RequestContext } from '../types';
import {
    AutomationRuleRepository,
    AutomationExecutionRepository,
    assertCanReadAutomationHistory,
    assertCanExecuteAutomation,
    matchesFilter,
} from '../automation';
import { notFound, badRequest } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { enqueue } from '../jobs/queue';
import { logEvent } from '../events/audit';
import type { AutomationExecutionStatus } from '@prisma/client';

/**
 * Payload keys never returned to the client — a defence-in-depth blocklist
 * over the snapshotted trigger payload (which is producer-shaped and could
 * carry sensitive free text). Matching is case-insensitive substring.
 */
const PII_BLOCKLIST = ['email', 'password', 'secret', 'token', 'ssn', 'apikey', 'api_key'];

function scrubPayload(payload: unknown): Record<string, unknown> {
    if (!payload || typeof payload !== 'object') return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
        const lower = k.toLowerCase();
        out[k] = PII_BLOCKLIST.some((b) => lower.includes(b)) ? '[redacted]' : v;
    }
    return out;
}

export async function listRuleExecutions(
    ctx: RequestContext,
    ruleId: string,
    opts: { limit?: number; cursor?: string; status?: AutomationExecutionStatus } = {},
) {
    assertCanReadAutomationHistory(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { items, nextCursor } = await AutomationExecutionRepository.listForRulePaginated(
            db,
            ctx,
            ruleId,
            opts,
        );
        return {
            items: items.map((e) => ({
                id: e.id,
                ruleId: e.ruleId,
                triggerEvent: e.triggerEvent,
                status: e.status,
                triggeredBy: e.triggeredBy,
                durationMs: e.durationMs,
                errorMessage: e.errorMessage,
                outcome: e.outcomeJson,
                triggerPayload: scrubPayload(e.triggerPayloadJson),
                createdAt: e.createdAt,
                completedAt: e.completedAt,
            })),
            nextCursor,
        };
    });
}

/**
 * How long an in-flight execution may run before the monitor calls it stuck,
 * when its rule declares no `slaWindowMinutes` of its own.
 *
 * Rules WITH a window are swept by `sla-monitor` and completed as FAILED once
 * breached, so they self-heal within a sweep cycle. Rules WITHOUT one are never
 * swept at all — their RUNNING rows accumulate indefinitely, which makes them
 * the executions the watchdog most needs to surface. Hence a default rather
 * than skipping them.
 */
export const DEFAULT_STUCK_AFTER_MINUTES = 15;

/**
 * Live monitor feed (Epic 10): STUCK executions + a recent activity tail across
 * all rules, for the operator console.
 *
 * `stuck` is not "everything RUNNING". It used to be — the query had no timeout
 * predicate at all, so the console badged every healthy in-flight execution as
 * stuck and offered to cancel it, contradicting MonitorTab's own docblock
 * promise that the section "only appears when an execution is genuinely hung
 * past its timeout".
 *
 * The deadline is per-execution (`rule.slaWindowMinutes`, else the default), so
 * it cannot be expressed as one SQL predicate. Rows are read oldest-first —
 * stuck executions are by definition the OLD ones, and a newest-first page
 * would hide them behind healthy traffic — then filtered in memory.
 */
/**
 * WHAT THE AGENT NODES ON A CANVAS ARE DOING (#3472, plan point 08).
 *
 * One row per RULE, carrying the latest agentic run that rule firing started.
 *
 * ── WHY THIS JOIN AND NOT ANOTHER ───────────────────────────────────────────
 *
 * A canvas node carries `dataJson.ruleId`, so the chain is
 *
 *     node -> ruleId -> AutomationExecution -> WorkflowRun.parentExecutionId
 *
 * and `parentExecutionId` (#3537) is what makes it EXACT. The join available
 * before that column was `(agentId, workflowKey)` from the rule's action
 * config, and it is not unique: two rules may invoke the same agent on the
 * same workflow, and a person may start the same workflow for the same agent.
 * A canvas built on it would show "runs that look like they came from here",
 * which on a governance surface is worse than showing nothing — so this
 * function did not exist until the column did.
 *
 * ── BOUNDED, AND THE BOUND IS PER RULE ─────────────────────────────────────
 *
 * The executions read is capped, and only the LATEST run per rule survives the
 * grouping. A canvas shows one chassis per node, so a node cannot render a
 * history — and a rule that has fired a thousand times would otherwise drag a
 * thousand runs across the wire to display one.
 *
 * ── THE ACTIVE STEP IS THE LAST RECORDED ONE ───────────────────────────────
 *
 * `WorkflowStep` is append-only and ordered, so the highest `seq` is where the
 * run has got to — there is no "current step" column and inventing one would
 * be a second source of truth for a fact the ledger already carries. For a
 * terminal run the same read gives the step it finished on, which is the right
 * answer to "what did this node last do".
 */
export async function listCanvasAgentRuns(ctx: RequestContext) {
    assertCanReadAutomationHistory(ctx);
    return runInTenantContext(ctx, async (db) => {
        // The rules that can start a run at all. Narrowed here rather than
        // after the join: a tenant's canvas is mostly NOTIFY_USER rules, and
        // reading their executions to discard them would be the bulk of the
        // work.
        const agentRules = await db.automationRule.findMany({
            where: { tenantId: ctx.tenantId, actionType: 'INVOKE_AGENT', deletedAt: null },
            select: { id: true },
            take: 500,
        });
        if (agentRules.length === 0) return { nodes: [] };

        const ruleIds = agentRules.map((r) => r.id);
        const executions = await db.automationExecution.findMany({
            where: { tenantId: ctx.tenantId, ruleId: { in: ruleIds } },
            orderBy: { createdAt: 'desc' },
            take: 500,
            select: { id: true, ruleId: true },
        });
        if (executions.length === 0) return { nodes: [] };

        const ruleByExecution = new Map(executions.map((e) => [e.id, e.ruleId]));
        const runs = await db.workflowRun.findMany({
            where: {
                tenantId: ctx.tenantId,
                parentExecutionId: { in: executions.map((e) => e.id) },
            },
            orderBy: { startedAt: 'desc' },
            take: 500,
            select: {
                id: true, parentExecutionId: true, workflowKey: true, status: true,
                stepCount: true, costTokens: true, startedAt: true,
            },
        });

        // NEWEST PER RULE. `runs` is already newest-first, so the first one
        // seen for a rule is the latest — no comparison, and no dependence on
        // a second sort that could disagree with the first.
        const latestByRule = new Map<string, (typeof runs)[number]>();
        for (const run of runs) {
            const ruleId = run.parentExecutionId
                ? ruleByExecution.get(run.parentExecutionId)
                : undefined;
            if (!ruleId || latestByRule.has(ruleId)) continue;
            latestByRule.set(ruleId, run);
        }
        if (latestByRule.size === 0) return { nodes: [] };

        // The last recorded step of each surviving run, in ONE query rather
        // than one per run: a canvas in Run Mode polls this, so an N+1 here is
        // N+1 every few seconds.
        const steps = await db.workflowStep.findMany({
            where: {
                tenantId: ctx.tenantId,
                runId: { in: [...latestByRule.values()].map((r) => r.id) },
            },
            orderBy: { seq: 'desc' },
            select: { runId: true, seq: true, kind: true, status: true, toolCalled: true },
        });
        const lastStepByRun = new Map<string, (typeof steps)[number]>();
        for (const st of steps) {
            if (!lastStepByRun.has(st.runId)) lastStepByRun.set(st.runId, st);
        }

        return {
            nodes: [...latestByRule.entries()].map(([ruleId, run]) => {
                const step = lastStepByRun.get(run.id);
                return {
                    ruleId,
                    runId: run.id,
                    workflowKey: run.workflowKey,
                    status: run.status,
                    stepCount: run.stepCount,
                    costTokens: run.costTokens,
                    startedAt: run.startedAt,
                    // The step KIND and the tool, never a step's input or
                    // output: those two columns are encrypted at rest because
                    // of what they hold, and a canvas chassis is the last place
                    // tenant content should surface.
                    lastStepSeq: step?.seq ?? null,
                    lastStepKind: step?.kind ?? null,
                    lastStepTool: step?.toolCalled ?? null,
                };
            }),
        };
    });
}

export async function listLiveExecutions(ctx: RequestContext, now = new Date()) {
    assertCanReadAutomationHistory(ctx);
    return runInTenantContext(ctx, async (db) => {
        const [running, recent] = await Promise.all([
            db.automationExecution.findMany({
                where: { tenantId: ctx.tenantId, status: 'RUNNING' },
                orderBy: { createdAt: 'asc' },
                take: 200,
                include: {
                    rule: { select: { name: true, slaWindowMinutes: true } },
                },
            }),
            db.automationExecution.findMany({
                where: { tenantId: ctx.tenantId },
                orderBy: { createdAt: 'desc' },
                take: 50,
                include: { rule: { select: { name: true } } },
            }),
        ]);
        const shape = (e: (typeof recent)[number]) => ({
            id: e.id,
            ruleId: e.ruleId,
            ruleName: e.rule?.name ?? '(deleted rule)',
            triggerEvent: e.triggerEvent,
            status: e.status,
            triggeredBy: e.triggeredBy,
            createdAt: e.createdAt,
        });
        const isStuck = (e: (typeof running)[number]) => {
            const windowMin = e.rule?.slaWindowMinutes ?? DEFAULT_STUCK_AFTER_MINUTES;
            const startedAtMs = (e.startedAt ?? e.createdAt).getTime();
            return now.getTime() >= startedAtMs + windowMin * 60_000;
        };
        return {
            stuck: running.filter(isStuck).map(shape),
            recent: recent.map(shape),
        };
    });
}

/**
 * Operator interrupt (Epic 10): cancel an in-flight execution by marking it
 * SKIPPED. Only PENDING/RUNNING executions can be cancelled.
 */
export async function cancelExecution(ctx: RequestContext, executionId: string) {
    assertCanExecuteAutomation(ctx);
    return runInTenantContext(ctx, async (db) => {
        const exec = await AutomationExecutionRepository.getById(db, ctx, executionId);
        if (!exec) throw notFound('Execution not found');
        if (exec.status !== 'RUNNING' && exec.status !== 'PENDING') {
            throw badRequest('Only in-flight executions can be cancelled');
        }
        return AutomationExecutionRepository.recordCompletion(db, ctx, executionId, {
            status: 'SKIPPED',
            outcome: { cancelled: true, cancelledBy: ctx.userId },
            errorMessage: 'Cancelled by operator',
        });
    });
}

/**
 * Dry run (Epic 10): evaluate a rule's filter against a sample payload
 * WITHOUT creating an execution or firing the action. Returns whether the
 * rule would match. Defaults the sample to the rule's most recent payload.
 */
export async function dryRunRule(
    ctx: RequestContext,
    ruleId: string,
    sampleData?: Record<string, unknown>,
) {
    assertCanExecuteAutomation(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rule = await AutomationRuleRepository.getById(db, ctx, ruleId);
        if (!rule) throw notFound('Automation rule not found');
        const recent = await AutomationExecutionRepository.listForRule(db, ctx, ruleId, 1);
        const data =
            sampleData ?? (recent[0]?.triggerPayloadJson as Record<string, unknown>) ?? {};
        const event = {
            event: rule.triggerEvent,
            tenantId: ctx.tenantId,
            entityType: 'DryRun',
            entityId: ruleId,
            actorUserId: ctx.userId,
            emittedAt: new Date(),
            data,
        };
        // Match on the RAW data, deliberately. `filters.ts` indexes
        // `data[cond.field]` directly and fails closed on undefined, so
        // scrubbing BEFORE this call would flip a `contains` verdict from true
        // to false for any rule filtering on a blocklisted field — silently
        // changing which rules the operator is told would fire.
        const matches = matchesFilter(
            event as never,
            (rule.triggerFilterJson as never) ?? null,
        );

        // Scrub only what LEAVES. The history endpoint already routes the same
        // `triggerPayloadJson` through `scrubPayload`; dry-run returned it raw,
        // so POSTing `{}` here was a one-request bypass of that scrubber.
        //
        // Caller-supplied `sampleData` is passed back untouched — it is the
        // caller's own input, not a stored payload, and redacting it would make
        // the response useless for the thing dry-run exists to do.
        const returned = sampleData ?? scrubPayload(data);
        const redactedFields = Object.keys(returned).filter(
            (k) => returned[k] === '[redacted]',
        );

        return {
            matches,
            sampleData: returned,
            redactedFields,
            triggerEvent: rule.triggerEvent,
        };
    });
}

/**
 * Manual re-trigger of a rule. Validates the rule is ENABLED, replays the
 * most recent execution's payload (so a configured filter behaves as it did
 * originally) through the dispatcher as a `manual` fire targeting just this
 * rule. Returns the enqueued job's correlation handle.
 */
export async function reTriggerRule(ctx: RequestContext, ruleId: string) {
    assertCanExecuteAutomation(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rule = await AutomationRuleRepository.getById(db, ctx, ruleId);
        if (!rule) throw notFound('Automation rule not found');
        if (rule.status !== 'ENABLED') {
            throw badRequest('Only ENABLED rules can be re-triggered');
        }
        const recent = await AutomationExecutionRepository.listForRule(db, ctx, ruleId, 1);
        // PR-E — a re-trigger REPLAYS a prior execution's payload. With no prior
        // execution there's nothing to replay: enqueuing an empty-payload
        // dispatch would silently no-op (no fields for the rule's conditions to
        // match) while reporting success. Report the no-op honestly instead.
        if (recent.length === 0) {
            return {
                enqueued: false as const,
                ruleId,
                reason: 'no_prior_execution' as const,
            };
        }
        // An UPDATE_STATUS rule mutates one entity by `event.entityId`, but a
        // replay carries a synthetic entityId (= ruleId) and the original
        // entityId is never persisted on the execution (only the payload is),
        // so the executor would no-op ("No <entity> matched <ruleId>") while
        // the panel reported "Fired". Refuse honestly rather than enqueue a
        // guaranteed-FAIL execution that pollutes the history + counters.
        if (rule.actionType === 'UPDATE_STATUS') {
            return {
                enqueued: false as const,
                ruleId,
                reason: 'entity_target_not_replayable' as const,
            };
        }
        const data = (recent[0]?.triggerPayloadJson as Record<string, unknown>) ?? {};

        // The random stableKey is DELIBERATE and stays.
        //
        // The audit asked for a "deterministic key" to make replays dedupe.
        // That would be a regression, not a fix: a key derived from the rule
        // makes replay one-shot-forever (the second replay is silently
        // swallowed by automation-event-dispatch and the route still answers
        // 202), and a key derived from the latest execution changes on every
        // replay anyway. The randomness is what makes an intentional replay
        // actually replay — documented at
        // docs/implementation-notes/2026-06-08-automation-epic6-execution-history.md:44-46.
        //
        // The audit also called this endpoint "unrate-limited". It is not:
        // `withApiErrorHandling` applies API_MUTATION_LIMIT (60/min) to POST by
        // default. And CREATE_TASK does NOT amplify — on a replay
        // `event.entityId` is the constant ruleId, so the executor's
        // `auto:${ruleId}:${entityId}` dedupe collides on every replay after
        // the first. The genuinely un-deduped actions are NOTIFY_USER (one
        // Notification row per recipient per replay) and WEBHOOK (one outbound
        // POST per replay), both bounded by the same 60/min limit.
        //
        // What was actually missing is ATTRIBUTION — see the audit event below.
        const stableKey = `manual-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        await enqueue('automation-event-dispatch', {
            tenantId: ctx.tenantId,
            targetRuleId: ruleId,
            triggeredBy: 'manual',
            event: {
                event: rule.triggerEvent,
                tenantId: ctx.tenantId,
                entityType: 'ManualReplay',
                entityId: ruleId,
                actorUserId: ctx.userId,
                // As the bus stamps it (#4386): a replay requested with an API
                // key fires an author-less rule no wider than that key.
                ...(ctx.apiKeyId ? { actorApiKeyId: ctx.apiKeyId } : {}),
                emittedAt: new Date().toISOString(),
                stableKey,
                data,
            },
        });
        // Attribution. `assertCanExecuteAutomation` is the canWrite tier, so an
        // EDITOR can replay a rule an ADMIN configured — firing that ADMIN's
        // webhook or notifications. The execution row records `triggeredBy:
        // 'manual'`, a literal with no actor column, so nothing anywhere named
        // WHO. In a hash-chained GRC product that gap is sharper than the
        // rate-limit concern the finding led with.
        await logEvent(db, ctx, {
            action: 'AUTOMATION_RULE_RETRIGGERED',
            entityType: 'AutomationRule',
            entityId: ruleId,
            details: `Manually replayed rule: ${rule.name}`,
            detailsJson: {
                category: 'custom',
                entityName: 'AutomationRule',
                operation: 'retriggered',
                actionType: rule.actionType,
                triggerEvent: rule.triggerEvent,
                stableKey,
            },
        });

        return { enqueued: true as const, ruleId, stableKey };
    });
}
