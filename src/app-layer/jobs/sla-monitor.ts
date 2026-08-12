/**
 * Execution watchdog job (Automation Epic 5 — "SLA window").
 *
 * IMPORTANT — what this actually watches: it scans RUNNING automation
 * executions whose parent rule declares an `slaWindowMinutes` and whose start
 * is older than that window. Because `automation-event-dispatch` runs each
 * action synchronously and settles the execution row (SUCCEEDED/FAILED)
 * immediately, a row only stays RUNNING while its action is genuinely
 * in-flight. So in practice this catches STUCK / hung executions (an
 * unresponsive webhook, a worker that died mid-run) — it is an execution
 * watchdog, NOT a business-entity SLA ("this task must be done in 3 days").
 * The builder copy is worded accordingly so users aren't misled. A true
 * entity-deadline SLA would need a separate mechanism that tracks the target
 * entity's own due date, not the execution's runtime.
 *
 * Each breached (stuck) execution is completed as FAILED with an `slaBreached`
 * outcome, an audit event is written, and the configured breach action is
 * executed (NOTIFY_USER wired here; see the breach-action handling below).
 * Runs every 5 minutes (see schedules.ts).
 */
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { withTenantDb } from '@/lib/db-context';
import { AutomationExecutionRepository } from '../automation';
import { logEvent } from '../events/audit';
import type { RequestContext } from '../types';
import { buildSystemContext } from '../context';
import type { JobRunResult } from './types';

function makeSystemCtx(tenantId: string): RequestContext {
    return buildSystemContext({ tenantId, job: 'sla-monitor', discriminator: String(Date.now()) });
}

export async function runSlaMonitorJob(options?: {
    tenantId?: string;
    now?: Date;
}): Promise<{ result: JobRunResult; breachedCount: number }> {
    return runJob('sla-monitor', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const now = options?.now ?? new Date();

        const tenants = options?.tenantId
            ? [{ id: options.tenantId }]
            // Soft-deleted tenants were swept too — pure waste every 5 minutes,
            // and it kept dead tenants' rules alive in the breach path.
            : await prisma.tenant.findMany({
                  where: { deletedAt: null },
                  select: { id: true },
              });

        let breached = 0;
        let errored = 0;

        for (const tenant of tenants) {
            try {
                breached += await sweepTenant(tenant.id, now);
            } catch (err) {
                errored++;
                logger.error('SLA monitor failed for tenant', {
                    component: 'sla-monitor',
                    tenantId: tenant.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        const result: JobRunResult = {
            jobName: 'sla-monitor',
            jobRunId: crypto.randomUUID(),
            success: errored === 0,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startMs),
            itemsScanned: tenants.length,
            itemsActioned: breached,
            itemsSkipped: errored,
            details: { breached, errored },
        };
        return { result, breachedCount: breached };
    });
}

/** Returns the number of breached executions actioned for one tenant. */
export async function sweepTenant(tenantId: string, now: Date): Promise<number> {
    const ctx = makeSystemCtx(tenantId);
    return withTenantDb(tenantId, async (db) => {
        // RUNNING executions whose rule has an SLA window set.
        const running = await db.automationExecution.findMany({
            where: { tenantId, status: 'RUNNING', rule: { slaWindowMinutes: { not: null } } },
            include: { rule: true },
            take: 500,
        });

        // Resolve the tenant's ACTIVE members ONCE for the whole sweep.
        //
        // Recipients must be membership-checked — Notification.userId is a real
        // FK and this whole loop runs in ONE transaction, so a single stale id
        // rolled back every recordCompletion for the tenant, every five
        // minutes, forever. Doing that check per execution would be an N+1 over
        // the breach list; the tenant is fixed here, so one query covers it.
        const activeMembers = await db.tenantMembership.findMany({
            where: { tenantId, status: 'ACTIVE' },
            select: { userId: true },
        });
        const activeMemberIds = new Set(
            activeMembers.map((m: { userId: string }) => m.userId),
        );

        let count = 0;
        for (const exec of running) {
            const windowMin = exec.rule.slaWindowMinutes;
            if (!windowMin) continue;
            const startedAtMs = (exec.startedAt ?? exec.createdAt).getTime();
            const deadline = startedAtMs + windowMin * 60_000;
            if (now.getTime() < deadline) continue; // not breached yet

            await AutomationExecutionRepository.recordCompletion(db, ctx, exec.id, {
                status: 'FAILED',
                outcome: {
                    slaBreached: true,
                    breachedAt: now.toISOString(),
                    slaWindowMinutes: windowMin,
                    breachAction: exec.rule.slaBreachActionType ?? null,
                },
                errorMessage: `SLA window of ${windowMin}m breached`,
            });

            await logEvent(db, ctx, {
                action: 'AUTOMATION_SLA_BREACHED',
                entityType: 'AutomationExecution',
                entityId: exec.id,
                detailsJson: {
                    ruleId: exec.ruleId,
                    slaWindowMinutes: windowMin,
                    breachAction: exec.rule.slaBreachActionType ?? null,
                },
            });

            // Any breach action OTHER than NOTIFY_USER — including WEBHOOK —
            // was silently ignored: the row was marked breached and nothing
            // happened. An operator configuring a WEBHOOK escalation got no
            // error, no log, and no delivery. Surfacing it as a warning is the
            // honest interim: wiring the full action executor here is a larger
            // change (it would need the tenant execution context the breach
            // path does not currently build), and shipping a half-wired
            // executor is worse than a loud gap.
            if (
                exec.rule.slaBreachActionType &&
                exec.rule.slaBreachActionType !== 'NOTIFY_USER'
            ) {
                logger.warn('SLA breach action is not supported and was NOT executed', {
                    component: 'sla-monitor',
                    tenantId,
                    ruleId: exec.rule.id,
                    breachAction: exec.rule.slaBreachActionType,
                });
            }

            // NOTIFY_USER breach action — create notifications for recipients.
            if (exec.rule.slaBreachActionType === 'NOTIFY_USER' && exec.rule.slaBreachConfigJson) {
                const cfg = exec.rule.slaBreachConfigJson as { userIds?: string[]; message?: string };
                const requested = Array.isArray(cfg.userIds) ? cfg.userIds : [];
                // Membership-check the recipients, exactly as the executor's
                // notifyUser does (action-executor.ts:135-139). This path did
                // not, and `Notification.userId` is a REAL foreign key — so a
                // single stale or foreign id raised an FK violation. Because
                // `sweepTenant` wraps the whole loop in ONE transaction, that
                // rolled back every `recordCompletion` for the tenant, and did
                // so again every five minutes, forever. The unchecked insert
                // was not just a tenant-isolation gap; it was a permanent
                // poison pill for the tenant's entire SLA sweep.
                // Membership set is resolved ONCE per tenant above, not per
                // execution — the tenant is fixed for the whole sweep, so a
                // per-iteration query would be an N+1 over the breach list.
                const userIds = requested.filter((u) => activeMemberIds.has(u));
                if (userIds.length > 0) {
                    await db.notification.createMany({
                        data: userIds.map((userId) => ({
                            tenantId,
                            userId,
                            type: 'GENERAL' as const,
                            title: 'Automation SLA breached',
                            message:
                                cfg.message ??
                                `An automation rule's ${windowMin}m SLA window was breached.`,
                        })),
                    });
                }
            }
            count++;
        }
        return count;
    });
}
