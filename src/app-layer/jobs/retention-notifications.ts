/**
 * Evidence retention notification job.
 * Finds evidence expiring within N days and creates reminder Tasks.
 * Idempotent: checks for existing tasks with same evidenceId link.
 *
 * Usage:
 *   import { runEvidenceRetentionNotifications } from '@/app-layer/jobs/retention-notifications';
 *   await runEvidenceRetentionNotifications({ days: 30 });           // all tenants
 *   await runEvidenceRetentionNotifications({ tenantId: 'xxx' });    // single tenant
 */
import { Prisma } from '@prisma/client';
import { formatDate } from '@/lib/format-date';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { TERMINAL_TASK_STATUSES } from '../domain/task-status';
import { isNotificationsEnabled } from '../notifications/settings';
import { emitAutomationEvent } from '../automation';
import { createTask, addTaskLink } from '../usecases/task';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '../types';
import { buildDelegatedJobContext } from '../context-system';

/**
 * System context for an evidence-expiry reminder task, owned by the
 * resolved actor (evidence owner, else the tenant's first ACTIVE OWNER).
 * ADMIN permissions clear `assertCanWriteTasks`; the canonical createTask
 * then mints the TSK-N key + audit + automation event + assignee bell.
 */
/**
 * `Evidence` owner's id has to stay: `Task.createdByUserId` is NOT NULL
 * with a foreign key to `User`, so a synthetic principal makes the insert
 * die on `Task_createdByUserId_fkey`. `actorType: 'JOB'` is the half that
 * IS fixable — the row now says a job raised the reminder rather than
 * claiming the owner did. See `buildDelegatedJobContext`.
 */
function buildRetentionCtx(tenantId: string, actorUserId: string): RequestContext {
    return buildDelegatedJobContext({
        tenantId,
        job: 'retention-notifications',
        onBehalfOf: actorUserId,
    });
}

/** Fire-and-forget automation trigger — never blocks the notification job. */
function emitEvidenceTrigger(
    event: 'EVIDENCE_EXPIRING' | 'EVIDENCE_EXPIRED',
    ev: { id: string; tenantId: string; title: string; controlId: string | null },
    dateIso: string | null,
): Promise<void> {
    // The bus only reads ctx.tenantId + ctx.userId; a full context isn't
    // needed for a system-initiated event.
    const ctx = { tenantId: ev.tenantId, userId: null } as unknown as RequestContext;
    const meta = { entityType: 'Evidence', entityId: ev.id, actorUserId: null };
    const p =
        event === 'EVIDENCE_EXPIRING'
            ? emitAutomationEvent(ctx, {
                  event: 'EVIDENCE_EXPIRING',
                  ...meta,
                  data: { title: ev.title, controlId: ev.controlId, retentionUntil: dateIso },
                  stableKey: `evidence-expiring-${ev.id}`,
              })
            : emitAutomationEvent(ctx, {
                  event: 'EVIDENCE_EXPIRED',
                  ...meta,
                  data: { title: ev.title, controlId: ev.controlId, expiredAt: dateIso },
                  stableKey: `evidence-expired-${ev.id}`,
              });
    return p.catch(() => {
        /* best-effort: automation emission must never break the notification job */
    });
}

export interface RetentionNotificationOptions {
    tenantId?: string;
    days?: number;
}

export interface RetentionNotificationResult {
    scanned: number;
    tasksCreated: number;
    skippedDuplicate: number;
}

export async function runEvidenceRetentionNotifications(
    options: RetentionNotificationOptions = {},
): Promise<RetentionNotificationResult> {
    const days = options.days ?? 30;
    const futureDate = new Date(Date.now() + days * 86_400_000);

    const where: Prisma.EvidenceWhereInput = {
        retentionUntil: { not: null, lte: futureDate, gt: new Date() },
        isArchived: false,
        deletedAt: null,
    };
    if (options.tenantId) where.tenantId = options.tenantId;

    // Evidence↔Control is a many-to-many join now; the notification payload +
    // reminder Task carry a single controlId, so resolve the first linked
    // control per evidence and expose it as `controlId` for the loop below.
    const expiringRaw = await prisma.evidence.findMany({
        where,
        select: {
            id: true, tenantId: true, title: true, owner: true,
            ownerUserId: true, retentionUntil: true,
            evidenceControlLinks: { select: { controlId: true }, take: 1 },
        },
    });
    const expiring = expiringRaw.map((ev) => ({
        ...ev,
        controlId: ev.evidenceControlLinks[0]?.controlId ?? null,
    }));

    // Cache of tenant-OWNER userId per tenant so we don't re-query for each
    // evidence row. The fallback chain for `createdByUserId` (required NOT
    // NULL on Task):
    //   1. The evidence's own `ownerUserId` if set.
    //   2. The tenant's first ACTIVE OWNER membership.
    // If neither exists the evidence is skipped — better to lose a
    // notification than to crash the whole sweep.
    const tenantOwnerCache = new Map<string, string | null>();
    async function tenantOwnerUserId(tenantId: string): Promise<string | null> {
        if (tenantOwnerCache.has(tenantId)) {
            return tenantOwnerCache.get(tenantId)!;
        }
        const owner = await prisma.tenantMembership.findFirst({
            where: { tenantId, role: 'OWNER', status: 'ACTIVE' },
            select: { userId: true },
            orderBy: { createdAt: 'asc' },
        });
        const id = owner?.userId ?? null;
        tenantOwnerCache.set(tenantId, id);
        return id;
    }

    let tasksCreated = 0;
    let skippedDuplicate = 0;
    let skippedNoActor = 0;

    for (const ev of expiring) {
        // TP-5 — idempotency is keyed on the WORK SOURCE, not the task
        // type: an open `EVIDENCE_EXPIRY` task already linked to this
        // evidence means the reminder is live, so the sweep does not mint
        // a duplicate. Once that task is closed (or CANCELED — terminal),
        // a future sweep may raise a fresh one.
        const existingTask = await prisma.task.findFirst({
            where: {
                tenantId: ev.tenantId,
                source: 'EVIDENCE_EXPIRY',
                status: { notIn: [...TERMINAL_TASK_STATUSES] },
                links: {
                    some: {
                        entityType: 'EVIDENCE',
                        entityId: ev.id,
                    },
                },
            } satisfies Prisma.TaskWhereInput,
        });

        if (existingTask) {
            skippedDuplicate++;
            continue;
        }

        // Create Task + link
        // retentionUntil is non-null: the where clause filters `retentionUntil: { not: null }`
        const daysLeft = Math.ceil((new Date(ev.retentionUntil!).getTime() - Date.now()) / 86_400_000);
        // Background job has no actor — attribute to the evidence's own
        // owner if available, else the tenant's first ACTIVE OWNER.
        // Either way Task.createdByUserId is properly populated (no more
        // `as`-cast; runtime crash that would have hit the legacy
        // path on every run is now prevented). If neither resolves the
        // row is skipped — better to lose ONE notification than crash
        // the sweep.
        const createdByUserId =
            ev.ownerUserId ?? (await tenantOwnerUserId(ev.tenantId));
        if (!createdByUserId) {
            skippedNoActor++;
            continue;
        }
        // TP-1 — route through the canonical createTask so the reminder
        // task carries a TSK-N key + TASK_CREATED audit/automation event +
        // assignee bell/email, same as every other task (was a raw
        // prisma.task.create that produced a keyless, unaudited task).
        const ctx = buildRetentionCtx(ev.tenantId, createdByUserId);
        const task = await createTask(ctx, {
            // TP-5 — a neutral TASK carrying the EVIDENCE_EXPIRY source
            // so it lands in the universal /tasks inbox and is filterable
            // by where it came from.
            type: 'TASK',
            source: 'EVIDENCE_EXPIRY',
            title: `Refresh expiring evidence: ${ev.title}`,
            description: `Evidence "${ev.title}" expires in ${daysLeft} days (${formatDate(ev.retentionUntil)}). Please upload refreshed evidence or extend the retention date.`,
            priority: daysLeft <= 7 ? 'P1' : 'P2',
            // Assign to the evidence owner when one exists so the reminder
            // reaches the person responsible for it.
            ...(ev.ownerUserId ? { assigneeUserId: ev.ownerUserId } : {}),
            ...(ev.controlId ? { controlId: ev.controlId } : {}),
        });

        // Link the task to the evidence it was raised for.
        await addTaskLink(ctx, task.id, 'EVIDENCE', ev.id);

        // Enqueue EVIDENCE_EXPIRING email to tenant admins/editors
        // Tenant notification eligibility — skip if notifications are disabled.
        // Uses the same isNotificationsEnabled check as enqueue.ts and digest-dispatcher.
        try {
            const enabled = await isNotificationsEnabled(prisma, ev.tenantId);
            if (!enabled) {
                logger.info('retention notification suppressed — notifications disabled for tenant', {
                    component: 'retention-notifications',
                    tenantId: ev.tenantId,
                    evidenceId: ev.id,
                });
            } else {
                const members = await prisma.tenantMembership.findMany({
                    where: { tenantId: ev.tenantId, role: { in: ['ADMIN', 'EDITOR'] } },
                    include: { user: { select: { email: true, name: true } } },
                });

                // `controlName` was previously looked up here but
                // never referenced in the notification body —
                // CodeQL `js/useless-assignment-to-local` caught it.
                // Removed the dead lookup; if a future template wants
                // the control name, surface it through a single
                // `include: { control: { select: { name: true } } }`
                // on the parent evidence query instead of a per-row
                // extra `prisma.control.findUnique`.

                for (const m of members) {
                    if (!m.user.email) continue;
                    await prisma.notificationOutbox.create({
                        data: {
                            tenantId: ev.tenantId,
                            type: 'EVIDENCE_EXPIRING',
                            toEmail: m.user.email,
                            subject: `${daysLeft <= 7 ? '⚠️ ' : ''}Evidence expiring in ${daysLeft} day(s): ${ev.title}`,
                            bodyText: `Evidence "${ev.title}" expires in ${daysLeft} days. Please upload refreshed evidence or extend the retention date.`,
                            bodyHtml: null,
                            dedupeKey: `${ev.tenantId}:EVIDENCE_EXPIRING:${m.user.email}:${ev.id}:${new Date().toISOString().slice(0, 10)}`,
                        },
                    }).catch(() => {
                        // Silently skip duplicates (P2002)
                    });
                }
            }
        } catch (err) {
            logger.warn('failed to enqueue evidence expiring emails', { component: 'job' });
        }

        // Audit event
        await prisma.auditLog.create({
            data: {
                tenantId: ev.tenantId,
                entity: 'Evidence',
                entityId: ev.id,
                action: 'EVIDENCE_EXPIRING_SOON',
                details: JSON.stringify({ daysLeft, taskId: task.id, title: ev.title }),
            },
        });

        // Automation trigger — let rules fire on evidence going stale.
        await emitEvidenceTrigger(
            'EVIDENCE_EXPIRING',
            ev,
            ev.retentionUntil ? new Date(ev.retentionUntil).toISOString() : null,
        );

        tasksCreated++;
    }

    // Already-expired evidence → EVIDENCE_EXPIRED trigger (separate signal).
    const expiredWhere: Prisma.EvidenceWhereInput = {
        deletedAt: null,
        isArchived: false,
        expiredAt: { not: null, lt: new Date() },
    };
    if (options.tenantId) expiredWhere.tenantId = options.tenantId;
    const expiredRaw = await prisma.evidence.findMany({
        where: expiredWhere,
        select: {
            id: true, tenantId: true, title: true, expiredAt: true,
            evidenceControlLinks: { select: { controlId: true }, take: 1 },
        },
        take: 1000,
    });
    const expired = expiredRaw.map((ev) => ({
        ...ev,
        controlId: ev.evidenceControlLinks[0]?.controlId ?? null,
    }));
    for (const ev of expired) {
        await emitEvidenceTrigger(
            'EVIDENCE_EXPIRED',
            ev,
            ev.expiredAt ? new Date(ev.expiredAt).toISOString() : null,
        );
    }

    return { scanned: expiring.length, tasksCreated, skippedDuplicate };
}
