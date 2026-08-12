import { RequestContext } from '../../types';
import { ControlRepository, type ControlListFilters } from '../../repositories/ControlRepository';
import { getControlHealthVerdicts } from './health';
import { TaskRepository } from '../../repositories/TaskRepository';
import { assertCanReadControls } from '../../policies/control.policies';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanAdmin } from '../../policies/common';
import { withDeleted } from '@/lib/soft-delete';
import { cachedListRead } from '@/lib/cache/list-cache';

// Safety cap on the recycle-bin view's tenant-wide scan. It intentionally
// reads the whole tenant, so it can't paginate — the cap is a latency/memory
// guard against a pathological tenant rather than a page size. Mirrors the
// health-scan cap (`HEALTH_VERDICT_SCAN_CAP` in ./health) and the identical
// constant in ./dashboard, which owns the other two whole-tenant scans.
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
                const counts = await TaskRepository.countLinkedToControls(
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
        const linkedTasks = await TaskRepository.countLinkedToControl(
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

export async function listControlsWithDeleted(ctx: RequestContext) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, (db) =>
        db.control.findMany(withDeleted({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' as const }, take: FULL_SCAN_CAP }))
    );
}
