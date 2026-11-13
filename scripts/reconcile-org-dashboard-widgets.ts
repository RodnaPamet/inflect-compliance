/**
 * One-off data-reconciliation for org dashboard widgets.
 *
 * The `OrgDashboardWidget` table has NO unique constraint on
 * `(organizationId, type, chartType)`, so a prior drift produced
 * duplicated rows (most visibly the "Coverage" KPI and the
 * "Coverage by Tenant" TENANT_LIST), some with null titles and some
 * overlapping in the react-grid-layout coordinate space. This script
 * reconciles every organisation's widgets back to a clean state.
 *
 * For EVERY organisation it applies three idempotent passes:
 *
 *   1. DE-DUPLICATE. Group the org's widgets by `(type, chartType)`.
 *      For any group with more than one row, KEEP the earliest
 *      (min `createdAt`, tie-broken by `id`) and DELETE the rest.
 *      This collapses the drift-produced duplicates while preserving
 *      the oldest (most likely user-touched) row.
 *
 *   2. BACKFILL TITLES. For any surviving widget with a null/empty
 *      title, set it from `resolveWidgetTitle(type, chartType, title)`
 *      (src/app-layer/usecases/org-dashboard-widget-titles.ts) — the
 *      single canonical title source. NEVER a raw slug.
 *
 *   3. RE-FLOW POSITIONS. `position` is `{x, y}` and `size` is
 *      `{w, h}`. After de-dup, ensure no two surviving widgets
 *      overlap. If a widget's `(type, chartType)` matches a
 *      `DEFAULT_ORG_DASHBOARD_PRESET` entry, its position+size are
 *      snapped to the preset's. Any extra widget not in the preset is
 *      stacked below everything else (its own full-width row, y past
 *      the tallest preset row) so nothing overlaps.
 *
 * ## Idempotency
 *   Every pass computes a DETERMINISTIC target from the surviving
 *   set alone (the preset is a constant; the extra-widget stack order
 *   is sorted by createdAt then id). A widget already de-duplicated,
 *   already titled, and already at its target position+size produces
 *   NO change — so a second run reports "no changes" for every org.
 *
 * ## Usage
 *   npm run db:reconcile-org-widgets              # dry-run (default)
 *   npm run db:reconcile-org-widgets -- --execute # write
 *
 * ## Safety
 *   Default mode is DRY-RUN: it logs, per org, how many duplicates
 *   WOULD be deleted, how many titles WOULD be backfilled, and how
 *   many positions WOULD be fixed — without writing anything. Pass
 *   `--execute` to persist. Either way the script prints a per-org
 *   line and a closing summary.
 */

process.env.SKIP_ENV_VALIDATION = '1';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Prisma } from '@prisma/client';

import { DEFAULT_ORG_DASHBOARD_PRESET } from '../src/app-layer/usecases/org-dashboard-presets';
import { resolveWidgetTitle } from '../src/app-layer/usecases/org-dashboard-widget-titles';

interface Pos {
    x: number;
    y: number;
}
interface Size {
    w: number;
    h: number;
}

interface WidgetRow {
    id: string;
    organizationId: string;
    type: string;
    chartType: string;
    title: string | null;
    position: Prisma.JsonValue;
    size: Prisma.JsonValue;
    createdAt: Date;
}

/** `${type}/${chartType}` → target preset position+size. */
const PRESET_LAYOUT = new Map<string, { position: Pos; size: Size }>();
for (const w of DEFAULT_ORG_DASHBOARD_PRESET) {
    PRESET_LAYOUT.set(`${w.type}/${w.chartType}`, {
        position: w.position as unknown as Pos,
        size: w.size as unknown as Size,
    });
}

function widgetKey(type: string, chartType: string): string {
    return `${type}/${chartType}`;
}

/** Safely read a `{x, y}` shape, defaulting missing axes to 0. */
function readPos(v: Prisma.JsonValue): Pos {
    const o = (v ?? {}) as Record<string, unknown>;
    return {
        x: typeof o.x === 'number' ? o.x : 0,
        y: typeof o.y === 'number' ? o.y : 0,
    };
}

/** Safely read a `{w, h}` shape, defaulting missing dims to 1. */
function readSize(v: Prisma.JsonValue): Size {
    const o = (v ?? {}) as Record<string, unknown>;
    return {
        w: typeof o.w === 'number' ? o.w : 1,
        h: typeof o.h === 'number' ? o.h : 1,
    };
}

function posEqual(a: Pos, b: Pos): boolean {
    return a.x === b.x && a.y === b.y;
}
function sizeEqual(a: Size, b: Size): boolean {
    return a.w === b.w && a.h === b.h;
}

/**
 * Deterministically order rows within a `(type, chartType)` group:
 * earliest `createdAt` first, ties broken by ascending `id`. The head
 * of this order is the row we KEEP; the tail are duplicates to delete.
 */
function byCreatedThenId(a: WidgetRow, b: WidgetRow): number {
    const t = a.createdAt.getTime() - b.createdAt.getTime();
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface PlannedUpdate {
    id: string;
    /** New title, when a backfill is needed. */
    title?: string;
    /** New position, when a re-flow is needed. */
    position?: Pos;
    /** New size, when a re-flow is needed. */
    size?: Size;
}

interface OrgPlan {
    deleteIds: string[];
    titleUpdates: number;
    positionUpdates: number;
    updates: PlannedUpdate[];
}

/**
 * Compute the full reconciliation plan for one org's widgets WITHOUT
 * touching the DB. Pure function of the input rows ⇒ trivially
 * idempotent: feeding it the already-reconciled rows yields an empty
 * plan.
 */
function planOrg(widgets: WidgetRow[]): OrgPlan {
    // ── Pass 1: de-duplicate by (type, chartType) ───────────────────
    const groups = new Map<string, WidgetRow[]>();
    for (const w of widgets) {
        const key = widgetKey(w.type, w.chartType);
        const g = groups.get(key);
        if (g) g.push(w);
        else groups.set(key, [w]);
    }

    const survivors: WidgetRow[] = [];
    const deleteIds: string[] = [];
    for (const g of groups.values()) {
        g.sort(byCreatedThenId);
        survivors.push(g[0]);
        for (let i = 1; i < g.length; i++) deleteIds.push(g[i].id);
    }

    // ── Pass 3 (target computation): partition survivors into
    //    preset-matched and extras, then compute the stack offset. ───
    const presetSurvivors: WidgetRow[] = [];
    const extras: WidgetRow[] = [];
    for (const w of survivors) {
        if (PRESET_LAYOUT.has(widgetKey(w.type, w.chartType))) presetSurvivors.push(w);
        else extras.push(w);
    }

    // Bottom edge of all preset-matched widgets (using the preset's
    // own canonical positions) — extras stack strictly below this so
    // they can never overlap a preset widget.
    let baseBottom = 0;
    for (const w of presetSurvivors) {
        const layout = PRESET_LAYOUT.get(widgetKey(w.type, w.chartType));
        if (layout) baseBottom = Math.max(baseBottom, layout.position.y + layout.size.h);
    }

    // Assign each extra its own full-width-ish row below baseBottom,
    // in a deterministic order so the y-coordinates are stable across
    // runs. Each extra keeps its existing size; only its position
    // moves (x→0, y→stacked).
    const sortedExtras = [...extras].sort(byCreatedThenId);
    const extraTargetPos = new Map<string, Pos>();
    let cursorY = baseBottom;
    for (const w of sortedExtras) {
        extraTargetPos.set(w.id, { x: 0, y: cursorY });
        cursorY += readSize(w.size).h;
    }

    // ── Build per-survivor update payloads (Pass 2 + Pass 3) ─────────
    const updates: PlannedUpdate[] = [];
    let titleUpdates = 0;
    let positionUpdates = 0;

    for (const w of survivors) {
        const update: PlannedUpdate = { id: w.id };

        // Pass 2: title backfill.
        if (!w.title || w.title.trim() === '') {
            update.title = resolveWidgetTitle(w.type, w.chartType, w.title);
            titleUpdates++;
        }

        // Pass 3: re-flow.
        const layout = PRESET_LAYOUT.get(widgetKey(w.type, w.chartType));
        const targetPos = layout ? layout.position : extraTargetPos.get(w.id)!;
        const targetSize = layout ? layout.size : readSize(w.size);

        const curPos = readPos(w.position);
        const curSize = readSize(w.size);
        if (!posEqual(curPos, targetPos) || !sizeEqual(curSize, targetSize)) {
            update.position = targetPos;
            update.size = targetSize;
            positionUpdates++;
        }

        if (update.title !== undefined || update.position !== undefined) {
            updates.push(update);
        }
    }

    return { deleteIds, titleUpdates, positionUpdates, updates };
}

async function main(): Promise<void> {
    const execute = process.argv.includes('--execute');
    const mode = execute ? 'EXECUTE' : 'DRY RUN';

    console.log(`\n── reconcile-org-dashboard-widgets — ${mode} ──\n`);
    if (!execute) {
        console.log('  No writes performed. Rerun with --execute to persist.\n');
    }

    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
    let orgsChanged = 0;
    let orgsClean = 0;
    let totalDeleted = 0;
    let totalTitles = 0;
    let totalPositions = 0;

    try {
        const orgs = await prisma.organization.findMany({
            select: { id: true, slug: true },
            orderBy: { createdAt: 'asc' },
        });

        console.log(`  Found ${orgs.length} organisation(s).\n`);

        for (const org of orgs) {
            const widgets = (await prisma.orgDashboardWidget.findMany({
                where: { organizationId: org.id },
                select: {
                    id: true,
                    organizationId: true,
                    type: true,
                    chartType: true,
                    title: true,
                    position: true,
                    size: true,
                    createdAt: true,
                },
            })) as WidgetRow[];

            const plan = planOrg(widgets);
            const changes =
                plan.deleteIds.length + plan.titleUpdates + plan.positionUpdates;

            if (changes === 0) {
                console.log(`  · ${org.slug.padEnd(36)} no changes (reconciled)`);
                orgsClean++;
                continue;
            }

            const verb = execute ? '' : 'would ';
            console.log(
                `  ${execute ? '✓' : '+'} ${org.slug.padEnd(36)} ${verb}delete ${plan.deleteIds.length} dup(s), ` +
                    `${verb}backfill ${plan.titleUpdates} title(s), ${verb}fix ${plan.positionUpdates} position(s)`,
            );

            if (execute) {
                if (plan.deleteIds.length > 0) {
                    await prisma.orgDashboardWidget.deleteMany({
                        where: { id: { in: plan.deleteIds } },
                    });
                }
                for (const u of plan.updates) {
                    const data: Prisma.OrgDashboardWidgetUpdateInput = {};
                    if (u.title !== undefined) data.title = u.title;
                    if (u.position !== undefined) {
                        data.position = u.position as unknown as Prisma.InputJsonValue;
                    }
                    if (u.size !== undefined) {
                        data.size = u.size as unknown as Prisma.InputJsonValue;
                    }
                    await prisma.orgDashboardWidget.update({
                        where: { id: u.id },
                        data,
                    });
                }
            }

            orgsChanged++;
            totalDeleted += plan.deleteIds.length;
            totalTitles += plan.titleUpdates;
            totalPositions += plan.positionUpdates;
        }

        const suffix = execute ? '' : ' (would)';
        console.log(`\n── Summary ─────────────────────────────────────────`);
        console.log(`  Orgs total          : ${orgs.length}`);
        console.log(`  Orgs reconciled${suffix}: ${orgsChanged}`);
        console.log(`  Orgs already clean  : ${orgsClean}`);
        console.log(`  Duplicates deleted${suffix} : ${totalDeleted}`);
        console.log(`  Titles backfilled${suffix}  : ${totalTitles}`);
        console.log(`  Positions fixed${suffix}    : ${totalPositions}`);
        console.log('');
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    // Non-zero exit so any orchestrator (CI, manual operator) sees
    // the failure rather than a silent partial reconciliation.
    console.error('\nreconcile-org-dashboard-widgets failed:', err);
    process.exit(1);
});
