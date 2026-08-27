/**
 * Epic 41 — Configurable Dashboard Widget Engine.
 *
 * CRUD usecases for the persisted widget composition of the org-level
 * dashboard at `/org/[orgSlug]`. Reads return every widget owned by
 * the org (ordered by createdAt for stable rendering). Writes accept
 * already-Zod-validated payloads from the route layer; this usecase
 * does NOT re-derive the shape — it owns persistence + tenant safety
 * + the on-update typed-shape recheck.
 *
 * Tenant safety: every operation scopes by `ctx.organizationId`. The
 * `where` clauses on update / delete carry both `id` AND
 * `organizationId` so a stolen widget id from another org returns
 * 404, never a cross-org write. The route layer does NOT need to
 * trust the caller-provided id.
 *
 * Org-scoped (NOT tenant-scoped) — same shape as `org-members.ts`
 * and the other `org-*` usecases. Uses the global prisma client
 * directly because OrgDashboardWidget is not in TENANT_SCOPED_MODELS.
 *
 * Permission model: read access is gated by `canViewPortfolio`; write
 * access by `canConfigureDashboard` (ORG_ADMIN only). Both are
 * enforced at the route layer; this usecase asserts them defensively
 * so a direct call from a future code path can't sneak past.
 *
 * No audit emission. Widget mutations are UI-configuration only — not
 * privilege-affecting — and don't fall under the SOC 2 CC6.1 evidence
 * scope that `org-audit-coverage.test.ts` guards. If a future
 * compliance requirement asks for "who changed the dashboard", add a
 * dedicated `ORG_DASHBOARD_*` enum trio to OrgAuditAction in the same
 * PR that wires the emission.
 */

import type { OrgDashboardWidgetType, Prisma } from '@prisma/client';

import prisma from '@/lib/prisma';
import { bumpEntityCacheVersionForScope } from '@/lib/cache/list-cache';
import { forbidden, notFound } from '@/lib/errors/types';
import type { OrgContext } from '@/app-layer/types';
import {
    assertWidgetTypedShape,
    type CreateOrgDashboardWidgetInput,
    type OrgDashboardWidgetDto,
    type UpdateOrgDashboardWidgetInput,
    type WidgetPosition,
    type WidgetSize,
} from '@/app-layer/schemas/org-dashboard-widget.schemas';
import { resolveWidgetTitle } from './org-dashboard-widget-titles';
import { seedDefaultOrgDashboard } from './org-dashboard-presets';

// ─── Permission helpers ────────────────────────────────────────────────

function assertCanReadOrgWidgets(ctx: OrgContext): void {
    if (!ctx.permissions.canViewPortfolio) {
        throw forbidden(
            'You do not have permission to view dashboard widgets for this organization',
        );
    }
}

function assertCanWriteOrgWidgets(ctx: OrgContext): void {
    if (!ctx.permissions.canConfigureDashboard) {
        throw forbidden(
            'You do not have permission to configure dashboard widgets for this organization',
        );
    }
}

// ─── DTO mapping ───────────────────────────────────────────────────────

interface WidgetRow {
    id: string;
    organizationId: string;
    type: OrgDashboardWidgetType;
    chartType: string;
    title: string | null;
    config: Prisma.JsonValue;
    position: Prisma.JsonValue;
    size: Prisma.JsonValue;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
}

function rowToDto(row: WidgetRow): OrgDashboardWidgetDto {
    return {
        id: row.id,
        organizationId: row.organizationId,
        type: row.type,
        chartType: row.chartType,
        title: row.title,
        // The DB column is `Json` — Prisma surfaces it as
        // `JsonValue`. The Zod schemas at the API boundary already
        // validated the shape on write; reads just hand the parsed
        // value back. Casting is documented and intentional.
        config: row.config as Record<string, unknown>,
        position: row.position as unknown as WidgetPosition,
        size: row.size as unknown as WidgetSize,
        enabled: row.enabled,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

// ─── Read ──────────────────────────────────────────────────────────────

/**
 * List every widget owned by this org. Ordered by `createdAt ASC` so
 * the layout is stable across reloads — the frontend's drag-to-reorder
 * surface mutates `position` (not `createdAt`), so this ordering only
 * tiebreaks rows with identical positions.
 */
export async function listOrgDashboardWidgets(
    ctx: OrgContext,
): Promise<OrgDashboardWidgetDto[]> {
    assertCanReadOrgWidgets(ctx);

    const rows = await prisma.orgDashboardWidget.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: { createdAt: 'asc' },
    });
    return rows.map(rowToDto);
}

// ─── Create ────────────────────────────────────────────────────────────

export async function createOrgDashboardWidget(
    ctx: OrgContext,
    input: CreateOrgDashboardWidgetInput,
): Promise<OrgDashboardWidgetDto> {
    assertCanWriteOrgWidgets(ctx);

    const row = await prisma.orgDashboardWidget.create({
        data: {
            organizationId: ctx.organizationId,
            type: input.type,
            chartType: input.chartType,
            // Guarantee a human title at persist time — a widget must
            // NEVER land with a null/empty title (the dispatcher + null-
            // title backfill share this resolver). Falls back to the
            // canonical map, then a sentence-cased slug.
            title: resolveWidgetTitle(input.type, input.chartType, input.title),
            // Cast through Prisma's accepted Json input shape. Zod
            // already verified `config` matches the per-type schema
            // at the route layer.
            config: input.config as Prisma.InputJsonValue,
            position: input.position as Prisma.InputJsonValue,
            size: input.size as Prisma.InputJsonValue,
            enabled: input.enabled ?? true,
        },
    });
    await bumpEntityCacheVersionForScope(ctx.organizationId, 'orgWidget');
    return rowToDto(row);
}

// ─── Update ────────────────────────────────────────────────────────────

/**
 * Partial update. The widget's `type` is immutable — change of type
 * is delete + recreate by design (the per-type config shape is
 * incompatible across types, so an in-place `type` change can't
 * preserve `config`).
 *
 * `chartType` + `config` move TOGETHER (the route-layer Zod refines
 * this; we revalidate here as defence-in-depth using the existing
 * type from the DB row). Layout fields are independent.
 */
export async function updateOrgDashboardWidget(
    ctx: OrgContext,
    widgetId: string,
    input: UpdateOrgDashboardWidgetInput,
): Promise<OrgDashboardWidgetDto> {
    assertCanWriteOrgWidgets(ctx);

    const existing = await prisma.orgDashboardWidget.findFirst({
        where: { id: widgetId, organizationId: ctx.organizationId },
    });
    if (!existing) {
        // Cross-org id leak returns the same 404 as a real miss —
        // no information disclosure about other orgs' widgets.
        throw notFound('Widget not found');
    }

    // If chartType + config are present, revalidate against the
    // existing widget's type. Throws ZodError → 400 at the wrapper.
    if (input.chartType !== undefined && input.config !== undefined) {
        assertWidgetTypedShape({
            type: existing.type,
            chartType: input.chartType,
            config: input.config,
        });
    }

    const data: Prisma.OrgDashboardWidgetUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.position !== undefined) {
        data.position = input.position as Prisma.InputJsonValue;
    }
    if (input.size !== undefined) {
        data.size = input.size as Prisma.InputJsonValue;
    }
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.chartType !== undefined) data.chartType = input.chartType;
    if (input.config !== undefined) {
        data.config = input.config as Prisma.InputJsonValue;
    }

    const row = await prisma.orgDashboardWidget.update({
        where: { id: existing.id },
        data,
    });
    await bumpEntityCacheVersionForScope(ctx.organizationId, 'orgWidget');
    return rowToDto(row);
}

// ─── Delete ────────────────────────────────────────────────────────────

export async function deleteOrgDashboardWidget(
    ctx: OrgContext,
    widgetId: string,
): Promise<{ deleted: true; id: string }> {
    assertCanWriteOrgWidgets(ctx);

    // updateMany / deleteMany would scope on organizationId without a
    // pre-fetch; we use deleteMany to keep the cross-org-id case as a
    // 404 (not a 200 with `count: 0`).
    const result = await prisma.orgDashboardWidget.deleteMany({
        where: { id: widgetId, organizationId: ctx.organizationId },
    });
    if (result.count === 0) {
        throw notFound('Widget not found');
    }
    await bumpEntityCacheVersionForScope(ctx.organizationId, 'orgWidget');
    return { deleted: true, id: widgetId };
}

// ─── Reset ─────────────────────────────────────────────────────────────

/**
 * Reconcile a drifted org dashboard back to the recommended default
 * layout. Org dashboards accumulate drift over time (duplicated tiles,
 * null-title widgets from older code paths); this is the operator
 * escape hatch.
 *
 * Deliberately destructive — preserves nothing. Every widget the org
 * owns is deleted, then the full `DEFAULT_ORG_DASHBOARD_PRESET` is
 * re-seeded. The delete + seed run inside one transaction so a reader
 * never observes an empty dashboard mid-flight, and so a seed failure
 * rolls the delete back. The seeder short-circuits when the org
 * already has widgets, so it MUST run after the delete (count === 0).
 *
 * Gated by `canConfigureDashboard` (ORG_ADMIN) — the same write gate
 * as create / update / delete.
 */
export async function resetOrgDashboardToPreset(
    ctx: OrgContext,
): Promise<OrgDashboardWidgetDto[]> {
    assertCanWriteOrgWidgets(ctx);

    await prisma.$transaction(async (tx) => {
        await tx.orgDashboardWidget.deleteMany({
            where: { organizationId: ctx.organizationId },
        });
        // Count is 0 after the delete, so the seeder inserts the full
        // preset rather than short-circuiting.
        await seedDefaultOrgDashboard(tx, ctx.organizationId);
    });

    await bumpEntityCacheVersionForScope(ctx.organizationId, 'orgWidget');
    return listOrgDashboardWidgets(ctx);
}
