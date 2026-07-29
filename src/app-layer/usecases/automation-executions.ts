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
 * Live monitor feed (Epic 10): in-flight (RUNNING) executions + a recent
 * activity tail across all rules, for the operator console.
 */
export async function listLiveExecutions(ctx: RequestContext) {
    assertCanReadAutomationHistory(ctx);
    return runInTenantContext(ctx, async (db) => {
        const [running, recent] = await Promise.all([
            db.automationExecution.findMany({
                where: { tenantId: ctx.tenantId, status: 'RUNNING' },
                orderBy: { createdAt: 'desc' },
                take: 100,
                include: { rule: { select: { name: true } } },
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
        return { running: running.map(shape), recent: recent.map(shape) };
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
