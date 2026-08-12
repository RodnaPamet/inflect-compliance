/**
 * Tenant-wide aggregate reads for the Controls surface: the admin dashboard
 * metrics and the admin-only consistency check.
 *
 * These lived in `queries.ts` alongside the LIST and DETAIL reads, which made
 * that file the answer to two different questions. The list/detail reads are
 * per-request and paginated; these two are whole-tenant scans bounded by
 * `FULL_SCAN_CAP` and used by admin surfaces only. Split 2026-08-08 (roadmap
 * P3.3). The barrel re-exports both, so no call site moved.
 */
import { RequestContext } from '../../types';
import { assertCanReadControls } from '../../policies/control.policies';
import { runInTenantContext, runInTenantReadContext } from '@/lib/db-context';
import { TERMINAL_WORK_ITEM_STATUSES } from '../../domain/work-item-status';
import type { TaskStatus } from '@prisma/client';

// Non-terminal (active) work-item statuses — the unified-Task equivalent of
// the legacy `status != 'DONE'` predicate the ControlTask dashboard used.
const OPEN_TASK_STATUS_FILTER = {
    notIn: [...TERMINAL_WORK_ITEM_STATUSES] as TaskStatus[],
} as const;

// Safety cap on the tenant-wide scans below. These are aggregate/admin reads
// that intentionally scan the whole tenant, so they can't paginate — the cap
// is a latency/memory guard against a pathological tenant rather than a page
// size. Mirrors `HEALTH_VERDICT_SCAN_CAP` in ./health.
const FULL_SCAN_CAP = 5000;

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
