import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, WorkItemStatus, WorkItemType, WorkItemSeverity, WorkItemPriority, WorkItemSource, TaskLinkEntityType, TaskLinkRelation } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import { TERMINAL_WORK_ITEM_STATUSES, isTerminalStatus } from '../domain/work-item-status';
import { badRequest } from '@/lib/errors/types';

/**
 * The set of valid `WorkItemSource` enum members, materialised once from
 * the Prisma-generated enum so validation stays in lock-step with the
 * schema without a hand-maintained list.
 */
const VALID_WORK_ITEM_SOURCES = new Set<string>(Object.values(WorkItemSource));

/**
 * Validate/normalise a caller-supplied task `source` at the write
 * boundary. A missing source defaults to MANUAL; an invalid one fails
 * LOUDLY with a 400 (never a silent Postgres enum rejection swallowed in
 * a try/catch, and never a blind `as WorkItemSource` cast that lets a
 * bogus value reach the DB). Every `createTask` path funnels through the
 * repo, so this is the single choke point that keeps the invariant true.
 */
export function normalizeWorkItemSource(source: string | null | undefined): WorkItemSource {
    if (source == null || source === '') return WorkItemSource.MANUAL;
    if (!VALID_WORK_ITEM_SOURCES.has(source)) {
        throw badRequest(
            `Invalid task source "${source}". Must be one of: ${[...VALID_WORK_ITEM_SOURCES].join(', ')}.`,
        );
    }
    return source as WorkItemSource;
}

/**
 * Parse a list filter that may arrive as a single value or as the
 * comma-joined form the UI's multi-select facets produce
 * (`?status=OPEN,BLOCKED`).
 *
 * Before this, the value was cast straight onto a Prisma enum scalar
 * (`where.status = filters.status as WorkItemStatus`), so two selected
 * values produced the literal string "OPEN,BLOCKED" — which matches no row
 * and, on some columns, fails Prisma enum validation outright. The list
 * page, its SSR path and any bookmarked URL all went through that cast, so
 * a multi-select simply returned nothing.
 *
 * Invalid members fail LOUDLY with a 400 rather than silently matching zero
 * rows — same philosophy as `normalizeWorkItemSource`.
 *
 * @returns `undefined` (no filter), the bare value (single), or `{ in: [...] }`.
 */
function parseListFilter<T extends string>(
    raw: string | undefined,
    valid: Set<string>,
    label: string,
): T | { in: T[] } | undefined {
    if (raw == null || raw === '') return undefined;
    const values = [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))];
    if (values.length === 0) return undefined;
    const bad = values.find((v) => !valid.has(v));
    if (bad) {
        throw badRequest(
            `Invalid ${label} "${bad}". Must be one of: ${[...valid].join(', ')}.`,
        );
    }
    return values.length === 1 ? (values[0] as T) : { in: values as T[] };
}

/** Same comma-joined parse for a free-form id list (no enum to validate). */
function parseIdListFilter(raw: string | undefined): string | { in: string[] } | undefined {
    if (raw == null || raw === '') return undefined;
    const values = [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))];
    if (values.length === 0) return undefined;
    return values.length === 1 ? values[0] : { in: values };
}

const VALID_WORK_ITEM_STATUSES = new Set<string>(Object.values(WorkItemStatus));
const VALID_WORK_ITEM_TYPES = new Set<string>(Object.values(WorkItemType));
const VALID_WORK_ITEM_SEVERITIES = new Set<string>(Object.values(WorkItemSeverity));
const VALID_WORK_ITEM_PRIORITIES = new Set<string>(Object.values(WorkItemPriority));

// ─── Filters ───

export interface TaskFilters {
    status?: string;
    type?: string;
    severity?: string;
    priority?: string;
    source?: string;
    assigneeUserId?: string;
    controlId?: string;
    due?: 'overdue' | 'next7d';
    q?: string;
    linkedEntityType?: string;
    linkedEntityId?: string;
}

export interface TaskListParams {
    limit?: number;
    cursor?: string;
    filters?: TaskFilters;
}

// PR-9 — tight SELECT shape for the Tasks list page. Mirrors the
// per-entity trims that PR-3 landed on the other seven list-page
// repos. The previous `include: { assignee, createdBy, _count }`
// returned all Task scalars (incl. encrypted-at-rest `description`
// and `metadataJson`) plus three `_count` correlated subqueries the
// list view never reads (the TasksClient never references
// `_count.{links,comments,watchers}`). Detail (getById) keeps the
// wider shape on purpose.
const taskListSelect = {
    id: true,
    key: true,
    title: true,
    type: true,
    severity: true,
    status: true,
    // TP-5 — the work source that raised the task (MANUAL / AUDIT /
    // POLICY_REVIEW / EVIDENCE_EXPIRY / INTEGRATION / TEMPLATE). Written on
    // create but never selected until the universal-inbox filter needed it.
    source: true,
    dueAt: true,
    createdAt: true,
    updatedAt: true,
    assigneeUserId: true,
    assignee: { select: { id: true, name: true, email: true } },
    // TP-6 — the directly-linked control (FK). Selected so the Tasks
    // list can (a) render a linked-control column and (b) populate the
    // "linked control" filter's runtime-derived options — before TP-6
    // the select omitted it, so `controlOptionsFromTasks` always read
    // `undefined` and the filter was permanently empty even though the
    // server-side `controlId` filter matched.
    controlId: true,
    control: { select: { id: true, code: true, name: true, annexId: true } },
    // Linked-evidence count — surfaced on the Controls table's inline task
    // rows (category/status/owner/evidence). One correlated subquery; the
    // three removed above (links/comments/watchers) stay removed.
    _count: { select: { evidence: true } },
} as const;

// ─── Task Repository ───

export class WorkItemRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters: TaskFilters = {},
        options: { take?: number } = {},
    ) {
        const where = WorkItemRepository._buildWhere(ctx, filters);
        return db.task.findMany({
            where,
            orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
            select: taskListSelect,
            ...(options.take ? { take: options.take } : {}),
        });
    }

    /**
     * Total + completed count of the unified tasks linked to a control,
     * using the SAME where-shape the LinkedTasksPanel list renders
     * (TaskLink with entityType=CONTROL OR the direct `Task.controlId`
     * FK). Backs the control header's Tasks-tab badge + Overview
     * progress so they reflect the table — not the legacy `ControlTask`
     * relation count, which diverged after the work-item unification.
     *
     * "Completed" is RESOLVED or CLOSED (a CANCELED task is terminal but
     * not completed work, so it doesn't count toward progress).
     */
    static async countLinkedToControl(
        db: PrismaTx,
        ctx: RequestContext,
        controlId: string,
    ): Promise<{ total: number; done: number }> {
        const where = WorkItemRepository._buildWhere(ctx, {
            linkedEntityType: 'CONTROL',
            linkedEntityId: controlId,
        });
        const [total, done] = await Promise.all([
            db.task.count({ where }),
            db.task.count({
                where: { AND: [where, { status: { in: ['RESOLVED', 'CLOSED'] } }] },
            }),
        ]);
        return { total, done };
    }

    /**
     * Batched version of `countLinkedToControl` for the controls LIST.
     * Returns a `controlId → { total, done }` map using the SAME
     * linkage rule (TaskLink with entityType=CONTROL OR the direct
     * `Task.controlId` FK), deduped by task id so a task linked BOTH
     * ways counts once. Two indexed queries — NOT an N+1 over controls
     * — so the list-page Tasks column reflects the real linked-task
     * count instead of the legacy `ControlTask` relation (which read
     * 0/0 for unified tasks).
     */
    static async countLinkedToControls(
        db: PrismaTx,
        ctx: RequestContext,
        controlIds: string[],
    ): Promise<Map<string, { total: number; done: number }>> {
        const result = new Map<string, { total: number; done: number }>();
        if (controlIds.length === 0) return result;

        // controlId → (taskId → status). The inner map dedupes a task
        // that is linked to the same control via both paths.
        const perControl = new Map<string, Map<string, string>>();
        const add = (controlId: string, taskId: string, status: string) => {
            let m = perControl.get(controlId);
            if (!m) {
                m = new Map();
                perControl.set(controlId, m);
            }
            m.set(taskId, status);
        };

        // Direct FK. Bounded by controlIds; counting needs every match.
        const direct = await db.task.findMany({ // guardrail-allow: unbounded -- aggregate count, bounded by the controlIds set
            where: { tenantId: ctx.tenantId, controlId: { in: controlIds } },
            select: { id: true, controlId: true, status: true },
        });
        for (const t of direct) {
            if (t.controlId) add(t.controlId, t.id, t.status);
        }

        // Generic TaskLink path (the control-tab create flow links via
        // TaskLink, not the FK). Indexed by [tenantId, entityType, entityId].
        const links = await db.taskLink.findMany({ // guardrail-allow: unbounded -- aggregate count, bounded by the controlIds set
            where: {
                tenantId: ctx.tenantId,
                entityType: 'CONTROL' as TaskLinkEntityType,
                entityId: { in: controlIds },
            },
            select: {
                entityId: true,
                taskId: true,
                task: { select: { status: true } },
            },
        });
        for (const l of links) {
            add(l.entityId, l.taskId, l.task.status);
        }

        for (const [controlId, taskMap] of perControl) {
            let done = 0;
            for (const status of taskMap.values()) {
                if (status === 'RESOLVED' || status === 'CLOSED') done++;
            }
            result.set(controlId, { total: taskMap.size, done });
        }
        return result;
    }

    /**
     * B7 (2026-06-07) — generic batched linked-task counter for entities
     * that link tasks ONLY via TaskLink (no direct FK) — Asset, Risk, … .
     * Returns an `entityId → { total, done }` map. ONE indexed query over
     * [tenantId, entityType, entityId]; NOT an N+1 over the entity list.
     * (Controls carry an extra direct-`Task.controlId` FK path, so they keep
     * their own `countLinkedToControls`.) `done` = RESOLVED|CLOSED, matching
     * the controls column.
     */
    static async countLinkedToEntities(
        db: PrismaTx,
        ctx: RequestContext,
        entityType: TaskLinkEntityType,
        entityIds: string[],
    ): Promise<Map<string, { total: number; done: number }>> {
        const result = new Map<string, { total: number; done: number }>();
        if (entityIds.length === 0) return result;

        // entityId → (taskId → status), dedup by task id.
        const perEntity = new Map<string, Map<string, string>>();
        const links = await db.taskLink.findMany({ // guardrail-allow: unbounded -- aggregate count, bounded by the entityIds set
            where: {
                tenantId: ctx.tenantId,
                entityType,
                entityId: { in: entityIds },
            },
            select: {
                entityId: true,
                taskId: true,
                task: { select: { status: true } },
            },
        });
        for (const l of links) {
            let m = perEntity.get(l.entityId);
            if (!m) {
                m = new Map();
                perEntity.set(l.entityId, m);
            }
            m.set(l.taskId, l.task.status);
        }
        for (const [entityId, taskMap] of perEntity) {
            let done = 0;
            for (const status of taskMap.values()) {
                if (status === 'RESOLVED' || status === 'CLOSED') done++;
            }
            result.set(entityId, { total: taskMap.size, done });
        }
        return result;
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: TaskListParams): Promise<PaginatedResponse<unknown>> {
        const limit = clampLimit(params.limit);
        const where = WorkItemRepository._buildWhere(ctx, params.filters);

        const cursorWhere = buildCursorWhere(params.cursor);
        if (cursorWhere) {
            if (where.AND) {
                (where.AND as Prisma.TaskWhereInput[]).push(cursorWhere as Prisma.TaskWhereInput);
            } else {
                where.AND = [cursorWhere as Prisma.TaskWhereInput];
            }
        }

        const items = await db.task.findMany({
            where,
            orderBy: CURSOR_ORDER_BY,
            take: limit + 1,
            select: taskListSelect,
        });

        const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
        return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
    }

    private static _buildWhere(ctx: RequestContext, filters: TaskFilters = {}): Prisma.TaskWhereInput {
        const where: Prisma.TaskWhereInput = { tenantId: ctx.tenantId };
        const and: Prisma.TaskWhereInput[] = [];

        // Each of these facets is declared `multiple: true` in the UI's
        // filter-defs, so the value can arrive comma-joined.
        const status = parseListFilter<WorkItemStatus>(filters.status, VALID_WORK_ITEM_STATUSES, 'status');
        const type = parseListFilter<WorkItemType>(filters.type, VALID_WORK_ITEM_TYPES, 'type');
        const severity = parseListFilter<WorkItemSeverity>(filters.severity, VALID_WORK_ITEM_SEVERITIES, 'severity');
        const priority = parseListFilter<WorkItemPriority>(filters.priority, VALID_WORK_ITEM_PRIORITIES, 'priority');
        const source = parseListFilter<WorkItemSource>(filters.source, VALID_WORK_ITEM_SOURCES, 'source');
        const assignee = parseIdListFilter(filters.assigneeUserId);
        if (status !== undefined) where.status = status;
        if (type !== undefined) where.type = type;
        if (severity !== undefined) where.severity = severity;
        if (priority !== undefined) where.priority = priority;
        if (source !== undefined) where.source = source;
        if (assignee !== undefined) where.assigneeUserId = assignee;
        if (filters.controlId) where.controlId = filters.controlId;
        if (filters.due === 'overdue') {
            where.dueAt = { lt: new Date() };
            if (!filters.status) where.status = { notIn: [...TERMINAL_WORK_ITEM_STATUSES] as WorkItemStatus[] };
        } else if (filters.due === 'next7d') {
            const now = new Date();
            const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
            where.dueAt = { gte: now, lte: in7 };
            if (!filters.status) where.status = { notIn: [...TERMINAL_WORK_ITEM_STATUSES] as WorkItemStatus[] };
        }
        if (filters.q) {
            and.push({
                OR: [
                    { title: { contains: filters.q, mode: 'insensitive' } },
                    { key: { contains: filters.q, mode: 'insensitive' } },
                ],
            });
        }
        if (filters.linkedEntityType && filters.linkedEntityId) {
            const viaLink: Prisma.TaskWhereInput = {
                links: {
                    some: {
                        entityType: filters.linkedEntityType as TaskLinkEntityType,
                        entityId: filters.linkedEntityId,
                    },
                },
            };
            if (filters.linkedEntityType === 'CONTROL') {
                // A task is linked to a control via EITHER the generic
                // TaskLink OR the direct `Task.controlId` FK. The latter
                // is what pack install and the task-create form set, and
                // it's what the task's OWN view shows as its linked
                // control — so the control's Tasks tab must mirror it.
                // Without this, pack-installed tasks (controlId set, no
                // TaskLink row) never appear in the control's Tasks tab.
                and.push({
                    OR: [viaLink, { controlId: filters.linkedEntityId }],
                });
            } else {
                and.push(viaLink);
            }
        }

        if (and.length) where.AND = and;
        return where;
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.task.findFirst({
            where: { id, tenantId: ctx.tenantId },
            include: {
                assignee: { select: { id: true, name: true, email: true } },
                createdBy: { select: { id: true, name: true, email: true } },
                reviewer: { select: { id: true, name: true, email: true } },
                control: { select: { id: true, code: true, name: true } },
                // TP-4 — the source that raised an auto-task, so the
                // detail page can render a navigable back-link + a
                // plain-language "why this task exists" banner.
                finding: { select: { id: true, title: true, status: true } },
                remediatedVulnerabilities: {
                    take: 25,
                    select: {
                        id: true,
                        cveId: true,
                        status: true,
                        asset: { select: { id: true, name: true } },
                    },
                },
                links: { orderBy: { createdAt: 'desc' } },
                comments: {
                    orderBy: { createdAt: 'asc' },
                    include: { createdBy: { select: { id: true, name: true, email: true } } },
                },
                watchers: {
                    include: { user: { select: { id: true, name: true, email: true } } },
                },
                _count: { select: { links: true, comments: true, watchers: true, evidence: true } },
            },
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: {
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
        // #102 item 2 — mint the `TSK-N` key from an atomic
        // per-tenant counter. The upsert compiles to a native
        // `INSERT … ON CONFLICT DO UPDATE`, so the increment is
        // race-free even under concurrent imports — unlike the
        // prior `db.task.count()` derivation, which raced the
        // unique `[tenantId, key]` index and scaled linearly with
        // tenant size.
        const seq = await db.taskKeySequence.upsert({
            where: { tenantId: ctx.tenantId },
            create: { tenantId: ctx.tenantId, lastValue: 1 },
            update: { lastValue: { increment: 1 } },
        });
        const key = `TSK-${seq.lastValue}`;

        return db.task.create({
            data: {
                tenantId: ctx.tenantId,
                key,
                title: data.title,
                description: data.description || null,
                type: (data.type as WorkItemType) ?? WorkItemType.TASK,
                severity: (data.severity as WorkItemSeverity) ?? WorkItemSeverity.MEDIUM,
                priority: (data.priority as WorkItemPriority) ?? WorkItemPriority.P2,
                source: normalizeWorkItemSource(data.source),
                dueAt: data.dueAt ? new Date(data.dueAt) : null,
                assigneeUserId: data.assigneeUserId || null,
                reviewerUserId: data.reviewerUserId || null,
                controlId: data.controlId || null,
                findingId: data.findingId || null,
                createdByUserId: ctx.userId,
                metadataJson: data.metadataJson != null ? (data.metadataJson as Prisma.InputJsonValue) : Prisma.JsonNull,
            },
            include: {
                assignee: { select: { id: true, name: true, email: true } },
                createdBy: { select: { id: true, name: true, email: true } },
            },
        });
    }

    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: {
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
        const existing = await db.task.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!existing) return null;

        const updateData: Prisma.TaskUncheckedUpdateInput = {
            ...(data.title !== undefined && { title: data.title }),
            ...(data.description !== undefined && { description: data.description }),
            ...(data.type !== undefined && { type: data.type as WorkItemType }),
            ...(data.severity !== undefined && { severity: data.severity as WorkItemSeverity }),
            ...(data.priority !== undefined && { priority: data.priority as WorkItemPriority }),
            ...(data.dueAt !== undefined && { dueAt: data.dueAt ? new Date(data.dueAt) : null }),
            ...(data.controlId !== undefined && { controlId: data.controlId }),
            ...(data.reviewerUserId !== undefined && { reviewerUserId: data.reviewerUserId }),
            ...(data.metadataJson !== undefined && { metadataJson: data.metadataJson != null ? (data.metadataJson as Prisma.InputJsonValue) : Prisma.JsonNull }),
        };
        return db.task.update({ where: { id }, data: updateData });
    }

    static async setStatus(db: PrismaTx, ctx: RequestContext, id: string, status: string, resolution?: string | null) {
        const existing = await db.task.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!existing) return null;

        const updateData: Prisma.TaskUncheckedUpdateInput = { status: status as WorkItemStatus };
        if (isTerminalStatus(status)) {
            updateData.completedAt = new Date();
            if (resolution !== undefined) updateData.resolution = resolution;
        } else {
            updateData.completedAt = null;
        }

        return db.task.update({ where: { id }, data: updateData });
    }

    static async assign(db: PrismaTx, ctx: RequestContext, id: string, assigneeUserId: string | null) {
        const existing = await db.task.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!existing) return null;

        return db.task.update({
            where: { id },
            data: { assigneeUserId },
            include: { assignee: { select: { id: true, name: true, email: true } } },
        });
    }

    // ─── Metrics ───

    static async metrics(db: PrismaTx, ctx: RequestContext) {
        const tenantId = ctx.tenantId;
        const now = new Date();
        const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        const openFilter = { notIn: [...TERMINAL_WORK_ITEM_STATUSES] as WorkItemStatus[] };

        const [byStatus, overdueCount, due7dCount, total] = await Promise.all([
            db.task.groupBy({ by: ['status'], where: { tenantId }, _count: true }),
            db.task.count({ where: { tenantId, dueAt: { lt: now }, status: openFilter } }),
            db.task.count({ where: { tenantId, dueAt: { gte: now, lte: in7d }, status: openFilter } }),
            db.task.count({ where: { tenantId } }),
        ]);

        // NB `topControls` (open tasks per control) + `topLinkedEntities`
        // (open tasks per ASSET/RISK link) were computed here — 1 groupBy +
        // 1 findMany, and 1 groupBy respectively — but NO surface ever read
        // them, so the four queries ran on every tasks-list load for nothing.
        // Trimmed. A "top controls by open tasks" widget is a worthwhile
        // follow-up; the aggregation can be re-added cheaply when a consumer
        // exists (see 2026-07-17-task-surface-defects impl note).
        //
        // Same treatment applied to `bySeverity`, `byType`, `dueIn30d` and
        // `trend` (created30d / resolved30d): computed on every tasks-list
        // load, read by nothing. The KPI strip renders total / byStatus.OPEN /
        // overdue / dueIn7d, and the sparklines come from the separate
        // /dashboard/trends endpoint — so those five extra queries (2 groupBy
        // + 3 count) were pure cost. Re-add per field WITH its consumer.

        return {
            total,
            byStatus: Object.fromEntries(byStatus.map(r => [r.status, r._count])),
            overdue: overdueCount,
            dueIn7d: due7dCount,
        };
    }

    // ─── Bulk ───

    /**
     * Audit Coherence S8 (2026-05-24) — fetch the current
     * status of a known set of task ids in ONE query so the bulk
     * status-change path can validate every transition before any
     * row is written. Empty input returns []; ids missing from the
     * result imply "not in tenant / soft-deleted" — the caller
     * surfaces a notFound rather than silently skipping.
     */
    static async listByIds(db: PrismaTx, ctx: RequestContext, taskIds: string[]) {
        if (taskIds.length === 0) return [];
        // Bounded by request payload size (taskIds.length); the bulk
        // endpoint enforces a max batch size upstream, so this is
        // structurally bounded without a `take:` literal.
        return db.task.findMany({ // guardrail-allow: unbounded
            where: {
                id: { in: taskIds },
                tenantId: ctx.tenantId,
                deletedAt: null,
            },
            // `reviewerUserId` is selected because the BULK status path must
            // apply the same reviewer sign-off gate the single-task path does
            // (TP-2) — without it, /tasks/bulk/status was an escape hatch.
            select: { id: true, status: true, reviewerUserId: true },
        });
    }

    static async bulkAssign(db: PrismaTx, ctx: RequestContext, taskIds: string[], assigneeUserId: string | null) {
        return db.task.updateMany({
            where: { id: { in: taskIds }, tenantId: ctx.tenantId },
            data: { assigneeUserId },
        });
    }

    static async bulkSetStatus(db: PrismaTx, ctx: RequestContext, taskIds: string[], status: string, resolution?: string | null) {
        const updateData: Prisma.TaskUncheckedUpdateManyInput = { status: status as WorkItemStatus };
        if (isTerminalStatus(status)) {
            updateData.completedAt = new Date();
            if (resolution !== undefined) updateData.resolution = resolution;
        }
        return db.task.updateMany({
            where: { id: { in: taskIds }, tenantId: ctx.tenantId },
            data: updateData,
        });
    }

    static async bulkSetDueDate(db: PrismaTx, ctx: RequestContext, taskIds: string[], dueAt: string | null) {
        return db.task.updateMany({
            where: { id: { in: taskIds }, tenantId: ctx.tenantId },
            data: { dueAt: dueAt ? new Date(dueAt) : null },
        });
    }
}

// ─── TaskLink Repository ───

/**
 * TP-4 — a resolved task-link row: the raw link plus the linked
 * entity's human display name + a tenant-relative detail path (null
 * when the entity type has no detail route, or the entity is gone).
 */
export interface ResolvedTaskLink {
    id: string;
    entityType: string;
    entityId: string;
    relation: string | null;
    createdAt: Date;
    /** Human display name; null when the entity could not be resolved. */
    name: string | null;
    /** Tenant-relative detail path (e.g. `/controls/x`); null if none. */
    path: string | null;
}

export class TaskLinkRepository {
    static async listByTask(db: PrismaTx, ctx: RequestContext, taskId: string) {
        return db.taskLink.findMany({
            where: { taskId, tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * TP-4 — list a task's links AND resolve each linked entity's
     * display name + detail path. One bounded query PER entity type
     * (`id: { in: [...] }`), never per row — no N+1. Entities that no
     * longer exist resolve to `{ name: null, path: null }` and the UI
     * falls back to the raw id.
     */
    static async listByTaskResolved(
        db: PrismaTx,
        ctx: RequestContext,
        taskId: string,
    ): Promise<ResolvedTaskLink[]> {
        const links = await db.taskLink.findMany({
            where: { taskId, tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
        });
        if (links.length === 0) return [];

        // Bucket entity ids by type so each type resolves in one query.
        const idsByType = new Map<string, string[]>();
        for (const l of links) {
            const bucket = idsByType.get(l.entityType) ?? [];
            bucket.push(l.entityId);
            idsByType.set(l.entityType, bucket);
        }
        const tid = ctx.tenantId;
        // `${type}:${id}` → { name, path }. Populated by the explicit
        // per-type blocks below (NO Prisma read inside a loop).
        const resolved = new Map<string, { name: string; path: string | null }>();
        const put = (type: string, id: string, name: string, path: string | null) =>
            resolved.set(`${type}:${id}`, { name, path });

        const controlIds = idsByType.get('CONTROL');
        if (controlIds?.length) {
            const rows = await db.control.findMany({ // guardrail-allow: unbounded (bounded by primary-key `in:` list — a task's links)
                where: { id: { in: controlIds }, tenantId: tid },
                select: { id: true, code: true, name: true },
            });
            for (const r of rows) put('CONTROL', r.id, r.code ? `${r.code} — ${r.name}` : r.name, `/controls/${r.id}`);
        }
        const riskIds = idsByType.get('RISK');
        if (riskIds?.length) {
            const rows = await db.risk.findMany({ // guardrail-allow: unbounded (bounded by primary-key `in:` list — a task's links)
                where: { id: { in: riskIds }, tenantId: tid },
                select: { id: true, key: true, title: true },
            });
            for (const r of rows) put('RISK', r.id, r.key ? `${r.key} — ${r.title}` : r.title, `/risks/${r.id}`);
        }
        const assetIds = idsByType.get('ASSET');
        if (assetIds?.length) {
            const rows = await db.asset.findMany({ // guardrail-allow: unbounded (bounded by primary-key `in:` list — a task's links)
                where: { id: { in: assetIds }, tenantId: tid },
                select: { id: true, name: true },
            });
            for (const r of rows) put('ASSET', r.id, r.name, `/assets/${r.id}`);
        }
        const policyIds = idsByType.get('POLICY');
        if (policyIds?.length) {
            const rows = await db.policy.findMany({ // guardrail-allow: unbounded (bounded by primary-key `in:` list — a task's links)
                where: { id: { in: policyIds }, tenantId: tid },
                select: { id: true, title: true },
            });
            for (const r of rows) put('POLICY', r.id, r.title, `/policies/${r.id}`);
        }
        const vendorIds = idsByType.get('VENDOR');
        if (vendorIds?.length) {
            const rows = await db.vendor.findMany({ // guardrail-allow: unbounded (bounded by primary-key `in:` list — a task's links)
                where: { id: { in: vendorIds }, tenantId: tid },
                select: { id: true, name: true },
            });
            for (const r of rows) put('VENDOR', r.id, r.name, `/vendors/${r.id}`);
        }
        const evidenceIds = idsByType.get('EVIDENCE');
        if (evidenceIds?.length) {
            const rows = await db.evidence.findMany({ // guardrail-allow: unbounded (bounded by primary-key `in:` list — a task's links)
                where: { id: { in: evidenceIds }, tenantId: tid },
                select: { id: true, title: true },
            });
            // Evidence has no per-item detail route — name only.
            for (const r of rows) put('EVIDENCE', r.id, r.title, null);
        }
        const incidentIds = idsByType.get('INCIDENT');
        if (incidentIds?.length) {
            const rows = await db.incident.findMany({ // guardrail-allow: unbounded (bounded by primary-key `in:` list — a task's links)
                where: { id: { in: incidentIds }, tenantId: tid },
                select: { id: true, reference: true, title: true },
            });
            for (const r of rows) put('INCIDENT', r.id, r.reference ? `${r.reference} — ${r.title}` : r.title, `/incidents/${r.id}`);
        }
        const fileIds = idsByType.get('FILE');
        if (fileIds?.length) {
            const rows = await db.fileRecord.findMany({ // guardrail-allow: unbounded (bounded by primary-key `in:` list — a task's links)
                where: { id: { in: fileIds }, tenantId: tid },
                select: { id: true, originalName: true },
            });
            // Files have no standalone detail route — name only.
            for (const r of rows) put('FILE', r.id, r.originalName, null);
        }
        const auditPackIds = idsByType.get('AUDIT_PACK');
        if (auditPackIds?.length) {
            const rows = await db.auditPack.findMany({ // guardrail-allow: unbounded (bounded by primary-key `in:` list — a task's links)
                where: { id: { in: auditPackIds }, tenantId: tid },
                select: { id: true, name: true },
            });
            // Audit packs have no standalone tenant detail route — name only.
            for (const r of rows) put('AUDIT_PACK', r.id, r.name, null);
        }
        const reqIds = idsByType.get('FRAMEWORK_REQUIREMENT');
        if (reqIds?.length) {
            const rows = await db.frameworkRequirement.findMany({ // guardrail-allow: unbounded (bounded by primary-key `in:` list — a task's links)
                where: { id: { in: reqIds } },
                select: { id: true, code: true, title: true, framework: { select: { key: true } } },
            });
            for (const r of rows) put('FRAMEWORK_REQUIREMENT', r.id, `${r.code} — ${r.title}`, r.framework?.key ? `/frameworks/${r.framework.key}` : null);
        }

        return links.map((l) => {
            const hit = resolved.get(`${l.entityType}:${l.entityId}`);
            return {
                id: l.id,
                entityType: l.entityType,
                entityId: l.entityId,
                relation: l.relation,
                createdAt: l.createdAt,
                name: hit?.name ?? null,
                path: hit?.path ?? null,
            };
        });
    }

    static async link(db: PrismaTx, ctx: RequestContext, taskId: string, entityType: string, entityId: string, relation?: string) {
        return db.taskLink.create({
            data: {
                tenantId: ctx.tenantId,
                taskId,
                entityType: entityType as TaskLinkEntityType,
                entityId,
                relation: (relation as TaskLinkRelation) ?? TaskLinkRelation.RELATES_TO,
            },
        });
    }

    /**
     * Remove one link, scoped to BOTH the tenant and the owning task.
     * Without the `taskId` predicate any link in the tenant could be
     * deleted from any task's URL, since the route's `taskId` param was
     * accepted and then ignored.
     */
    static async unlink(
        db: PrismaTx,
        ctx: RequestContext,
        taskId: string,
        linkId: string,
    ) {
        const link = await db.taskLink.findFirst({
            where: { id: linkId, taskId, tenantId: ctx.tenantId },
        });
        if (!link) return null;
        await db.taskLink.delete({ where: { id: linkId } });
        return true;
    }
}

// ─── TaskComment Repository ───

export class TaskCommentRepository {
    static async listByTask(db: PrismaTx, ctx: RequestContext, taskId: string) {
        return db.taskComment.findMany({
            where: { taskId, tenantId: ctx.tenantId },
            orderBy: { createdAt: 'asc' },
            include: { createdBy: { select: { id: true, name: true, email: true } } },
        });
    }

    static async add(db: PrismaTx, ctx: RequestContext, taskId: string, body: string) {
        return db.taskComment.create({
            data: {
                tenantId: ctx.tenantId,
                taskId,
                body,
                createdByUserId: ctx.userId,
            },
            include: { createdBy: { select: { id: true, name: true, email: true } } },
        });
    }
}

// ─── TaskWatcher Repository ───

export class TaskWatcherRepository {
    static async listByTask(db: PrismaTx, ctx: RequestContext, taskId: string) {
        return db.taskWatcher.findMany({
            where: { taskId, tenantId: ctx.tenantId },
            include: { user: { select: { id: true, name: true, email: true } } },
        });
    }

    static async add(db: PrismaTx, ctx: RequestContext, taskId: string, userId: string) {
        return db.taskWatcher.create({
            data: { tenantId: ctx.tenantId, taskId, userId },
            include: { user: { select: { id: true, name: true, email: true } } },
        });
    }

    static async remove(db: PrismaTx, ctx: RequestContext, taskId: string, userId: string) {
        const watcher = await db.taskWatcher.findFirst({ where: { taskId, userId, tenantId: ctx.tenantId } });
        if (!watcher) return null;
        await db.taskWatcher.delete({ where: { id: watcher.id } });
        return true;
    }
}
