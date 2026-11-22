/**
 * Rule chain dispatch job (Automation Epic 7).
 *
 * Fires the next rule in a chain: creates a linked execution (carrying
 * `parentExecutionId` lineage), records the outcome, and — if that rule
 * itself chains onward — enqueues the next step after its delay.
 *
 * Cycle backstop: `depth` is capped (a rule mis-configured into a loop
 * despite the create-time DFS guard can't run forever). Each link executes its
 * action for real via `executeAction`, consistent with automation-event-dispatch.
 */
import { Prisma } from '@prisma/client';
import { runJob } from '@/lib/observability/job-runner';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import type { JobRunResult, RuleChainDispatchPayload } from './types';
import { executeAction } from '../automation/action-executor';
import { matchesFilter } from '../automation/filters';
import { readRulesWithTenantDek } from '../automation/tenant-dek-read';

const MAX_CHAIN_DEPTH = 10;

/**
 * One chain step per (parent execution, rule) — the job's own identity.
 *
 * The step used to run the action and THEN write its execution, so a BullMQ
 * retry after the action (a crash, a lost ack, a throw in the write) ran the
 * real action a second time: a second task, a second webhook (#5103). The
 * execution is now inserted first under this key, and a retry that finds it
 * taken stops. The trade is the one automation-event-dispatch makes: a step
 * that died between claim and action is left RUNNING for a person to see,
 * rather than run twice.
 */
export function chainStepIdempotencyKey(parentExecutionId: string, ruleId: string): string {
    return `chain:${parentExecutionId}:${ruleId}`;
}

export async function runRuleChainDispatch(
    payload: RuleChainDispatchPayload,
): Promise<{ result: JobRunResult; executionId: string | null }> {
    return runJob('rule-chain-dispatch', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const { tenantId, ruleId, parentExecutionId, triggerEvent, data, depth } = payload;

        let executionId: string | null = null;
        let chained = false;

        if (depth <= MAX_CHAIN_DEPTH) {
            const rule = await readRulesWithTenantDek(tenantId, () =>
                prisma.automationRule.findFirst({
                    where: { id: ruleId, tenantId, status: 'ENABLED', deletedAt: null },
                }),
            );

            if (rule) {
                const actionStart = Date.now();
                // PR-F — the chained rule's own filter is the branch condition.
                // Matches → run the action + follow nextRuleId (pass branch).
                // Doesn't match → skip the action + follow elseRuleId (fail
                // branch). This makes the canvas condition-pass/fail edges real.
                const filterEvent = {
                    event: triggerEvent,
                    tenantId,
                    data,
                } as unknown as Parameters<typeof matchesFilter>[0];
                const matched = matchesFilter(
                    filterEvent,
                    rule.triggerFilterJson as Parameters<typeof matchesFilter>[1],
                );

                // CLAIM before acting (#5103). The insert is the claim: a retry
                // of this same step meets the unique key and stops here.
                let claimedId: string;
                try {
                    const claim = await prisma.automationExecution.create({
                        data: {
                            tenantId,
                            ruleId: rule.id,
                            triggerEvent,
                            triggerPayloadJson: data as never,
                            status: 'RUNNING',
                            triggeredBy: 'chain',
                            parentExecutionId,
                            idempotencyKey: chainStepIdempotencyKey(parentExecutionId, rule.id),
                            startedAt: new Date(),
                        },
                        select: { id: true },
                    });
                    claimedId = claim.id;
                } catch (err) {
                    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                        logger.info('rule-chain-dispatch.already_claimed', {
                            component: 'rule-chain-dispatch',
                            tenantId,
                            ruleId: rule.id,
                            parentExecutionId,
                        });
                        const skipped: JobRunResult = {
                            jobName: 'rule-chain-dispatch',
                            jobRunId: crypto.randomUUID(),
                            success: true,
                            startedAt,
                            completedAt: new Date().toISOString(),
                            durationMs: Math.round(performance.now() - startMs),
                            itemsScanned: 1,
                            itemsActioned: 0,
                            itemsSkipped: 1,
                            details: { ruleId, depth, chained: false, skipped: 'already-claimed' },
                        };
                        return { result: skipped, executionId: null };
                    }
                    throw err;
                }

                const outcome = matched
                    ? await executeAction(prisma, rule, {
                          tenantId,
                          event: triggerEvent,
                          // The entity the chain started from, so an action
                          // that keys on it (CREATE_TASK's dedupe, a webhook's
                          // body) sees the same entity at every link (#5248).
                          entityType: payload.entityType,
                          entityId: payload.entityId,
                          data: { ...data, __parentExecutionId: parentExecutionId },
                          // THIS step's execution, not its parent: a run or a
                          // sub-flow it starts belongs to this rule (#3537).
                          executionId: claimedId,
                      })
                    : { ok: true, summary: 'Condition not met — took the else branch' };

                const status = !matched ? 'SKIPPED' : outcome.ok ? 'SUCCEEDED' : 'FAILED';
                // Settled from RUNNING only, so an operator's cancel stands.
                await prisma.automationExecution.updateMany({
                    where: { id: claimedId, tenantId, status: 'RUNNING' },
                    data: {
                        status,
                        errorMessage: !matched || outcome.ok ? null : outcome.summary,
                        outcomeJson: {
                            actionType: rule.actionType,
                            summary: outcome.summary,
                            chainDepth: depth,
                            branch: matched ? 'pass' : 'else',
                            ...(matched ? outcome.detail ?? {} : {}),
                        },
                        durationMs: Date.now() - actionStart,
                        completedAt: new Date(),
                    },
                });
                const exec = { id: claimedId };
                executionId = exec.id;

                if (matched) {
                    await prisma.automationRule.updateMany({
                        where: { id: rule.id, tenantId },
                        data: { executionCount: { increment: 1 }, lastTriggeredAt: new Date() },
                    });
                }

                // Branch onward: pass → nextRuleId, fail → elseRuleId.
                const branchRuleId = matched ? rule.nextRuleId : rule.elseRuleId;
                if (branchRuleId) {
                    chained = true;
                    const { enqueue } = await import('./queue');
                    await enqueue(
                        'rule-chain-dispatch',
                        {
                            tenantId,
                            ruleId: branchRuleId,
                            parentExecutionId: exec.id,
                            triggerEvent,
                            data,
                            depth: depth + 1,
                            entityType: payload.entityType,
                            entityId: payload.entityId,
                        },
                        matched && rule.nextRuleDelay ? { delay: rule.nextRuleDelay * 60_000 } : undefined,
                    );
                }
            }
        }

        const result: JobRunResult = {
            jobName: 'rule-chain-dispatch',
            jobRunId: crypto.randomUUID(),
            success: true,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startMs),
            itemsScanned: 1,
            itemsActioned: executionId ? 1 : 0,
            itemsSkipped: executionId ? 0 : 1,
            details: { ruleId, depth, chained, capped: depth > MAX_CHAIN_DEPTH },
        };
        return { result, executionId };
    });
}
