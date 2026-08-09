/**
 * Automation Event Dispatch Job
 *
 * One job invocation per emitted domain event. Called by the BullMQ
 * worker via the executor registry. Responsibilities:
 *
 *   1. Load enabled `AutomationRule`s for the event's tenantId +
 *      triggerEvent, in priority order.
 *   2. Evaluate each rule's `triggerFilterJson` against the event
 *      payload via `matchesFilter()`. Non-matching rules are skipped
 *      without persisting an execution row.
 *   3. For each matching rule, insert a PENDING `AutomationExecution`
 *      row. The unique (tenantId, idempotencyKey) index is the
 *      dedupe lock — concurrent workers colliding on the same
 *      stableKey both try to insert, the loser catches Prisma
 *      P2002 and skips (not an error).
 *   4. Advance the claimed execution row through RUNNING →
 *      SUCCEEDED / FAILED. Action handlers are out of scope for
 *      Epic 60 foundation; we record the would-have-fired action
 *      type in `outcomeJson` so the next epic can plug handlers in.
 *   5. Bump the rule's `executionCount` + `lastTriggeredAt`.
 *
 * Not in scope (handled by later epics):
 *   - The rule-action executor (CREATE_TASK, NOTIFY_USER, WEBHOOK…).
 *   - Rule evaluation DSL beyond equality-filter.
 *   - Cross-rule fan-out deduping beyond the per-rule idempotency key.
 *
 * @module jobs/automation-event-dispatch
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { runJob } from '@/lib/observability/job-runner';
import { matchesFilter } from '../automation/filters';
import { executeAction } from '../automation/action-executor';
import type {
    AutomationDomainEvent,
    AutomationEventMetadata,
} from '../automation/event-contracts';
import type { AutomationTriggerFilter } from '../automation/types';
import type { AutomationEventDispatchPayload } from './types';
import { readRulesWithTenantDek } from '../automation/tenant-dek-read';

export interface AutomationEventDispatchResult {
    tenantId: string;
    event: string;
    rulesConsidered: number;
    rulesMatched: number;
    executionsCreated: number;
    executionsSkippedDuplicate: number;
    executionsSkippedFilter: number;
    executionsFailed: number;
    jobRunId: string;
}

/**
 * Rebuild a typed `AutomationDomainEvent` from the serialized job
 * payload. BullMQ round-trips JSON so `emittedAt` comes back as
 * string — rehydrate to Date here, not inside match/filter code.
 */
function rehydrateEvent(
    serialized: AutomationEventDispatchPayload['event']
): AutomationDomainEvent {
    return {
        event: serialized.event,
        tenantId: serialized.tenantId,
        entityType: serialized.entityType,
        entityId: serialized.entityId,
        actorUserId: serialized.actorUserId,
        emittedAt: new Date(serialized.emittedAt),
        stableKey: serialized.stableKey,
        data: serialized.data,
    } as AutomationDomainEvent;
}

/**
 * Compute the execution idempotency key for a (rule, event) pair.
 * Returns null if the producer didn't supply a stableKey — in that
 * case the dispatcher accepts that a retried producer may double-fire,
 * which is a known tradeoff for event sources that can't dedupe.
 */
function computeIdempotencyKey(
    ruleId: string,
    event: AutomationEventMetadata & { event: string }
): string | null {
    if (!event.stableKey) return null;
    return `${ruleId}:${event.event}:${event.stableKey}`;
}

/**
 * Detect Prisma's unique-constraint violation without importing the
 * full `Prisma.PrismaClientKnownRequestError` at the call site.
 */
function isUniqueViolation(err: unknown): boolean {
    return (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
    );
}

/**
 * Main entry point — called by the BullMQ executor for
 * 'automation-event-dispatch'.
 */
export async function runAutomationEventDispatch(
    payload: AutomationEventDispatchPayload
): Promise<AutomationEventDispatchResult> {
    return runJob(
        'automation-event-dispatch',
        async () => {
            const jobRunId = crypto.randomUUID();
            const event = rehydrateEvent(payload.event);

            // Sanity: the payload carries tenantId twice (top-level for
            // queue indexing + inside the event). They must match;
            // a mismatch is a producer bug we want loud.
            if (payload.tenantId !== event.tenantId) {
                logger.error('automation-dispatch.tenantId_mismatch', {
                    component: 'automation-event-dispatch',
                    payloadTenantId: payload.tenantId,
                    eventTenantId: event.tenantId,
                    event: event.event,
                });
                throw new Error(
                    `tenantId mismatch in automation-event-dispatch payload: ` +
                        `payload.tenantId=${payload.tenantId}, event.tenantId=${event.tenantId}`
                );
            }

            // 1. Load matching enabled rules. Epic 6 — a manual re-trigger
            //    targets ONE rule via payload.targetRuleId.
            const rules = await readRulesWithTenantDek(event.tenantId, () =>
                prisma.automationRule.findMany({
                    where: {
                        tenantId: event.tenantId,
                        triggerEvent: event.event,
                        status: 'ENABLED',
                        deletedAt: null,
                        ...(payload.targetRuleId ? { id: payload.targetRuleId } : {}),
                    },
                    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
                }),
            );

            const result: AutomationEventDispatchResult = {
                tenantId: event.tenantId,
                event: event.event,
                rulesConsidered: rules.length,
                rulesMatched: 0,
                executionsCreated: 0,
                executionsSkippedDuplicate: 0,
                executionsSkippedFilter: 0,
                executionsFailed: 0,
                jobRunId,
            };

            for (const rule of rules) {
                // 2. Filter check — if the rule has a filter and it
                //    doesn't match, don't even create an execution row.
                const filter = rule.triggerFilterJson as
                    | AutomationTriggerFilter
                    | null;
                if (!matchesFilter(event, filter)) {
                    result.executionsSkippedFilter++;
                    continue;
                }
                result.rulesMatched++;

                const idempotencyKey = computeIdempotencyKey(rule.id, event);

                // 3. Insert-to-claim. Competing workers both try; the
                //    loser hits P2002 and backs off silently.
                let executionId: string;
                try {
                    const created = await prisma.automationExecution.create({
                        data: {
                            tenantId: event.tenantId,
                            ruleId: rule.id,
                            triggerEvent: event.event,
                            triggerPayloadJson:
                                event.data as Prisma.InputJsonValue,
                            status: 'PENDING',
                            idempotencyKey,
                            triggeredBy: payload.triggeredBy ?? 'event',
                            jobRunId,
                            startedAt: new Date(),
                        },
                    });
                    executionId = created.id;
                    result.executionsCreated++;
                } catch (err) {
                    if (isUniqueViolation(err)) {
                        // Another runner beat us to this (ruleId,
                        // event, stableKey). Correct behaviour is silent.
                        result.executionsSkippedDuplicate++;
                        continue;
                    }
                    result.executionsFailed++;
                    logger.error('automation-dispatch.claim_failed', {
                        component: 'automation-event-dispatch',
                        ruleId: rule.id,
                        event: event.event,
                        err: err instanceof Error ? err : new Error(String(err)),
                    });
                    continue;
                }

                // 4. Claim the row: PENDING → RUNNING. The status predicate
                //    prevents a double-advance if two workers somehow held the
                //    same row — AND is now load-bearing for cancellation.
                //
                //    A cancel writes SKIPPED. If it landed before this claim,
                //    the predicate does not match and `count` is 0, so the
                //    action must NOT run. Previously the result was discarded
                //    and the action fired anyway: an operator who cancelled a
                //    queued execution still got the webhook.
                const claimed = await prisma.automationExecution.updateMany({
                    where: {
                        id: executionId,
                        tenantId: event.tenantId,
                        status: 'PENDING',
                    },
                    data: { status: 'RUNNING' },
                });
                if (claimed.count === 0) {
                    logger.info('automation-dispatch.not_claimed', {
                        component: 'automation-event-dispatch',
                        ruleId: rule.id,
                        executionId,
                        event: event.event,
                        reason: 'cancelled_or_already_claimed',
                    });
                    continue;
                }

                const startedAt = Date.now();
                try {
                    // Execute the rule's action for real. The row stays RUNNING
                    // for the duration of the action (so a slow WEBHOOK is
                    // observable by the SLA sweep); the result settles it
                    // SUCCEEDED or FAILED.
                    const outcome = await executeAction(prisma, rule, {
                        tenantId: event.tenantId,
                        event: event.event,
                        entityType: event.entityType,
                        entityId: event.entityId,
                        actorUserId: event.actorUserId,
                        data: event.data as Record<string, unknown> | undefined,
                    });
                    // `updateMany` scoped to status RUNNING, not `update` by id.
                    //
                    // An unconditional write here is what made Cancel cosmetic:
                    // the operator marked the row SKIPPED, the action returned
                    // moments later, and the dispatcher overwrote it with
                    // SUCCEEDED — so the UI reported a cancellation that left
                    // no trace. An in-flight action cannot be recalled, but the
                    // RECORD of it must not lie.
                    const settled = await prisma.automationExecution.updateMany({
                        where: {
                            id: executionId,
                            tenantId: event.tenantId,
                            status: 'RUNNING',
                        },
                        data: {
                            status: outcome.ok ? 'SUCCEEDED' : 'FAILED',
                            outcomeJson: {
                                actionType: rule.actionType,
                                summary: outcome.summary,
                                ...(outcome.detail ?? {}),
                            },
                            errorMessage: outcome.ok ? null : outcome.summary,
                            durationMs: Date.now() - startedAt,
                            completedAt: new Date(),
                        },
                    });
                    const cancelledMidFlight = settled.count === 0;
                    if (cancelledMidFlight) {
                        logger.info('automation-dispatch.cancelled_mid_flight', {
                            component: 'automation-event-dispatch',
                            ruleId: rule.id,
                            executionId,
                            event: event.event,
                        });
                    }
                    if (!outcome.ok && !cancelledMidFlight) result.executionsFailed++;

                    // 5. Counter bump on the rule — non-audit,
                    //    dispatcher-only mutation.
                    await prisma.automationRule.updateMany({
                        where: { id: rule.id, tenantId: event.tenantId },
                        data: {
                            executionCount: { increment: 1 },
                            lastTriggeredAt: new Date(),
                        },
                    });

                    // 6. Chained workflow (Epic 7) — if this rule chains to
                    //    a next rule, enqueue it (optionally delayed),
                    //    carrying the payload + lineage. The chain job has
                    //    its own depth-cap cycle backstop.
                    // A cancel cannot recall the action already in flight, but
                    // it CAN stop everything downstream — which is the part of
                    // "cancel" an operator can still be given honestly.
                    if (rule.nextRuleId && !cancelledMidFlight) {
                        const { enqueue } = await import('./queue');
                        await enqueue(
                            'rule-chain-dispatch',
                            {
                                tenantId: event.tenantId,
                                ruleId: rule.nextRuleId,
                                parentExecutionId: executionId,
                                triggerEvent: event.event,
                                data: event.data as Record<string, unknown>,
                                depth: 1,
                            },
                            rule.nextRuleDelay
                                ? { delay: rule.nextRuleDelay * 60_000 }
                                : undefined,
                        );
                    }
                } catch (err) {
                    result.executionsFailed++;
                    const msg = err instanceof Error ? err.message : String(err);
                    const stack = err instanceof Error ? err.stack ?? null : null;

                    // Same RUNNING predicate as the success path — a throw
                    // must not overwrite an operator's cancellation either.
                    await prisma.automationExecution.updateMany({
                        where: {
                            id: executionId,
                            tenantId: event.tenantId,
                            status: 'RUNNING',
                        },
                        data: {
                            status: 'FAILED',
                            errorMessage: msg,
                            errorStack: stack,
                            durationMs: Date.now() - startedAt,
                            completedAt: new Date(),
                        },
                    });

                    logger.error('automation-dispatch.action_failed', {
                        component: 'automation-event-dispatch',
                        ruleId: rule.id,
                        executionId,
                        event: event.event,
                        err: err instanceof Error ? err : new Error(String(err)),
                    });
                }
            }

            logger.info('automation-dispatch.complete', {
                component: 'automation-event-dispatch',
                ...result,
            });

            return result;
        },
        { tenantId: payload.tenantId }
    );
}
