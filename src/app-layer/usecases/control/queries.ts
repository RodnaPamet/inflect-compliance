import { RequestContext } from '../../types';
import { ControlRepository, type ControlListFilters } from '../../repositories/ControlRepository';
import { getControlHealthVerdicts } from './health';
import { WorkItemRepository } from '../../repositories/WorkItemRepository';
import { assertCanReadControls } from '../../policies/control.policies';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext, runInTenantReadContext } from '@/lib/db-context';
import { assertCanAdmin } from '../../policies/common';
import { withDeleted } from '@/lib/soft-delete';
import { cachedListRead } from '@/lib/cache/list-cache';
import { TERMINAL_WORK_ITEM_STATUSES } from '../../domain/work-item-status';
import type { WorkItemStatus } from '@prisma/client';

// Non-terminal (active) work-item statuses — the unified-Task equivalent of
// the legacy `status != 'DONE'` predicate the ControlTask dashboard used.
const OPEN_TASK_STATUS_FILTER = {
    notIn: [...TERMINAL_WORK_ITEM_STATUSES] as WorkItemStatus[],
} as const;

// Safety cap on the tenant-wide control/task scans used by the admin
// dashboard, the consistency check, and the recycle-bin view. These are
// aggregate/admin reads that intentionally scan the whole tenant, so they
// can't paginate — the cap is a latency/memory guard against a pathological
// tenant rather than a page size. Mirrors the health-scan cap
// (`HEALTH_VERDICT_SCAN_CAP` in ./health): a tenant with more controls than
// this is beyond any real deployment, and the cap keeps an unbounded scan
// from becoming a cliff.
const FULL_SCAN_CAP = 5000;

// ─── Queries ───

/** Filters the controls list read accepts at the usecase boundary (URL-shaped:
 *  `ids` is a comma-separated string, `health` a verdict). The usecase resolves
 *  `ids`/`health` into a concrete `ControlListFilters.ids` array for the repo. */
export interface ControlListInputFilters {
    status?: string; applicability?: string; ownerUserId?: string; q?: string;
    /** Comma-separated control ids (consistency `?ids=` deep-link). */
    ids?: string;
    /** Health verdict facet — resolved server-side to the matching control ids. */
    health?: string;
}

/**
 * Resolve the id-restriction inputs (`ids` deep-link + `health` verdict facet)
 * to a concrete control-id array for `_buildWhere`. Returns `undefined` when
 * NEITHER is requested (no restriction); returns `[]` when a facet WAS requested
 * but matched nothing (→ zero rows, never "all rows").
 */
async function resolveControlIdRestriction(
    ctx: RequestContext,
    filters?: ControlListInputFilters,
): Promise<string[] | undefined> {
    let ids: string[] | undefined;
    if (filters?.ids !== undefined) {
        ids = filters.ids.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (filters?.health) {
        const { verdicts } = await getControlHealthVerdicts(ctx);
        const healthIds = verdicts.filter((v) => v.verdict === filters.health).map((v) => v.controlId);
        if (ids) {
            // O(1) membership test instead of Array.includes (O(n)) — the
            // health-verdict id set can be large (up to HEALTH_VERDICT_SCAN_CAP).
            const healthIdSet = new Set(healthIds);
            ids = ids.filter((id) => healthIdSet.has(id));
        } else {
            ids = healthIds;
        }
    }
    return ids;
}

/** Strip the URL-shaped `ids`/`health` inputs down to the repo filter shape,
 *  substituting the resolved id array. */
function toRepoFilters(filters: ControlListInputFilters | undefined, ids: string[] | undefined): ControlListFilters | undefined {
    if (!filters) return undefined;
    return {
        status: filters.status, applicability: filters.applicability,
        ownerUserId: filters.ownerUserId, q: filters.q, ids,
    };
}

export async function listControls(
    ctx: RequestContext,
    filters?: ControlListInputFilters,
    options: { take?: number } = {},
) {
    assertCanReadControls(ctx);
    return cachedListRead({
        ctx,
        entity: 'control',
        operation: 'list',
        // `take` participates in the cache key so a bounded SSR
        // result can't poison the unbounded API GET cache (mirrors
        // the PR #146 Tasks pattern). The RAW url-shaped filters (small
        // `health`/`ids` strings) form the key — not the resolved id array.
        params: options.take
            ? { ...(filters ?? {}), _take: options.take }
            : (filters ?? {}),
        // Resolve the id-restriction INSIDE the loader so a cache HIT never
        // pays for the (potentially expensive, 5000-row + groupBy) health-
        // verdict scan that `?health=` triggers. The resolution runs BEFORE —
        // not nested inside — the tenant transaction below, so
        // `getControlHealthVerdicts` opens its own context sequentially (no
        // nested runInTenantContext). The cache key uses the raw filters, so
        // moving resolution here does not change caching semantics.
        loader: async () => {
            const idRestriction = await resolveControlIdRestriction(ctx, filters);
            const repoFilters = toRepoFilters(filters, idRestriction);
            return runInTenantContext(ctx, async (db) => {
                const controls = await ControlRepository.list(
                    db,
                    ctx,
                    repoFilters,
                    options,
                );
                // Attach the unified linked-task counts (TaskLink CONTROL
                // link OR the controlId FK) so the list-page Tasks column
                // matches the control's Tasks tab — the legacy
                // `_count.controlTasks` read 0/0 for unified tasks.
                const counts = await WorkItemRepository.countLinkedToControls(
                    db,
                    ctx,
                    controls.map((c) => c.id),
                );
                return controls.map((c) => ({
                    ...c,
                    taskTotal: counts.get(c.id)?.total ?? 0,
                    taskDone: counts.get(c.id)?.done ?? 0,
                }));
            });
        },
    });
}

export async function listControlsPaginated(ctx: RequestContext, params: {
    limit?: number; cursor?: string;
    filters?: ControlListInputFilters;
}) {
    assertCanReadControls(ctx);
    return cachedListRead({
        ctx,
        entity: 'control',
        operation: 'listPaginated',
        // Cache key stays the RAW url-shaped filters (small); the loader uses the
        // resolved id array.
        params,
        // Resolve inside the loader so a cache HIT skips the health-verdict scan
        // (see listControls). Sequential — not nested — tenant contexts.
        loader: async () => {
            const idRestriction = await resolveControlIdRestriction(ctx, params.filters);
            const repoParams = { ...params, filters: toRepoFilters(params.filters, idRestriction) };
            return runInTenantContext(ctx, (db) =>
                ControlRepository.listPaginated(db, ctx, repoParams),
            );
        },
    });
}

export async function getControl(ctx: RequestContext, id: string) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, async (db) => {
        const control = await ControlRepository.getById(db, ctx, id);
        if (!control) throw notFound('Control not found');
        return control;
    });
}

/**
 * Header-only control read (#102 item 1 — tab-lazy refactor).
 *
 * Returns the control scalars + user refs + `contributors` + a
 * `_count` of the four tabbed relations, without their arrays. The
 * detail page renders the Overview tab + header from this; the
 * Tasks / Evidence / Mappings tabs fetch their own data on demand.
 *
 * `doneControlTasks` is the one derived extra: `_count.controlTasks`
 * gives the total, but the Overview "Tasks Progress" widget also
 * needs the DONE count — a relation `_count` can't carry both a
 * total and a filtered count for the same relation, so it ships as
 * a separate field. The `[tenantId, controlId, status]` index added
 * in #102 item 4 covers this count.
 */
export async function getControlHeader(ctx: RequestContext, id: string) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, async (db) => {
        const control = await ControlRepository.getHeaderById(db, ctx, id);
        if (!control) throw notFound('Control not found');
        // The Tasks tab badge + Overview "Tasks Progress" must reflect
        // the unified Task rows the LinkedTasksPanel actually renders
        // (TaskLink CONTROL link OR the direct controlId FK), NOT the
        // legacy `ControlTask` relation — which `_count.controlTasks`
        // and the old `controlTask.count` measured. Those diverged from
        // the table after the work-item unification (#806).
        const linkedTasks = await WorkItemRepository.countLinkedToControl(
            db,
            ctx,
            id,
        );
        return {
            ...control,
            // Override the legacy relation counts so the badges match the
            // tables the tabs render, without churning the page's read path:
            //  • controlTasks  → unified linked-Task total
            //  • frameworkMappings → canonical controlRequirementLink count
            //    (the Mappings tab now reads controlRequirementLink)
            _count: {
                ...control._count,
                controlTasks: linkedTasks.total,
                frameworkMappings: control._count.requirementLinks,
            },
            doneControlTasks: linkedTasks.done,
        };
    });
}

// ─── Activity Trail ───

export async function getControlActivity(ctx: RequestContext, controlId: string) {
    assertCanReadControls(ctx);

    return runInTenantContext(ctx, async (db) => {
        const control = await ControlRepository.getById(db, ctx, controlId);
        if (!control) throw notFound('Control not found');

        return db.auditLog.findMany({
            where: { tenantId: ctx.tenantId, entity: 'Control', entityId: controlId },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: { user: { select: { id: true, name: true } } },
        });
    });
}

// ─── Dashboard Metrics ───

export async function getControlDashboard(ctx: RequestContext) {
    assertCanReadControls(ctx);

    return runInTenantReadContext(ctx, async (db) => {
        const now = new Date();
        const soonThreshold = new Date(now);
        soonThreshold.setDate(soonThreshold.getDate() + 30);

        // #102 item 3 — the dashboard used to `findMany` every control
        // WITH its full `controlTasks` array (plus an unused `_count`)
        // and reduce in JS — loading the whole control × task graph
        // for the tenant to produce a handful of counts. It is now a
        // fan-out of indexed aggregate queries; each touches only the
        // columns it needs.
        const [
            statusGroups,
            applicabilityGroups,
            implementedCount,
            controlsDueSoon,
            overdueTasks,
            openTasksByControl,
            controlOwners,
        ] = await Promise.all([
            db.control.groupBy({
                by: ['status'],
                where: { tenantId: ctx.tenantId },
                _count: { _all: true },
            }),
            db.control.groupBy({
                by: ['applicability'],
                where: { tenantId: ctx.tenantId },
                _count: { _all: true },
            }),
            db.control.count({
                where: {
                    tenantId: ctx.tenantId,
                    applicability: 'APPLICABLE',
                    status: 'IMPLEMENTED',
                },
            }),
            db.control.count({
                where: {
                    tenantId: ctx.tenantId,
                    applicability: 'APPLICABLE',
                    nextDueAt: { not: null, lte: soonThreshold },
                },
            }),
            // Overdue = open (non-terminal) unified Task past its due date.
            // Scoped to tasks that carry the direct `controlId` FK so the
            // control dashboard counts control-attached work.
            db.task.count({
                where: {
                    tenantId: ctx.tenantId,
                    controlId: { not: null },
                    status: OPEN_TASK_STATUS_FILTER,
                    dueAt: { not: null, lt: now },
                },
            }),
            // Open tasks per control. Prisma can't group Task by
            // Control.ownerUserId directly (cross-relation), so we
            // group by controlId and fold into owners in JS over the
            // thin control → owner projection below.
            db.task.groupBy({
                by: ['controlId'],
                where: {
                    tenantId: ctx.tenantId,
                    controlId: { not: null },
                    status: OPEN_TASK_STATUS_FILTER,
                },
                _count: { _all: true },
            }),
            db.control.findMany({
                where: { tenantId: ctx.tenantId },
                select: {
                    id: true,
                    owner: { select: { id: true, name: true } },
                },
                take: FULL_SCAN_CAP,
            }),
        ]);

        // Status distribution → Record<status, count>; total folds out.
        const statusDistribution: Record<string, number> = {};
        let totalControls = 0;
        for (const g of statusGroups) {
            statusDistribution[g.status] = g._count._all;
            totalControls += g._count._all;
        }

        // Applicability distribution.
        const applicabilityOf = (value: string) =>
            applicabilityGroups.find(g => g.applicability === value)?._count._all ?? 0;
        const applicableCount = applicabilityOf('APPLICABLE');
        const notApplicableCount = applicabilityOf('NOT_APPLICABLE');

        // Top owners — fold per-control open-task counts into owners.
        const openByControl = new Map<string, number>();
        for (const row of openTasksByControl) {
            if (row.controlId) openByControl.set(row.controlId, row._count._all);
        }
        const ownerTaskMap: Record<string, { name: string; openTasks: number }> = {};
        for (const c of controlOwners) {
            if (!c.owner) continue;
            if (!ownerTaskMap[c.owner.id]) {
                ownerTaskMap[c.owner.id] = { name: c.owner.name || 'Unknown', openTasks: 0 };
            }
            ownerTaskMap[c.owner.id].openTasks += openByControl.get(c.id) ?? 0;
        }
        const topOwners = Object.entries(ownerTaskMap)
            .sort(([, a], [, b]) => b.openTasks - a.openTasks)
            .slice(0, 5)
            .map(([id, { name, openTasks }]) => ({ id, name, openTasks }));

        // Implementation progress: % IMPLEMENTED among APPLICABLE.
        const implementationProgress = applicableCount > 0
            ? Math.round((implementedCount / applicableCount) * 100)
            : 0;

        return {
            totalControls,
            statusDistribution,
            applicabilityDistribution: { applicable: applicableCount, notApplicable: notApplicableCount },
            overdueTasks,
            controlsDueSoon,
            topOwners,
            implementationProgress,
            implementedCount,
            applicableCount,
        };
    });
}

// ─── Consistency Check (admin-only) ───

export async function runConsistencyCheck(ctx: RequestContext) {
    // Epic 1 — OWNER is a superset of ADMIN per CLAUDE.md RBAC.
    if (ctx.role !== 'OWNER' && ctx.role !== 'ADMIN') {
        throw (await import('@/lib/errors/types')).forbidden('Only admins can run consistency checks');
    }

    return runInTenantContext(ctx, async (db) => {
        // Three independent checks run in parallel — they don't share
        // intermediate state. Pre-refactor (single `findMany` with
        // full `controlTasks` include) loaded the entire task table
        // for the tenant just to compute overdue counts; for tenants
        // with hundreds of controls × dozens of tasks each this was
        // a 5-50KB result set + an O(N×M) JS pass.
        //
        // The split lets each query use exactly the index it needs:
        //   • controlsForCodeChecks — only `id, code, name` projected,
        //     so the query never touches the wide row.
        //   • overdueTasks — a direct `.findMany` with the GAP-perf
        //     `(tenantId, status, dueAt)` composite index from the
        //     companion migration. Returns ONLY overdue rows; no
        //     in-memory filter needed.
        const now = new Date();

        const [controlsForCodeChecks, totalControls, overdueTaskRows] = await Promise.all([
            // Project the minimum needed for the missingCode +
            // duplicateCodes checks. Skipping the relations and
            // wide columns keeps this fast even on tenants with
            // hundreds of controls.
            db.control.findMany({
                where: { tenantId: ctx.tenantId },
                select: { id: true, code: true, name: true },
                take: FULL_SCAN_CAP,
            }),
            db.control.count({ where: { tenantId: ctx.tenantId } }),
            // Directly query the overdue unified tasks attached to a
            // control (direct `controlId` FK). With the Task
            // `[tenantId, dueAt, status]` composite index this is an
            // index range scan that returns only the matching rows —
            // no scan-and-filter on the full task table.
            db.task.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    controlId: { not: null },
                    status: OPEN_TASK_STATUS_FILTER,
                    dueAt: { lt: now, not: null },
                },
                select: {
                    id: true,
                    title: true,
                    status: true,
                    dueAt: true,
                    controlId: true,
                    control: { select: { code: true } },
                },
                orderBy: { dueAt: 'asc' },
                take: FULL_SCAN_CAP,
            }),
        ]);

        const missingCode = controlsForCodeChecks.filter((c) => !c.code);

        // Duplicate-code detection — single pass over the
        // narrow projection.
        const codeCounts: Record<string, string[]> = {};
        for (const c of controlsForCodeChecks) {
            if (c.code) {
                (codeCounts[c.code] ||= []).push(c.id);
            }
        }
        const duplicateCodes = Object.entries(codeCounts)
            .filter(([, ids]) => ids.length > 1)
            .map(([code, ids]) => ({ code, controlIds: ids }));

        // Shape the overdue rows to match the existing DTO contract
        // — the response shape is unchanged.
        const overdueTasks = overdueTaskRows.map((t) => ({
            controlId: t.controlId,
            controlCode: t.control?.code ?? null,
            taskId: t.id,
            taskTitle: t.title,
            dueAt: t.dueAt,
            status: t.status,
        }));

        return {
            totalControls,
            issues: {
                missingCode: missingCode.map((c) => ({ id: c.id, name: c.name })),
                duplicateCodes,
                overdueTasks,
            },
            summary: {
                missingCodeCount: missingCode.length,
                duplicateCodeCount: duplicateCodes.length,
                overdueTaskCount: overdueTasks.length,
            },
        };
    });
}

export async function listControlsWithDeleted(ctx: RequestContext) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, (db) =>
        db.control.findMany(withDeleted({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' as const }, take: FULL_SCAN_CAP }))
    );
}
