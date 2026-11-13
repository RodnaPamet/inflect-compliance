/**
 * Sub-flow dispatch job (Visual Rule Editor VR-7).
 *
 * When a rule's action is INVOKE_SUBFLOW, this resolves the target sub-flow
 * group's entry rule (the first ENABLED rule carrying `subFlowGroupId ===
 * targetGroupId`) and runs it as a child execution linked to the invoking
 * execution via `parentExecutionId` — so a sub-flow's runs roll up to their
 * caller in the execution history + governance graph.
 *
 * The entry rule's action executes for real via `executeAction`, consistent
 * with automation-event-dispatch + rule-chain-dispatch.
 */
import { Prisma } from '@prisma/client';
import { runJob } from '@/lib/observability/job-runner';
import { prisma } from '@/lib/prisma';
import type { JobRunResult, SubflowDispatchPayload } from './types';
import { executeAction } from '../automation/action-executor';
import { logger } from '@/lib/observability/logger';
import { readRulesWithTenantDek } from '../automation/tenant-dek-read';

/**
 * Recursion cap, mirroring `MAX_CHAIN_DEPTH` in rule-chain-dispatch.
 *
 * A sub-flow whose entry rule's action is INVOKE_SUBFLOW pointing back at its
 * own group recursed forever: this dispatcher had no cap, and `targetGroupId`
 * is a free-form string with no existence or self-reference validation. The
 * chain dispatcher has been capped since Epic 7; this one was simply missed.
 */
const MAX_SUBFLOW_DEPTH = 10;

/**
 * One sub-flow run per (invoking execution, group) — the job's identity
 * (#5103). The dispatcher ran the entry rule's action and THEN wrote the
 * execution, so a BullMQ retry ran the real action twice. The row is now
 * inserted first under this key. Null when the invocation names no parent: a
 * key on an empty parent would make every top-level invocation of a group
 * collide, and the unique index admits any number of nulls.
 */
export function subflowIdempotencyKey(parentExecutionId: string, targetGroupId: string): string | null {
    return parentExecutionId ? `subflow:${parentExecutionId}:${targetGroupId}` : null;
}

export async function runSubflowDispatch(
    payload: SubflowDispatchPayload,
): Promise<{ result: JobRunResult; executionId: string | null }> {
    return runJob('subflow-dispatch', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const { tenantId, targetGroupId, parentExecutionId, triggerEvent, data } = payload;
        const depth = payload.depth ?? 1;

        if (depth > MAX_SUBFLOW_DEPTH) {
            // Refuse rather than throw: a runaway sub-flow is a misconfigured
            // rule, not an infrastructure fault, and throwing would put the job
            // into retry — turning one bad rule into sustained queue pressure.
            logger.warn('subflow-dispatch: recursion cap reached, refusing to descend', {
                component: 'subflow-dispatcher',
                tenantId,
                targetGroupId,
                depth,
                maxDepth: MAX_SUBFLOW_DEPTH,
            });
            const capped: JobRunResult = {
                jobName: 'subflow-dispatch',
                jobRunId: crypto.randomUUID(),
                success: true,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs: Math.round(performance.now() - startMs),
                itemsScanned: 1,
                itemsActioned: 0,
                itemsSkipped: 1,
                details: { targetGroupId, dispatched: false, skipped: 'max-subflow-depth', depth },
            };
            return { result: capped, executionId: null };
        }

        // Entry rule = the first ENABLED rule in the target group. A group's
        // trigger node owns this rule (priority breaks ties deterministically).
        const entry = await readRulesWithTenantDek(tenantId, () =>
            prisma.automationRule.findFirst({
                where: {
                    tenantId,
                    subFlowGroupId: targetGroupId,
                    status: 'ENABLED',
                    deletedAt: null,
                },
                orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
            }),
        );

        let executionId: string | null = null;
        let alreadyClaimed = false;
        if (entry) {
            const actionStart = Date.now();
            // CLAIM before acting (#5103): a retry of this job meets the
            // unique key and stops before the action.
            try {
                const claim = await prisma.automationExecution.create({
                    data: {
                        tenantId,
                        ruleId: entry.id,
                        triggerEvent,
                        triggerPayloadJson: data as never,
                        status: 'RUNNING',
                        triggeredBy: 'subflow',
                        parentExecutionId,
                        idempotencyKey: subflowIdempotencyKey(parentExecutionId, targetGroupId),
                        startedAt: new Date(),
                    },
                    select: { id: true },
                });
                executionId = claim.id;
            } catch (err) {
                if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
                alreadyClaimed = true;
                logger.info('subflow-dispatch: already claimed, not running the action again', {
                    component: 'subflow-dispatcher',
                    tenantId,
                    targetGroupId,
                    parentExecutionId,
                });
            }

            if (executionId) {
                const outcome = await executeAction(prisma, entry, {
                    tenantId,
                    event: triggerEvent,
                    entityType: payload.entityType,
                    entityId: payload.entityId,
                    // `__subflowDepth` rides `data` alongside the existing
                    // `__parentExecutionId` marker — same convention. It is read
                    // back by `invokeSubflow` so a nested INVOKE_SUBFLOW enqueues
                    // depth+1. Without this the cap below would never be reached
                    // and the guard would be decorative.
                    data: { ...data, __parentExecutionId: parentExecutionId, __subflowDepth: depth },
                });
                // Settled from RUNNING only, so an operator's cancel stands.
                await prisma.automationExecution.updateMany({
                    where: { id: executionId, tenantId, status: 'RUNNING' },
                    data: {
                        status: outcome.ok ? 'SUCCEEDED' : 'FAILED',
                        errorMessage: outcome.ok ? null : outcome.summary,
                        outcomeJson: {
                            actionType: entry.actionType,
                            summary: outcome.summary,
                            subFlowGroupId: targetGroupId,
                            ...(outcome.detail ?? {}),
                        },
                        durationMs: Date.now() - actionStart,
                        completedAt: new Date(),
                    },
                });
                await prisma.automationRule.updateMany({
                    where: { id: entry.id, tenantId },
                    data: { executionCount: { increment: 1 }, lastTriggeredAt: new Date() },
                });
            }
        }

        const result: JobRunResult = {
            jobName: 'subflow-dispatch',
            jobRunId: crypto.randomUUID(),
            success: true,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startMs),
            itemsScanned: 1,
            itemsActioned: executionId ? 1 : 0,
            itemsSkipped: executionId ? 0 : 1,
            details: {
                targetGroupId,
                dispatched: executionId !== null,
                ...(alreadyClaimed ? { skipped: 'already-claimed' } : {}),
            },
        };
        return { result, executionId };
    });
}
