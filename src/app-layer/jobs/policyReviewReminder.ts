/**
 * Policy Review Reminder Job Stub
 *
 * This module provides functions to find overdue policies and process review reminders.
 * It is designed to be called from a cron job or scheduler.
 *
 * TENANT ISOLATION: When `tenantId` is provided, all queries are scoped
 * to that single tenant. The system-wide scan (no tenantId) is only used
 * by the scheduled global cron and is clearly separated.
 *
 * ## How to hook into cron:
 *
 * ### Option 1: Vercel Cron (recommended for serverless)
 * Create a route at `src/app/api/cron/policy-review/route.ts`:
 * - Verify the Authorization header matches your CRON_SECRET env var
 * - Call `processOverdueReminders(getDbClient())`
 * - Add to vercel.json: `{ "crons": [{ "path": "/api/cron/policy-review", "schedule": "0 8 * * *" }] }`
 *
 * ### Option 2: node-cron (for self-hosted)
 * - Import this module and `getDbClient` from `@/lib/db-context`
 * - Schedule with: `cron.schedule('0 8 * * *', () => processOverdueReminders(getDbClient()))`
 */

import type { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '@/lib/observability/logger';
import { emitAutomationEvent } from '../automation';
import { isNotificationsEnabled } from '../notifications/settings';
import { TERMINAL_TASK_STATUSES } from '../domain/task-status';
import { createTask, addTaskLink } from '../usecases/task';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '../types';

/**
 * System context for a policy-review reminder task, owned by the policy
 * owner (the reminder is only raised when an owner exists). ADMIN
 * permissions clear `assertCanWriteTasks`; the canonical createTask then
 * mints the TSK-N key + audit + automation event + owner bell/email.
 */
function buildReminderCtx(tenantId: string, ownerUserId: string): RequestContext {
    return {
        requestId: `policy-review-reminder-${tenantId}`,
        userId: ownerUserId,
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: false },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

export interface OverduePolicy {
    id: string;
    tenantId: string;
    title: string;
    slug: string;
    nextReviewAt: Date;
    daysOverdue: number;
    ownerUserId: string | null;
}

export interface PolicyReminderOptions {
    /** When provided, scope ALL queries to this tenant only. */
    tenantId?: string;
}

/**
 * Determine if a policy is overdue based on its nextReviewAt date.
 * Pure function, suitable for unit testing.
 */
export function isPolicyOverdue(nextReviewAt: Date | null | undefined, now: Date = new Date()): boolean {
    if (!nextReviewAt) return false;
    return nextReviewAt < now;
}

/**
 * Calculate days overdue. Returns 0 if not overdue.
 */
export function daysOverdue(nextReviewAt: Date | null | undefined, now: Date = new Date()): number {
    if (!nextReviewAt || nextReviewAt >= now) return 0;
    const diff = now.getTime() - nextReviewAt.getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/**
 * Find policies that are overdue for review.
 *
 * @param db        PrismaClient instance (dependency injection for testability)
 * @param options   If tenantId is provided, only scan that tenant's policies.
 *                  If omitted, scans all tenants (system-wide mode).
 */
export async function findOverduePolicies(
    db: PrismaClient,
    options: PolicyReminderOptions = {},
): Promise<OverduePolicy[]> {
    const now = new Date();
    const { tenantId } = options;
    const scope = tenantId ? 'tenant-scoped' : 'system-wide';

    logger.info('policy review scan starting', {
        component: 'policy-review-reminder',
        scope,
        ...(tenantId ? { tenantId } : {}),
    });

    const where: Prisma.PolicyWhereInput = {
        nextReviewAt: { lt: now },
        status: { not: 'ARCHIVED' },
    };
    if (tenantId) where.tenantId = tenantId;

    const policies = await db.policy.findMany({
        where,
        select: {
            id: true,
            tenantId: true,
            title: true,
            slug: true,
            nextReviewAt: true,
            ownerUserId: true,
        },
    });

    const results = policies
        .filter(p => p.nextReviewAt !== null)
        .map(p => ({
            ...p,
            nextReviewAt: p.nextReviewAt!,
            daysOverdue: daysOverdue(p.nextReviewAt, now),
        }));

    logger.info('policy review scan completed', {
        component: 'policy-review-reminder',
        scope,
        ...(tenantId ? { tenantId } : {}),
        total: results.length,
    });

    return results;
}

/**
 * Upper bound (days) on the pre-filter scan window. The per-policy
 * reminder window is the tenant's `reminderDaysBefore`; this caps the
 * query so the scan stays bounded regardless of tenant config.
 */
const MAX_REVIEW_WINDOW_DAYS = 60;
const DEFAULT_REMINDER_DAYS_BEFORE = 14;

/**
 * Process policy review reminders.
 *
 * Finds policies due for review within the tenant's reminder window
 * (`Tenant.reminderDaysBefore`) OR already overdue, and for each:
 *   - writes an immutable `POLICY_REVIEW_OVERDUE` audit row (overdue only),
 *   - emits the `POLICY_REVIEW_DUE` automation event (overdue + due-soon),
 *   - enqueues a notification to the policy owner (deduped per day).
 * On review, `markPolicyReviewed` advances `nextReviewAt`, closing the loop.
 *
 * @param db        PrismaClient instance (dependency injection)
 * @param options   If tenantId is provided, only process that tenant's policies.
 */
export async function processOverdueReminders(
    db: PrismaClient,
    options: PolicyReminderOptions = {},
): Promise<{
    processed: number;
    policies: Array<{ id: string; tenantId: string; title: string; daysOverdue: number }>;
}> {
    const now = new Date();
    const { tenantId } = options;
    const horizon = new Date(now.getTime() + MAX_REVIEW_WINDOW_DAYS * 86_400_000);

    const where: Prisma.PolicyWhereInput = {
        nextReviewAt: { not: null, lte: horizon },
        status: { not: 'ARCHIVED' },
    };
    if (tenantId) where.tenantId = tenantId;

    const policies = await db.policy.findMany({
        where,
        select: {
            id: true,
            tenantId: true,
            title: true,
            slug: true,
            nextReviewAt: true,
            ownerUserId: true,
            owner: { select: { email: true } },
            tenant: { select: { reminderDaysBefore: true } },
        },
        take: 1000,
    });

    const out: Array<{ id: string; tenantId: string; title: string; daysOverdue: number }> = [];
    // Per-tenant notification-eligibility cache — avoids re-querying
    // tenantNotificationSettings for every policy of the same tenant.
    const notifEnabled = new Map<string, boolean>();

    // TP-5 — the review-due signal now materialises as a real Task in the
    // universal /tasks inbox. Idempotency is per open review cycle: a set
    // of policy ids that already carry an OPEN `POLICY_REVIEW` task,
    // resolved in ONE batched query over the scanned policy set (no N+1 in
    // the loop below). A fresh cycle after `markPolicyReviewed` advances
    // `nextReviewAt`, so once the prior task closes a new one may be raised.
    const policyIds = policies.map((p) => p.id);
    const policiesWithOpenTask = new Set<string>();
    if (policyIds.length) {
        const openLinks = await db.taskLink.findMany({ // guardrail-allow: unbounded -- bounded by the scanned policyIds in: list (take:1000)
            where: {
                entityType: 'POLICY',
                entityId: { in: policyIds },
                task: {
                    source: 'POLICY_REVIEW',
                    status: { notIn: [...TERMINAL_TASK_STATUSES] },
                },
            },
            select: { entityId: true },
        });
        for (const l of openLinks) policiesWithOpenTask.add(l.entityId);
    }

    for (const policy of policies) {
        if (!policy.nextReviewAt) continue;
        const reminderDays = policy.tenant?.reminderDaysBefore ?? DEFAULT_REMINDER_DAYS_BEFORE;
        const dueThreshold = new Date(now.getTime() + reminderDays * 86_400_000);
        // Skip policies not yet inside their reminder window.
        if (policy.nextReviewAt > dueThreshold) continue;

        const overdue = policy.nextReviewAt < now;
        const dOver = daysOverdue(policy.nextReviewAt, now);

        // Immutable audit — overdue only (matches the prior contract).
        if (overdue) {
            await db.auditLog.create({
                data: {
                    tenantId: policy.tenantId,
                    userId: null,
                    action: 'POLICY_REVIEW_OVERDUE',
                    entity: 'Policy',
                    entityId: policy.id,
                    details: `Policy "${policy.title}" is ${dOver} day(s) overdue for review.`,
                },
            });
        }

        // Domain-emit — surface policy-governance deadlines to automation.
        // Best-effort; the system job carries no user actor.
        await emitAutomationEvent(
            { tenantId: policy.tenantId, userId: null } as unknown as RequestContext,
            {
                event: 'POLICY_REVIEW_DUE',
                entityType: 'Policy',
                entityId: policy.id,
                actorUserId: null,
                data: {
                    title: policy.title,
                    nextReviewAt: policy.nextReviewAt.toISOString(),
                    daysOverdue: dOver,
                },
            },
        ).catch(() => {});

        // Notify the policy owner (deduped per day). Skipped when the owner
        // has no resolvable email — the audit + automation + detail-page
        // overdue flag still surface the deadline.
        const ownerEmail = policy.owner?.email;
        if (ownerEmail && db.notificationOutbox?.create) {
            // Respect the tenant's notification eligibility (single source of
            // truth — settings.ts), cached per tenant for this run.
            let enabled = notifEnabled.get(policy.tenantId);
            if (enabled === undefined) {
                enabled = await isNotificationsEnabled(db, policy.tenantId).catch(() => false);
                notifEnabled.set(policy.tenantId, enabled);
            }
            const dueStr = policy.nextReviewAt.toISOString().slice(0, 10);
            if (enabled) await db.notificationOutbox.create({
                data: {
                    tenantId: policy.tenantId,
                    type: 'POLICY_REVIEW_DUE',
                    toEmail: ownerEmail,
                    subject: `${overdue ? '⚠️ ' : ''}Policy ${overdue ? 'overdue for' : 'due for'} review: ${policy.title}`,
                    bodyText: `Policy "${policy.title}" is ${overdue ? `${dOver} day(s) overdue for review` : `due for review on ${dueStr}`}. Open it in Inflect, review the content, and mark it reviewed to reset the review cycle.`,
                    bodyHtml: null,
                    dedupeKey: `${policy.tenantId}:POLICY_REVIEW_DUE:${ownerEmail}:${policy.id}:${now.toISOString().slice(0, 10)}`,
                },
            }).catch(() => {});
        }

        // TP-5 — raise a Task for the review, linked to the policy and
        // assigned to its owner. Requires an owner: `Task.createdByUserId`
        // is NOT NULL and the reminder is only actionable by someone, so a
        // policy with no owner keeps the audit + email + automation signals
        // but no task. Idempotent via `policiesWithOpenTask` (batched
        // above), and de-duped within this run as new ids are added.
        if (policy.ownerUserId && !policiesWithOpenTask.has(policy.id)) {
            const dueStr = policy.nextReviewAt.toISOString().slice(0, 10);
            // TP-1 — route through the canonical createTask so the reminder
            // task carries a TSK-N key + TASK_CREATED audit/automation event
            // + owner bell/email, same as every other task (was a raw
            // db.task.create that produced a keyless, unaudited task).
            const ctx = buildReminderCtx(policy.tenantId, policy.ownerUserId);
            const task = await createTask(ctx, {
                source: 'POLICY_REVIEW',
                type: 'TASK',
                title: `Review policy: ${policy.title}`,
                description: overdue
                    ? `Policy "${policy.title}" is ${dOver} day(s) overdue for review. Review the content and mark it reviewed to reset the review cycle.`
                    : `Policy "${policy.title}" is due for review on ${dueStr}. Review the content and mark it reviewed to reset the review cycle.`,
                priority: overdue ? 'P1' : 'P2',
                assigneeUserId: policy.ownerUserId,
            });
            await addTaskLink(ctx, task.id, 'POLICY', policy.id);
            policiesWithOpenTask.add(policy.id);
        }

        out.push({ id: policy.id, tenantId: policy.tenantId, title: policy.title, daysOverdue: dOver });
    }

    logger.info('policy review reminders processed', {
        component: 'policy-review-reminder',
        scope: tenantId ? 'tenant-scoped' : 'system-wide',
        ...(tenantId ? { tenantId } : {}),
        processed: out.length,
    });

    return { processed: out.length, policies: out };
}
