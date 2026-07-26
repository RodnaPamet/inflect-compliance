import { RequestContext } from '../types';
import { WorkItemRepository, TaskLinkRepository, TaskCommentRepository, TaskWatcherRepository, TaskFilters, TaskListParams } from '../repositories/WorkItemRepository';
import { assertCanReadTasks, assertCanWriteTasks, assertCanCreateTask, assertCanAssignTasks, assertCanCommentOnTasks } from '../policies/task.policies';
import { assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { emitAutomationEvent } from '../automation';
import { enqueueEmail } from '../notifications/enqueue';
import { createTaskDueNotification } from '../notifications/task-due';
import { createAssignmentNotification } from '../notifications/assignment';
import { createWatcherNotifications, type WatcherActivityKind } from '../notifications/watcher';
import { runInTenantContext, runInTenantReadContext } from '@/lib/db-context';
import { env } from '@/env';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { validateTaskMetadata } from '../schemas/json-columns.schemas';
import { logger } from '@/lib/observability/logger';
import { cachedListRead, bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import type { PrismaTx } from '@/lib/db-context';
import {
    checkWorkItemTransition,
    formatTransitionError,
    isTerminalStatus,
} from '../domain/work-item-status';
import { getSlaStatus } from '../services/sla';
import { reconcileTaskSource } from './task-source-reconcile';

// ─── Type-Specific Validation ───

type TaskType = 'AUDIT_FINDING' | 'CONTROL_GAP' | 'INCIDENT' | 'IMPROVEMENT' | 'TASK';

/**
 * Validate type-specific relevance rules.
 * - AUDIT_FINDING / CONTROL_GAP: must have controlId OR a link to CONTROL/FRAMEWORK_REQUIREMENT
 * - INCIDENT: must have controlId OR a link to CONTROL/ASSET
 * - TASK / IMPROVEMENT: no additional requirement
 */
async function validateTypeRelevance(
    db: PrismaTx,
    ctx: RequestContext,
    taskId: string,
    type: TaskType,
    controlId: string | null | undefined,
) {
    if (type === 'TASK' || type === 'IMPROVEMENT') return;

    if (controlId) return; // controlId satisfies all type constraints

    // Check links
    const links = await TaskLinkRepository.listByTask(db, ctx, taskId);
    const linkEntityTypes = links.map(l => l.entityType);

    if (type === 'AUDIT_FINDING' || type === 'CONTROL_GAP') {
        if (!linkEntityTypes.includes('CONTROL') && !linkEntityTypes.includes('FRAMEWORK_REQUIREMENT')) {
            throw badRequest(
                `${type} tasks must have a controlId or a link to CONTROL or FRAMEWORK_REQUIREMENT.`
            );
        }
    }

    if (type === 'INCIDENT') {
        if (!linkEntityTypes.includes('CONTROL') && !linkEntityTypes.includes('ASSET')) {
            throw badRequest(
                'INCIDENT tasks must have a controlId or a link to CONTROL or ASSET.'
            );
        }
    }
}

// ─── Reference validation (tenancy + membership) ───
//
// Prisma FK checks run BELOW row-level security, so a foreign id inserts
// cleanly and only surfaces later as a null relation — or, worse, as a
// 201-vs-FK-error oracle that leaks whether an id exists in another tenant.
// Every body-supplied id therefore gets resolved against ctx.tenantId here,
// before the write. Mirrors `finding.ts::validateFindingRefs`.

/** TaskLink.entityType → the Prisma delegate that owns that entity. */
const LINK_TARGET_MODEL = {
    CONTROL: 'control',
    FRAMEWORK_REQUIREMENT: 'frameworkRequirement',
    RISK: 'risk',
    ASSET: 'asset',
    POLICY: 'policy',
    EVIDENCE: 'evidence',
    FILE: 'fileRecord',
    AUDIT_PACK: 'auditPack',
    VENDOR: 'vendor',
    INCIDENT: 'incident',
} as const;

/**
 * Assert the parent task exists IN THIS TENANT before writing a child row
 * (comment / watcher / link). Without it the child insert succeeds against a
 * foreign taskId and the FK-error-vs-201 difference leaks task existence.
 */
async function assertTaskInTenant(db: PrismaTx, ctx: RequestContext, taskId: string) {
    const task = await db.task.findFirst({
        where: { id: taskId, tenantId: ctx.tenantId },
        select: { id: true },
    });
    if (!task) throw notFound('Task not found');
}

/** Assert every supplied user id is an ACTIVE member of this tenant. */
async function assertActiveMembers(
    db: PrismaTx,
    ctx: RequestContext,
    userIds: Array<string | null | undefined>,
) {
    const ids = [...new Set(userIds.filter((x): x is string => Boolean(x)))];
    if (ids.length === 0) return;
    const members = await db.tenantMembership.findMany({
        where: { userId: { in: ids }, tenantId: ctx.tenantId, status: 'ACTIVE' },
        select: { userId: true },
    });
    const ok = new Set(members.map((m) => m.userId));
    const bad = ids.find((id) => !ok.has(id));
    if (bad) {
        throw badRequest(
            'INVALID_USER',
            'User is not an active member of this tenant',
        );
    }
}

/**
 * Assert a TaskLink target exists in this tenant. TaskLink.entityId carries
 * no foreign key at all (prisma/schema/tasks.prisma), so this is the ONLY
 * thing standing between a link row and an arbitrary cross-tenant id.
 */
async function assertLinkTargetInTenant(
    db: PrismaTx,
    ctx: RequestContext,
    entityType: string,
    entityId: string,
) {
    const model = LINK_TARGET_MODEL[entityType as keyof typeof LINK_TARGET_MODEL];
    if (!model) throw badRequest('INVALID_LINK_TYPE', `Unsupported link entity type: ${entityType}`);
    const delegate = (db as unknown as Record<string, {
        findFirst: (a: unknown) => Promise<{ id: string } | null>;
    }>)[model];
    const found = await delegate.findFirst({
        where: { id: entityId, tenantId: ctx.tenantId },
        select: { id: true },
    });
    if (!found) {
        throw badRequest(
            'INVALID_LINK_TARGET',
            'Linked entity not found or belongs to a different tenant',
        );
    }
}

/**
 * Per-id outcome for a bulk mutation. `updateMany` reports only a count, so
 * a caller could not tell which of its ids actually changed — a payload
 * mixing live ids with stale/foreign ones looked identical to a full
 * success. Resolving the ids first also stops the audit loop emitting an
 * entry for rows that were never touched.
 */
function bulkResults(requested: string[], applied: Set<string>) {
    return {
        count: applied.size,
        results: requested.map((id) => ({
            id,
            status: applied.has(id) ? ('ok' as const) : ('not_found' as const),
        })),
    };
}

// ─── List / Get ───

export async function listTasks(
    ctx: RequestContext,
    filters: TaskFilters = {},
    options: { take?: number } = {},
) {
    assertCanReadTasks(ctx);
    return cachedListRead({
        ctx,
        entity: 'task',
        operation: 'list',
        // `take` must be in the cache key — bounded and unbounded
        // results have different shapes; sharing a key would let a
        // bounded SSR fetch poison the unbounded API GET cache.
        params: options.take ? { ...filters, _take: options.take } : filters,
        loader: () =>
            runInTenantContext(ctx, (db) =>
                WorkItemRepository.list(db, ctx, filters, options),
            ),
    });
}

export async function listTasksPaginated(ctx: RequestContext, params: TaskListParams) {
    assertCanReadTasks(ctx);
    return cachedListRead({
        ctx,
        entity: 'task',
        operation: 'listPaginated',
        params,
        loader: () =>
            runInTenantContext(ctx, (db) =>
                WorkItemRepository.listPaginated(db, ctx, params),
            ),
    });
}

export async function getTask(ctx: RequestContext, taskId: string) {
    assertCanReadTasks(ctx);
    return runInTenantContext(ctx, async (db) => {
        const task = await WorkItemRepository.getById(db, ctx, taskId);
        if (!task) throw notFound('Task not found');
        // Audit Coherence S8 (2026-05-24) — attach the derived SLA
        // status alongside the raw row. The service is pure (severity
        // + createdAt + currentStatus); no extra query, no schema
        // column. Frontend reads `sla.label` to render the breach
        // pill; auditors see triage vs resolve breach booleans.
        return {
            ...task,
            sla: getSlaStatus(task.severity, task.createdAt, task.status),
        };
    });
}

// ─── Create ───

export async function createTask(ctx: RequestContext, input: {
    title: string;
    type?: string;
    description?: string | null;
    severity?: string;
    priority?: string;
    source?: string;
    dueAt?: string | null;
    assigneeUserId?: string | null;
    reviewerUserId?: string | null;
    controlId?: string | null;
    findingId?: string | null;
    metadataJson?: unknown;
}) {
    assertCanCreateTask(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        // Validate metadataJson on write
        if (input.metadataJson !== undefined) {
            input.metadataJson = validateTaskMetadata(input.metadataJson);
        }
        // TP-2 (hole 2b) — segregation of duties at creation: reviewer ≠ assignee.
        assertReviewerIsNotAssignee(input.reviewerUserId, input.assigneeUserId);
        // Both user ids come from the request body and are stamped with
        // ctx.tenantId on write — resolve them against an ACTIVE membership
        // first so a foreign id cannot be persisted.
        await assertActiveMembers(db, ctx, [input.assigneeUserId, input.reviewerUserId]);

        const task = await WorkItemRepository.create(db, ctx, input);

        // Type-specific validation (deferred: allow creation, then check after links can be added)
        // For create, we validate immediately since controlId is already set
        const type = (input.type || 'TASK') as TaskType;
        if (type !== 'TASK' && type !== 'IMPROVEMENT') {
            // Only validate if controlId is required and not provided
            // Links can't exist yet at creation time, so we only enforce controlId here
            if (!input.controlId && (type === 'AUDIT_FINDING' || type === 'CONTROL_GAP' || type === 'INCIDENT')) {
                // Don't fail — allow creation; validation happens on status transitions
                // Store a warning in metadataJson
            }
        }

        await logEvent(db, ctx, {
            action: 'TASK_CREATED',
            entityType: 'Task',
            entityId: task.id,
            details: `Created task ${task.key}: ${task.title}`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Task', operation: 'created', summary: 'TASK_CREATED' },
            metadata: { type: input.type, severity: input.severity, priority: input.priority },
        });

        await emitAutomationEvent(ctx, {
            event: 'TASK_CREATED',
            entityType: 'Task',
            entityId: task.id,
            actorUserId: ctx.userId,
            stableKey: task.id,
            data: {
                key: task.key,
                title: task.title,
                type: task.type,
                severity: task.severity,
                priority: task.priority,
                assigneeUserId: task.assigneeUserId,
                controlId: task.controlId,
            },
        });

        // Enqueue email to assignee if set
        if (input.assigneeUserId) {
            await enqueueTaskAssignedNotification(db, ctx, task.id, task.title, task.key, input.type || 'TASK', input.assigneeUserId);
        }

        return task;
    });
    // In-app TASK_DUE notification if the new task is already assigned
    // and due within a reminder window. Runs AFTER the task
    // transaction commits — see `emitTaskDueNotification`.
    await emitTaskDueNotification(ctx, result);
    // PR-A 2026-05-27 — also fire the in-app TASK_ASSIGNED bell.
    // Pre-PR-A, only the email path ran on create-with-assignee, so
    // the bell stayed silent until the task entered a due-window.
    if (result.assigneeUserId) {
        await emitTaskAssignedNotification(ctx, result);
    }
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

/**
 * TP-2 (hole 2b) — segregation of duties: a task's reviewer may not also be
 * its assignee. Four eyes means two people; letting the doer sign off on their
 * own work makes the gate ceremonial. Enforced on every path that can bring the
 * two fields into agreement: create, update (reviewer side), and assign
 * (assignee side).
 *
 * There is no per-tenant "allow self-review" setting today, so this is
 * unconditional — see the implementation note. If one is ever added, this
 * helper is the single place to consult it.
 */
export function assertReviewerIsNotAssignee(
    reviewerUserId: string | null | undefined,
    assigneeUserId: string | null | undefined,
): void {
    if (!reviewerUserId || !assigneeUserId) return;
    if (reviewerUserId === assigneeUserId) {
        throw badRequest(
            "A task's reviewer must be different from its assignee — the person doing the work cannot sign off on it.",
        );
    }
}

// ─── Update ───

export async function updateTask(ctx: RequestContext, taskId: string, patch: {
    title?: string;
    description?: string | null;
    type?: string;
    severity?: string;
    priority?: string;
    dueAt?: string | null;
    controlId?: string | null;
    reviewerUserId?: string | null;
    metadataJson?: unknown;
}) {
    assertCanWriteTasks(ctx);
    // The before-values ride out of the transaction on its RETURN value (rather
    // than via closure mutation) so TypeScript can actually see them as
    // populated — a `let` assigned inside the callback stays narrowed to its
    // initializer at the post-commit read.
    const { task: result, beforeDueAt, beforeReviewerUserId } = await runInTenantContext(ctx, async (db) => {
        // A reviewer id arriving on the patch is body-supplied and stamped
        // with ctx.tenantId on write — resolve it against an ACTIVE
        // membership first (createTask does the same for assignee+reviewer).
        await assertActiveMembers(db, ctx, [patch.reviewerUserId]);
        // Validate metadataJson on write
        if (patch.metadataJson !== undefined) {
            patch.metadataJson = validateTaskMetadata(patch.metadataJson);
        }

        // TP-2 (hole 2) — the reviewer field itself is part of the four-eyes
        // control, so changing it is gated too. Read the before-state.
        const existing = await WorkItemRepository.getById(db, ctx, taskId);
        if (!existing) throw notFound('Task not found');
        const beforeDueAt = existing.dueAt;
        const beforeReviewerUserId = existing.reviewerUserId;

        if (patch.reviewerUserId !== undefined) {
            // (a) OPT-OUT HOLE — once a task actually REQUIRES review (it has a
            // reviewer AND has reached or passed IN_REVIEW), an editor could
            // PATCH `reviewerUserId: null` to escape sign-off entirely. Only the
            // sitting reviewer (handing off / stepping down) or an admin may
            // change it from that point on.
            const reviewRequired =
                !!existing.reviewerUserId &&
                (existing.status === 'IN_REVIEW' || isTerminalStatus(existing.status));
            const isReviewer = ctx.userId === existing.reviewerUserId;
            const isAdmin = ctx.permissions.canAdmin;
            if (reviewRequired && !isReviewer && !isAdmin) {
                throw forbidden(
                    'This task is under review — only the assigned reviewer or an admin can change or clear its reviewer.',
                );
            }

            // (b) SELF-REVIEW HOLE — segregation of duties: the doer cannot be
            // the sole sign-off. `assigneeUserId` is not part of this patch
            // shape, so the effective assignee is the stored one.
            assertReviewerIsNotAssignee(patch.reviewerUserId, existing.assigneeUserId);
        }

        const task = await WorkItemRepository.update(db, ctx, taskId, patch);
        if (!task) throw notFound('Task not found');
        await logEvent(db, ctx, {
            action: 'TASK_UPDATED',
            entityType: 'Task',
            entityId: taskId,
            details: 'Updated task fields',
            detailsJson: { category: 'entity_lifecycle', entityName: 'Task', operation: 'updated', summary: 'TASK_UPDATED' },
            metadata: patch,
        });
        return { task, beforeDueAt, beforeReviewerUserId };
    });
    // A rescheduled `dueAt` may move the task into a reminder window —
    // re-evaluate the in-app notification after the commit.
    await emitTaskDueNotification(ctx, result);

    // TP-2 — watcher fan-out on MATERIAL edits. Watchers were told about
    // comments, status moves and assignments but not about the two changes
    // that most often invalidate their plans: a due-date reschedule and a
    // reviewer reassignment. Cosmetic edits (title/description) stay silent on
    // purpose — a bell for every save trains people to ignore the bell.
    const dueChanged =
        patch.dueAt !== undefined &&
        (beforeDueAt?.getTime() ?? null) !== (result.dueAt?.getTime() ?? null);
    const reviewerChanged =
        patch.reviewerUserId !== undefined &&
        beforeReviewerUserId !== result.reviewerUserId;

    if (dueChanged || reviewerChanged) {
        const changes: string[] = [];
        if (dueChanged) {
            // Plain YYYY-MM-DD — this string goes into a stored notification
            // body read by many users, so it stays locale-free.
            const ymd = (d: Date) => d.toISOString().slice(0, 10);
            const from = beforeDueAt ? ymd(beforeDueAt) : 'no due date';
            const to = result.dueAt ? ymd(result.dueAt) : 'no due date';
            changes.push(`due ${from} → ${to}`);
        }
        if (reviewerChanged) {
            changes.push(result.reviewerUserId ? 'reviewer reassigned' : 'reviewer cleared');
        }
        await emitTaskWatcherActivity(
            ctx,
            taskId,
            'updated',
            // Discriminator keys the dedupe on WHAT changed to WHAT, so two
            // genuinely different reschedules don't collapse into one bell
            // while a retry of the same write still dedupes.
            `${beforeDueAt?.toISOString() ?? 'none'}->${result.dueAt?.toISOString() ?? 'none'}|${beforeReviewerUserId ?? 'none'}->${result.reviewerUserId ?? 'none'}`,
            changes.join(', '),
        );
    }

    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

// ─── Delete ───
//
// Hard delete. The Task model's child rows (TaskComment / TaskLink /
// TaskWatcher) all cascade via `onDelete: Cascade`, so removing the
// task row cleans up its comments, entity links, and watchers in one
// statement. Gated on write permission (same tier as edit) and audited.
/**
 * Bulk soft-delete tasks selected in the table action bar.
 *
 * ADMIN tier, matching `bulkDeleteRisk` / `bulkDeleteAsset` /
 * `control/mutations.bulkDelete` — a bulk destructive action is an admin
 * capability across every register, and tasks were the lone exception at the
 * write tier. The ROUTE stays on `tasks.edit`, which is also what the assets
 * bulk-delete route does: the coarse HTTP gate lets an editor reach the
 * usecase, and the usecase makes the tier decision.
 */
export async function bulkDeleteTask(ctx: RequestContext, taskIds: string[]) {
    assertCanAdmin(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        const rows = await WorkItemRepository.listByIds(db, ctx, taskIds);
        // A payload where NOTHING resolves is a client error, not a
        // successful no-op — previously this returned {deleted: 0} and the
        // caller could not tell "already gone" from "wrong tenant/ids".
        if (rows.length === 0) throw notFound('No matching tasks found');

        const found = new Set(rows.map((r) => r.id));
        await db.task.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId } });

        // Audit rows stay SEQUENTIAL by design: they are hash-chained under a
        // per-tenant advisory lock, so emitting them concurrently would
        // corrupt the chain (same conclusion #1705 reached for controls).
        // What changed is that only ids that ACTUALLY resolved get an entry —
        // previously every requested id was audited even when the delete
        // matched fewer rows.
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'SOFT_DELETE',
                entityType: 'Task',
                entityId: r.id,
                details: 'Task soft-deleted (bulk)',
                detailsJson: { category: 'entity_lifecycle', entityName: 'Task', operation: 'deleted', summary: 'Task soft-deleted' },
            });
        }

        // Per-id outcome so a partially-matching payload is legible to the
        // caller instead of collapsing into a bare count.
        return {
            deleted: rows.length,
            count: rows.length,
            results: taskIds.map((id) => ({
                id,
                status: found.has(id) ? ('deleted' as const) : ('not_found' as const),
            })),
        };
    });
    // Without this the cached list keeps serving deleted tasks for the TTL.
    await bumpEntityCacheVersion(ctx, 'task');
    return outcome;
}

export async function deleteTask(ctx: RequestContext, taskId: string) {
    assertCanWriteTasks(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const existing = await WorkItemRepository.getById(db, ctx, taskId);
        if (!existing) throw notFound('Task not found');
        await db.task.delete({ where: { id: taskId } });
        await logEvent(db, ctx, {
            action: 'TASK_DELETED',
            entityType: 'Task',
            entityId: taskId,
            details: `Deleted task: ${existing.title}`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Task', operation: 'deleted', summary: 'TASK_DELETED' },
            metadata: { title: existing.title, type: existing.type },
        });
        return { id: taskId };
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

// ─── Status ───

/**
 * TP-2 reviewer sign-off gate — the four-eyes control, in ONE place.
 *
 * When a task carries a `reviewerUserId` it cannot be completed
 * (RESOLVED/CLOSED) directly from an active state: the close MUST pass
 * through IN_REVIEW and be driven by the reviewer. CANCELED is exempt
 * (cancelling is not completing), and RESOLVED→CLOSED bookkeeping is exempt
 * because the sign-off already happened on the IN_REVIEW→RESOLVED step
 * (`fromStatus` is already terminal there).
 *
 * Returns a violation message, or `null` when the transition is allowed.
 * BOTH the single-task and the BULK status paths call this — the gate is a
 * compliance control, and bulk is an admin convenience, not an escape hatch.
 */
export function checkReviewerSignOffGate(args: {
    reviewerUserId: string | null | undefined;
    fromStatus: string;
    toStatus: string;
    actorUserId: string;
}): { kind: 'needs_review' | 'wrong_actor'; message: string } | null {
    const { reviewerUserId, fromStatus, toStatus, actorUserId } = args;
    if (!reviewerUserId) return null;
    if (isTerminalStatus(fromStatus)) return null;
    if (toStatus !== 'RESOLVED' && toStatus !== 'CLOSED') return null;

    if (fromStatus !== 'IN_REVIEW') {
        return {
            kind: 'needs_review',
            message: `This task has a reviewer and must pass through IN_REVIEW before it can be ${toStatus}. Move it to IN_REVIEW for sign-off first.`,
        };
    }
    if (actorUserId !== reviewerUserId) {
        return {
            kind: 'wrong_actor',
            message: 'Only the assigned reviewer can sign off and complete this task.',
        };
    }
    return null;
}

export async function setTaskStatus(ctx: RequestContext, taskId: string, status: string, resolution?: string | null) {
    assertCanWriteTasks(ctx);
    let capturedFrom = '';
    const result = await runInTenantContext(ctx, async (db) => {
        // Pre-fetch once so we can both validate + capture fromStatus
        // for the automation event.
        const existing = await WorkItemRepository.getById(db, ctx, taskId);
        if (!existing) throw notFound('Task not found');
        const fromStatus = existing.status;
        capturedFrom = fromStatus;

        // Audit Coherence S8 (2026-05-24) — state-machine gate runs
        // BEFORE the type-relevance check. Catches no-op + illegal
        // shapes (e.g. CLOSED → OPEN re-open, CANCELED → IN_PROGRESS,
        // OPEN → CLOSED skipping RESOLVED) so the only paths that
        // reach the repository write are documented transitions.
        const transitionErr = checkWorkItemTransition(fromStatus, status);
        if (transitionErr) throw badRequest(formatTransitionError(transitionErr));

        // TP-2 — reviewer sign-off gate (shared with the bulk path).
        const gateViolation = checkReviewerSignOffGate({
            reviewerUserId: existing.reviewerUserId,
            fromStatus,
            toStatus: status,
            actorUserId: ctx.userId,
        });
        if (gateViolation) {
            throw gateViolation.kind === 'wrong_actor'
                ? forbidden(gateViolation.message)
                : badRequest(gateViolation.message);
        }

        // Audit Coherence S8 — every terminal write requires a non-
        // empty `resolution` text. The auditor reads it from the
        // audit-log row + the task body; "closed without why" was
        // a recurring SOC 2 review finding.
        if (isTerminalStatus(status)) {
            const trimmed = (resolution ?? '').trim();
            if (!trimmed) {
                throw badRequest(
                    `A resolution is required when moving a task to ${status}.`,
                );
            }
            resolution = trimmed;
        }

        if (['RESOLVED', 'CLOSED'].includes(status)) {
            await validateTypeRelevance(db, ctx, taskId, existing.type as TaskType, existing.controlId);
        }

        const task = await WorkItemRepository.setStatus(db, ctx, taskId, status, resolution);
        if (!task) throw notFound('Task not found');
        await logEvent(db, ctx, {
            action: 'TASK_STATUS_CHANGED',
            entityType: 'Task',
            entityId: taskId,
            details: `Status changed to ${status}`,
            // Audit Coherence S8 — write the REAL fromStatus + toStatus.
            // Pre-S8 these were hardcoded to (null, 'TASK_STATUS_CHANGED')
            // which left the audit row useless for "did this row pass
            // through TRIAGED?" queries that auditors regularly run.
            detailsJson: {
                category: 'status_change',
                entityName: 'Task',
                fromStatus,
                toStatus: status,
            },
            metadata: { status, resolution },
        });
        await emitAutomationEvent(ctx, {
            event: 'TASK_STATUS_CHANGED',
            entityType: 'Task',
            entityId: taskId,
            actorUserId: ctx.userId,
            stableKey: `${taskId}:${fromStatus}:${status}`,
            data: {
                fromStatus,
                toStatus: status,
                resolution: resolution ?? null,
            },
        });
        // TP-3 — reconcile the source that raised this task once it
        // reaches a terminal RESOLVED/CLOSED state (NOT CANCELED). Runs
        // AFTER the task's own status write + audit, inside the SAME
        // tenant transaction so the source mutation commits atomically.
        await reconcileTaskSource(db, ctx, taskId, status);
        return task;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    // TP-2 — notify watchers of the status change (bell).
    await emitTaskWatcherActivity(
        ctx,
        taskId,
        'status_changed',
        `${capturedFrom}->${status}`,
        `status changed ${capturedFrom} → ${status}`,
    );
    return result;
}

// ─── Assign ───

export async function assignTask(ctx: RequestContext, taskId: string, assigneeUserId: string | null) {
    assertCanAssignTasks(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        // The assignee id is body-supplied and stamped with ctx.tenantId on
        // write; resolve it against an ACTIVE membership first.
        await assertActiveMembers(db, ctx, [assigneeUserId]);
        // TP-2 (hole 2b) — SoD from the assignee side: assigning the task to the
        // person who is already its reviewer would collapse four eyes into two
        // just as surely as setting reviewer = assignee does.
        if (assigneeUserId) {
            const existing = await WorkItemRepository.getById(db, ctx, taskId);
            if (!existing) throw notFound('Task not found');
            assertReviewerIsNotAssignee(existing.reviewerUserId, assigneeUserId);
        }

        const task = await WorkItemRepository.assign(db, ctx, taskId, assigneeUserId);
        if (!task) throw notFound('Task not found');
        await logEvent(db, ctx, {
            action: 'TASK_ASSIGNED',
            entityType: 'Task',
            entityId: taskId,
            details: assigneeUserId ? `Assigned to ${assigneeUserId}` : 'Unassigned',
            detailsJson: { category: 'custom', event: 'task_assigned' },
            metadata: { assigneeUserId },
        });

        // Enqueue email to new assignee
        if (assigneeUserId) {
            await enqueueTaskAssignedNotification(db, ctx, taskId, task.title, task.key, task.type, assigneeUserId);
        }
        return task;
    });
    // In-app TASK_DUE notification for the new assignee if the task
    // is due within a reminder window — after the commit.
    await emitTaskDueNotification(ctx, result);
    // PR-A 2026-05-27 — in-app TASK_ASSIGNED bell notification.
    // Mirrors the email path that's already wired in
    // `enqueueTaskAssignedNotification` above; this one routes the
    // alert to the notification bell so the assignee sees it
    // without waiting for the daily digest.
    if (result.assigneeUserId) {
        await emitTaskAssignedNotification(ctx, result);
    }
    await bumpEntityCacheVersion(ctx, 'task');
    // TP-2 — notify watchers of the (re)assignment (bell). The assignee
    // gets their own TASK_ASSIGNED bell above; watchers get the activity
    // feed entry. Actor-exclusion in the helper avoids self-notifying.
    await emitTaskWatcherActivity(
        ctx,
        taskId,
        'assigned',
        assigneeUserId ?? 'unassigned',
        assigneeUserId ? 'reassigned' : 'unassigned',
    );
    return result;
}

/** Look up assignee email and enqueue TASK_ASSIGNED notification */
async function enqueueTaskAssignedNotification(
    db: PrismaTx,
    ctx: RequestContext,
    taskId: string,
    taskTitle: string,
    taskKey: string | null | undefined,
    taskType: string,
    assigneeUserId: string,
): Promise<void> {
    try {
        // Resolve the assignee THROUGH an active membership of this tenant.
        //
        // `User` carries no RLS policy, so a bare `user.findUnique` is a
        // global lookup: a foreign user id would resolve and then be emailed
        // the task title, key and tenant slug. That is both a cross-tenant
        // disclosure and a user-id existence oracle (mail sent vs not).
        // Joining through TenantMembership makes the notification reachable
        // only for someone who is genuinely in this tenant.
        const membership = await db.tenantMembership.findFirst({
            where: {
                userId: assigneeUserId,
                tenantId: ctx.tenantId,
                status: 'ACTIVE',
            },
            select: { user: { select: { email: true, name: true } } },
        });
        const assignee = membership?.user;
        if (!assignee?.email) return;

        const assigner = await db.user.findUnique({
            where: { id: ctx.userId },
            select: { name: true },
        });

        await enqueueEmail(db, {
            tenantId: ctx.tenantId,
            type: 'TASK_ASSIGNED',
            toEmail: assignee.email,
            entityId: taskId,
            requestId: ctx.requestId,
            payload: {
                taskTitle,
                taskKey,
                taskType,
                assigneeName: assignee.name || assignee.email,
                assignerName: assigner?.name || undefined,
                tenantSlug: ctx.tenantSlug || '',
            },
        });
    } catch (err) {
        // Fire-and-forget — never break the task operation
        logger.warn('failed to enqueue task assignment email', { component: 'notifications' });
    }
}

/**
 * Fire the in-app `TASK_DUE` notification the moment a task is
 * created / rescheduled / assigned, so a near-term deadline reaches
 * the notification bell immediately — instead of waiting on the
 * daily 08:00 `task-due-notification` cron (which also depends on
 * the scheduler having registered the repeatable).
 *
 * Runs AFTER the task's own transaction has committed, in its own
 * short `runInTenantContext` transaction. It must NOT share the
 * caller's transaction:
 *   - A notification write must never roll back the task write — the
 *     task is the user's intent; the notification is a side effect.
 *   - `createTaskDueNotification` is idempotent via `ON CONFLICT DO
 *     NOTHING` (it shares the cron's `dedupeKey`), but isolating it
 *     in its own transaction also keeps any genuine DB error off the
 *     task transaction entirely.
 * Fully fire-and-forget — any failure is logged and swallowed.
 */
async function emitTaskDueNotification(
    ctx: RequestContext,
    task: {
        id: string;
        tenantId: string;
        title: string;
        key: string | null;
        dueAt: Date | null;
        assigneeUserId: string | null;
    },
): Promise<void> {
    if (!task.assigneeUserId || !task.dueAt || !ctx.tenantSlug) return;
    // Hoist the narrowed values — the closure below would otherwise
    // see the wider nullable property types.
    const tenantSlug = ctx.tenantSlug;
    const assigneeUserId = task.assigneeUserId;
    const dueAt = task.dueAt;
    try {
        await runInTenantContext(ctx, (db) =>
            createTaskDueNotification(
                db,
                {
                    id: task.id,
                    tenantId: task.tenantId,
                    tenantSlug,
                    title: task.title,
                    key: task.key,
                    dueAt,
                    assigneeUserId,
                },
                new Date(),
                // Classify in the same zone as the daily cron so the
                // event-driven and steady-state paths agree on the
                // window + dedupeKey for a task due near local midnight.
                env.NOTIFICATIONS_TZ,
            ),
        );
    } catch (err) {
        logger.warn('failed to create task-due notification', {
            component: 'notifications',
            taskId: task.id,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * PR-A 2026-05-27 — in-app `TASK_ASSIGNED` bell notification.
 *
 * Pre-PR-A only the email path fired (`enqueueTaskAssignedNotification`
 * → `NotificationOutbox`), so the assignee saw the alert in their
 * inbox but never on the notification bell. This sibling routes the
 * same trigger into the `Notification` table.
 *
 * Same fire-and-forget posture as `emitTaskDueNotification`:
 *   - Runs AFTER the task transaction commits.
 *   - Its own short `runInTenantContext` — a notification write
 *     must never roll back the task.
 *   - `createAssignmentNotification` is idempotent via the
 *     `(tenantId, TASK_ASSIGNED, taskId, userId, date)` dedupeKey
 *     so a rapid sequence of assign-toggles within one day
 *     collapses to a single bell entry.
 */
async function emitTaskAssignedNotification(
    ctx: RequestContext,
    task: {
        id: string;
        tenantId: string;
        title: string;
        key: string | null;
        assigneeUserId: string | null;
    },
): Promise<void> {
    if (!task.assigneeUserId || !ctx.tenantSlug) return;
    const tenantSlug = ctx.tenantSlug;
    const assigneeUserId = task.assigneeUserId;
    try {
        await runInTenantContext(ctx, (db) =>
            createAssignmentNotification(db, 'TASK_ASSIGNED', {
                tenantId: task.tenantId,
                assigneeUserId,
                entityId: task.id,
                entityLabel: task.title,
                entityKey: task.key,
                tenantSlug,
            }),
        );
    } catch (err) {
        logger.warn('failed to create task-assigned notification', {
            component: 'notifications',
            taskId: task.id,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * TP-2 — fan a task activity out to its WATCHERS' notification bells.
 *
 * Loads the task title/key + watcher set itself (only needs the taskId),
 * so all three call sites (comment-add, status-change, assign) share one
 * shape. Excludes the actor — you are never notified of your own action.
 * Same fire-and-forget posture as the assignee emitters: runs AFTER the
 * task write commits, in its own short transaction, and swallows errors
 * so a notification failure never surfaces to the task operation.
 */
async function emitTaskWatcherActivity(
    ctx: RequestContext,
    taskId: string,
    kind: WatcherActivityKind,
    discriminator: string,
    detail: string,
): Promise<void> {
    if (!ctx.tenantSlug) return;
    const tenantSlug = ctx.tenantSlug;
    try {
        await runInTenantContext(ctx, async (db) => {
            const task = await db.task.findFirst({
                where: { id: taskId, tenantId: ctx.tenantId },
                select: { id: true, tenantId: true, title: true, key: true },
            });
            if (!task) return;
            const watchers = await TaskWatcherRepository.listByTask(db, ctx, taskId);
            const targets = watchers
                .map((w) => w.userId)
                .filter((uid) => uid !== ctx.userId);
            if (targets.length === 0) return;
            await createWatcherNotifications(db, targets, {
                tenantId: task.tenantId,
                tenantSlug,
                taskId: task.id,
                taskKey: task.key,
                taskTitle: task.title,
                kind,
                discriminator,
                detail,
            });
        });
    } catch (err) {
        logger.warn('failed to notify task watchers', {
            component: 'notifications',
            taskId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ─── Links ───

export async function listTaskLinks(ctx: RequestContext, taskId: string) {
    assertCanReadTasks(ctx);
    // TP-4 — resolve each link's entity name + detail path so the UI
    // renders a real link instead of a raw cuid. Bounded, no N+1.
    return runInTenantContext(ctx, (db) => TaskLinkRepository.listByTaskResolved(db, ctx, taskId));
}

export async function addTaskLink(ctx: RequestContext, taskId: string, entityType: string, entityId: string, relation?: string) {
    assertCanWriteTasks(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        await assertTaskInTenant(db, ctx, taskId);
        await assertLinkTargetInTenant(db, ctx, entityType, entityId);
        const link = await TaskLinkRepository.link(db, ctx, taskId, entityType, entityId, relation);
        await logEvent(db, ctx, {
            action: 'TASK_LINKED',
            entityType: 'Task',
            entityId: taskId,
            details: `Linked to ${entityType} ${entityId}`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Task' },
            metadata: { entityType, entityId, relation },
        });
        return link;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

/**
 * Remove one cross-entity link from a task.
 *
 * Scoped to the owning `taskId` — previously only the link id was used, so
 * any link in the tenant could be deleted via any task's URL. The audit row
 * is written against the TASK, not the link: the activity feed filters
 * `entityId = taskId` (see `getTaskActivity`), so auditing the link id made
 * unlinks invisible in the feed of the task they happened to.
 */
export async function removeTaskLink(
    ctx: RequestContext,
    taskId: string,
    linkId: string,
) {
    assertCanWriteTasks(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        const result = await TaskLinkRepository.unlink(db, ctx, taskId, linkId);
        if (!result) throw notFound('Task link not found');
        await logEvent(db, ctx, {
            action: 'TASK_UNLINKED',
            entityType: 'Task',
            entityId: taskId,
            details: 'Removed task link',
            detailsJson: {
                category: 'relationship',
                operation: 'unlinked',
                sourceEntity: 'Task',
                linkId,
            },
        });
        return result;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return outcome;
}

// ─── Evidence ───
//
// Task evidence mirrors the control Evidence tab. A task attaches
// Evidence entities directly via `Evidence.taskId` (no separate link
// table — unlike controls, which carry a ControlEvidenceLink bridge).
// The shared <EvidenceSubTable> renders the `{ links, evidence }`
// payload identically; for tasks `links` is always empty.

/**
 * Task Evidence tab payload — same `{ links, evidence }` shape the
 * control Evidence tab returns, so the shared sub-table can render it
 * unchanged.
 */
export async function getTaskEvidenceTab(ctx: RequestContext, taskId: string) {
    assertCanReadTasks(ctx);
    return runInTenantContext(ctx, async (db) => {
        const task = await db.task.findFirst({
            where: { id: taskId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!task) throw notFound('Task not found');
        const evidence = await db.evidence.findMany({
            where: { taskId, tenantId: ctx.tenantId, deletedAt: null },
            orderBy: { createdAt: 'desc' },
        });
        return { links: [], evidence };
    });
}

/**
 * Attach a URL as evidence on a task — mirrors the control "+ Evidence"
 * URL path. Creates a LINK-type Evidence row pointing at the task. File
 * uploads go through `/evidence/uploads` (uploadEvidenceFile) with a
 * `taskId`, exactly like controls.
 */
export async function linkTaskEvidence(
    ctx: RequestContext,
    taskId: string,
    data: { url: string; note?: string | null },
) {
    assertCanWriteTasks(ctx);
    const url = data.url.trim();
    const note = data.note ? sanitizePlainText(data.note) : null;
    const result = await runInTenantContext(ctx, async (db) => {
        const task = await db.task.findFirst({
            where: { id: taskId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!task) throw notFound('Task not found');
        const evidence = await db.evidence.create({
            data: {
                tenantId: ctx.tenantId,
                taskId,
                type: 'LINK',
                title: note || url,
                content: url,
                status: 'DRAFT',
                ownerUserId: ctx.userId,
            },
        });
        await logEvent(db, ctx, {
            action: 'TASK_EVIDENCE_LINKED',
            entityType: 'Task',
            entityId: taskId,
            details: `Evidence linked: ${url}`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Task', sourceId: taskId, targetEntity: 'Evidence', targetId: evidence.id, relation: 'LINK' },
        });
        return evidence;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

/**
 * Detach evidence from a task — clears `Evidence.taskId` so the row
 * stays in the Evidence Library but no longer shows on this task's
 * Evidence tab (mirrors control evidence unlink: the association is
 * removed, the evidence survives).
 */
export async function unlinkTaskEvidence(
    ctx: RequestContext,
    taskId: string,
    evidenceId: string,
) {
    assertCanWriteTasks(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        const evidence = await db.evidence.findFirst({
            where: { id: evidenceId, taskId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!evidence) throw notFound('Task evidence not found');
        await db.evidence.update({
            where: { id: evidenceId },
            data: { taskId: null },
        });
        await logEvent(db, ctx, {
            action: 'TASK_EVIDENCE_UNLINKED',
            entityType: 'Task',
            entityId: taskId,
            details: `Evidence unlinked: ${evidenceId}`,
            detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Task', sourceId: taskId, targetEntity: 'Evidence', targetId: evidenceId },
        });
        return { success: true };
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return outcome;
}

// ─── Comments ───

export async function listTaskComments(ctx: RequestContext, taskId: string) {
    assertCanReadTasks(ctx);
    return runInTenantContext(ctx, (db) => TaskCommentRepository.listByTask(db, ctx, taskId));
}

export async function addTaskComment(ctx: RequestContext, taskId: string, body: string) {
    assertCanCommentOnTasks(ctx);
    // Epic C.5 — comments today are plain text. Strip any HTML the
    // client tries to inject before persistence so a future renderer
    // change (Markdown, HTML preview) can never accidentally re-enable
    // a stored XSS vector.
    const safeBody = sanitizePlainText(body);
    const result = await runInTenantContext(ctx, async (db) => {
        await assertTaskInTenant(db, ctx, taskId);
        const comment = await TaskCommentRepository.add(db, ctx, taskId, safeBody);
        await logEvent(db, ctx, {
            action: 'TASK_COMMENT_ADDED',
            entityType: 'Task',
            entityId: taskId,
            details: 'Comment added',
            detailsJson: { category: 'custom', event: 'task_comment_added' },
            metadata: { commentId: comment.id },
        });
        return comment;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    // TP-2 — notify watchers of the new comment (bell). Keyed on the
    // comment id so each distinct comment is its own activity entry.
    await emitTaskWatcherActivity(ctx, taskId, 'commented', result.id, 'new comment added');
    return result;
}

// ─── Watchers ───

export async function listTaskWatchers(ctx: RequestContext, taskId: string) {
    assertCanReadTasks(ctx);
    return runInTenantContext(ctx, (db) => TaskWatcherRepository.listByTask(db, ctx, taskId));
}

export async function addTaskWatcher(ctx: RequestContext, taskId: string, userId: string) {
    assertCanWriteTasks(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        await assertTaskInTenant(db, ctx, taskId);
        await assertActiveMembers(db, ctx, [userId]);
        return TaskWatcherRepository.add(db, ctx, taskId, userId);
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

export async function removeTaskWatcher(ctx: RequestContext, taskId: string, userId: string) {
    assertCanWriteTasks(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        const result = await TaskWatcherRepository.remove(db, ctx, taskId, userId);
        if (!result) throw notFound('Watcher not found');
        return result;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return outcome;
}

// ─── Metrics ───

export async function getTaskMetrics(ctx: RequestContext) {
    assertCanReadTasks(ctx);
    return runInTenantReadContext(ctx, (db) => WorkItemRepository.metrics(db, ctx));
}

// ─── Activity Feed ───

export async function getTaskActivity(ctx: RequestContext, taskId: string) {
    assertCanReadTasks(ctx);
    return runInTenantContext(ctx, (db) =>
        db.auditLog.findMany({
            where: { tenantId: ctx.tenantId, entity: 'Task', entityId: taskId },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: { user: { select: { id: true, name: true, email: true } } },
        })
    );
}

// ─── Bulk Actions ───

export async function bulkAssignTasks(ctx: RequestContext, taskIds: string[], assigneeUserId: string | null) {
    assertCanAssignTasks(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        await assertActiveMembers(db, ctx, [assigneeUserId]);

        // TP-2 (hole 2b) — segregation of duties, matching the single-task
        // path. Bulk is an admin convenience, not an escape hatch: assigning
        // a task to the person who is already its reviewer collapses four
        // eyes into two. Checked against the DB rows, never a body value.
        if (assigneeUserId) {
            const conflicting = await db.task.findFirst({
                where: {
                    id: { in: taskIds },
                    tenantId: ctx.tenantId,
                    reviewerUserId: assigneeUserId,
                },
                select: { key: true },
            });
            if (conflicting) {
                throw badRequest(
                    `Cannot assign ${conflicting.key ?? 'a task'} to its own reviewer — assignee and reviewer must differ.`,
                );
            }
        }

        const rows = await WorkItemRepository.listByIds(db, ctx, taskIds);
        if (rows.length === 0) throw notFound('No matching tasks found');
        const applied = new Set(rows.map((r) => r.id));

        const result = await WorkItemRepository.bulkAssign(db, ctx, [...applied], assigneeUserId);
        // Audit only ids that actually resolved. Sequential by design —
        // audit rows are hash-chained under a per-tenant advisory lock.
        for (const id of applied) {
            await logEvent(db, ctx, {
                action: 'TASK_ASSIGNED',
                entityType: 'Task',
                entityId: id,
                details: assigneeUserId ? `Bulk assigned to ${assigneeUserId}` : 'Bulk unassigned',
                detailsJson: { category: 'custom', event: 'task_assigned' },
                metadata: { assigneeUserId, bulk: true },
            });
        }
        return { ...result, ...bulkResults(taskIds, applied) };
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return outcome;
}

export async function bulkSetTaskStatus(ctx: RequestContext, taskIds: string[], status: string, resolution?: string) {
    assertCanWriteTasks(ctx);

    // Audit Coherence S8 (2026-05-24) — bulk path enforces the same
    // resolution + transition gates as the single-task path. Bulk
    // operations are an admin convenience, not an escape hatch.
    if (isTerminalStatus(status)) {
        const trimmed = (resolution ?? '').trim();
        if (!trimmed) {
            throw badRequest(
                `A resolution is required when moving a task to ${status}.`,
            );
        }
        resolution = trimmed;
    }

    const outcome = await runInTenantContext(ctx, async (db) => {
        // Pre-fetch the current state of every requested task so we
        // can (a) refuse the WHOLE batch if any row is on an illegal
        // transition (no partial writes), and (b) emit a per-row
        // audit entry with the REAL fromStatus instead of the prior
        // hardcoded null.
        const existingRows = await WorkItemRepository.listByIds(db, ctx, taskIds);
        const existingMap = new Map(existingRows.map((r) => [r.id, r]));

        // First pass — all-or-nothing validation.
        for (const id of taskIds) {
            const existing = existingMap.get(id);
            if (!existing) {
                throw notFound(`Task ${id} not found`);
            }
            const fromStatus = existing.status;
            const err = checkWorkItemTransition(fromStatus, status);
            if (err) {
                throw badRequest(
                    `Cannot bulk-transition task ${id}: ${formatTransitionError(err)}`,
                );
            }

            // TP-2 — the SAME reviewer sign-off gate the single-task path
            // applies. Without this, POST /tasks/bulk/status closed a
            // reviewer-gated task while skipping IN_REVIEW and the
            // reviewer-identity check — a four-eyes bypass. Rejecting the
            // whole batch (rather than silently skipping the row) matches the
            // existing all-or-nothing contract above: a bulk close that would
            // violate sign-off is an error the caller must see, not a partial
            // success they might not notice.
            const gateViolation = checkReviewerSignOffGate({
                reviewerUserId: existing.reviewerUserId,
                fromStatus,
                toStatus: status,
                actorUserId: ctx.userId,
            });
            if (gateViolation) {
                const detail = `Cannot bulk-transition task ${id}: ${gateViolation.message}`;
                throw gateViolation.kind === 'wrong_actor'
                    ? forbidden(detail)
                    : badRequest(detail);
            }
        }

        const result = await WorkItemRepository.bulkSetStatus(db, ctx, taskIds, status, resolution);
        for (const id of taskIds) {
            // `existingMap` holds the ROW (status + reviewerUserId for the TP-2
            // gate above) — the audit entry wants just the status string.
            const fromStatus = existingMap.get(id)?.status ?? null;
            await logEvent(db, ctx, {
                action: 'TASK_STATUS_CHANGED',
                entityType: 'Task',
                entityId: id,
                details: `Bulk status changed to ${status}`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'Task',
                    fromStatus,
                    toStatus: status,
                },
                metadata: { status, resolution, bulk: true },
            });
            // TP-3 — reconcile each task's source on terminal close
            // (RESOLVED/CLOSED, not CANCELED). Same tenant transaction
            // as the bulk status write + audit.
            await reconcileTaskSource(db, ctx, id, status);
        }
        return result;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return outcome;
}

export async function bulkSetTaskDueDate(ctx: RequestContext, taskIds: string[], dueAt: string | null) {
    assertCanWriteTasks(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        const rows = await WorkItemRepository.listByIds(db, ctx, taskIds);
        if (rows.length === 0) throw notFound('No matching tasks found');
        const applied = new Set(rows.map((r) => r.id));

        const result = await WorkItemRepository.bulkSetDueDate(db, ctx, [...applied], dueAt);
        for (const id of applied) {
            await logEvent(db, ctx, {
                action: 'TASK_UPDATED',
                entityType: 'Task',
                entityId: id,
                details: `Bulk due date set to ${dueAt || 'none'}`,
                detailsJson: { category: 'entity_lifecycle', entityName: 'Task', operation: 'updated', summary: 'TASK_UPDATED' },
                metadata: { dueAt, bulk: true },
            });
        }
        return { ...result, ...bulkResults(taskIds, applied) };
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return outcome;
}

// ─── By Control ───

export async function listTasksByControl(ctx: RequestContext, controlId: string) {
    assertCanReadTasks(ctx);
    return cachedListRead({
        ctx,
        entity: 'task',
        operation: 'listByControl',
        params: { controlId },
        loader: () =>
            runInTenantContext(ctx, (db) =>
                WorkItemRepository.list(db, ctx, { controlId }),
            ),
    });
}
