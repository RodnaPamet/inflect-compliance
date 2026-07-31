import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, ControlStatus } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import { traceRepository } from '@/lib/observability/repository-tracing';
import { notFound } from '@/lib/errors/types';
import { parseEnumListFilter } from '../domain/list-filter';

export interface ControlListFilters {
    status?: string;
    applicability?: string;
    ownerUserId?: string;
    q?: string;
    category?: string;
    /**
     * Restrict to an explicit control-id set — the server-side backing for the
     * consistency-check `?ids=` deep-link AND the resolved health-verdict facet
     * (the usecase resolves `health` → this id set). Applied as `id: { in }` so
     * a flagged control beyond the loaded page is no longer silently hidden by a
     * client-side row filter.
     */
    ids?: string[];
}

export interface ControlListParams {
    limit?: number;
    cursor?: string;
    filters?: ControlListFilters;
}

// PR-3 — tight SELECT shape for the Controls list page. Lists exactly
// the columns ControlsClient.tsx renders (or filters on); switches off
// `include` so Prisma doesn't fetch the unused Control scalars
// (long-text fields like description, frequency justifications, etc.).
const controlListSelect = {
    id: true,
    code: true,
    annexId: true,
    name: true,
    status: true,
    applicability: true,
    // R2-P4 — distinguishes an assessed-applicable control from a
    // never-assessed one (both stored as APPLICABLE) in the list column.
    applicabilityDecidedAt: true,
    // Framework-native category (SOC 2 TSC, NIS2 / ISO section, …).
    // The Browse rail's category grouping (`categorizeControl`) uses it
    // as the cross-framework fallback — ISO 27001 derives its granular
    // domain from the Annex clause instead.
    category: true,
    frequency: true,
    ownerUserId: true,
    // `createdAt` is required by the cursor-pagination helper
    // (`computePageInfo`) — it's not rendered in the table.
    createdAt: true,
    owner: { select: { id: true, name: true, email: true } },
    // R2-P4 — count links + evidence↔control joins so the list Evidence
    // column agrees with the detail Evidence tab badge (which counts both).
    _count: { select: { evidenceLinks: true, evidenceControlLinks: true } },
} as const;

export class ControlRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters?: ControlListFilters,
        options: { take?: number } = {},
    ) {
        return traceRepository('control.list', ctx, async () => {
            const where = ControlRepository._buildWhere(ctx, filters);

            return db.control.findMany({
                where,
                orderBy: [{ code: 'asc' }, { annexId: 'asc' }],
                select: controlListSelect,
                // Bounded even on the legacy no-`take` list path — cap at 500
                // so an unpaginated call can't stream an unbounded result set.
                take: options.take ?? 500,
            });
        });
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: ControlListParams): Promise<PaginatedResponse<unknown>> {
        return traceRepository('control.listPaginated', ctx, async () => {
            const limit = clampLimit(params.limit);
            const where = ControlRepository._buildWhere(ctx, params.filters);

            // Apply cursor
            const cursorWhere = buildCursorWhere(params.cursor);
            if (cursorWhere) {
                where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), cursorWhere];
            }

            const items = await db.control.findMany({
                where,
                orderBy: CURSOR_ORDER_BY,
                take: limit + 1,
                select: controlListSelect,
            });

            const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
            return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
        });
    }

    /**
     * Parse the `status` filter, which arrives as a comma-joined list from
     * the list page's multi-select.
     *
     * This used to be `filters.status as Prisma.EnumControlStatusFilter` — an
     * `as` cast that told the compiler the string was already a valid enum
     * filter. It is not: a single value happened to work, but selecting two
     * sent Prisma the literal `"IN_PROGRESS,IMPLEMENTING"` as an enum, which
     * it rejects with a validation error. The route returned 500 and the
     * whole section fell over with a Server Components render error.
     *
     * Same shape as `parseListFilter` in WorkItemRepository: dedupe, validate
     * every member against the real enum, and collapse to a scalar or `{ in }`.
     * An unknown value is a 400, not a 500 — the caller sent something wrong.
     */
    private static _parseStatusFilter(
        raw: string,
    ): Prisma.EnumControlStatusFilter | ControlStatus | undefined {
        // Delegates to the shared parser in `../domain/list-filter`, which
        // this method (and its WorkItemRepository twin) was extracted into.
        // Behaviour — including the 400 message — is unchanged.
        return parseEnumListFilter<ControlStatus>(
            raw,
            Object.values(ControlStatus),
            'control status',
        );
    }

    private static _buildWhere(ctx: RequestContext, filters?: ControlListFilters): Prisma.ControlWhereInput {
        const where: Prisma.ControlWhereInput = {
            OR: [{ tenantId: ctx.tenantId }, { tenantId: null }],
        };

        if (filters?.status) where.status = ControlRepository._parseStatusFilter(filters.status);
        if (filters?.applicability && (filters.applicability === 'APPLICABLE' || filters.applicability === 'NOT_APPLICABLE')) {
            where.applicability = filters.applicability;
        }
        if (filters?.ownerUserId) where.ownerUserId = filters.ownerUserId;
        if (filters?.category) where.category = filters.category;
        // Explicit id restriction (consistency `?ids=` deep-link + resolved
        // health facet). Filtered in-DB so it scales past the loaded page.
        // An EMPTY array is deliberate (a requested facet that matched nothing)
        // → `id in ()` → zero rows, NOT "no restriction"; only `undefined` skips.
        if (filters?.ids) where.id = { in: filters.ids };
        if (filters?.q) {
            where.AND = [{
                OR: [
                    { name: { contains: filters.q, mode: 'insensitive' } },
                    { code: { contains: filters.q, mode: 'insensitive' } },
                    { objective: { contains: filters.q, mode: 'insensitive' } },
                ],
            }];
        }

        return where;
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return traceRepository('control.getById', ctx, async () => {
            // `risks` and `_count` are deliberately omitted — they were
            // eager-loaded historically but no caller reads them off the
            // detail payload (the page computes badge counts from `.length`
            // on the kept arrays; TestPlansPanel runs its own fetch).
            // `policyLinks` IS loaded: it backs the reverse Policies section
            // on the control detail page (bidirectional control↔policy), the
            // mirror of the policy detail's Controls section.
            // The bigger tab-lazy refactor (drop controlTasks /
            // evidenceLinks / evidence / frameworkMappings arrays in
            // favour of per-tab fetches) is bounded follow-up; safe
            // trim landed here cuts the unused subqueries today.
            const control = await db.control.findFirst({
                where: {
                    id,
                    OR: [{ tenantId: ctx.tenantId }, { tenantId: null }],
                },
                include: {
                    owner: { select: { id: true, name: true, email: true } },
                    createdBy: { select: { id: true, name: true, email: true } },
                    applicabilityDecidedBy: { select: { id: true, name: true, email: true } },
                    contributors: { include: { user: { select: { id: true, name: true, email: true } } } },
                    // Reverse policy↔control links — linked governing policies,
                    // surfaced read-only on the control detail (link/unlink is
                    // owned by the policy side).
                    policyLinks: {
                        include: {
                            policy: { select: { id: true, slug: true, title: true, status: true } },
                        },
                    },
                    evidenceLinks: { orderBy: { createdAt: 'desc' }, include: { createdBy: { select: { id: true, name: true } } } },
                    // Evidence↔Control is now a many-to-many join; read the
                    // linked Evidence rows through it and flatten back to the
                    // `control.evidence` array the detail page expects.
                    evidenceControlLinks: {
                        where: { tenantId: ctx.tenantId },
                        orderBy: { evidence: { createdAt: 'desc' } },
                        include: { evidence: true },
                    },
                    frameworkMappings: { include: { fromRequirement: { include: { framework: { select: { name: true } } } } } },
                },
            });
            if (!control) return null;
            return { ...control, evidence: control.evidenceControlLinks.map((l) => l.evidence) };
        });
    }

    /**
     * Header-only control fetch — the tab-lazy counterpart to
     * `getById` (#102 item 1).
     *
     * Loads control scalars, the three lightweight user refs, and
     * `contributors` (all read by the Overview tab + header), plus a
     * `_count` for the four tabbed relations so the tab badges render
     * without their arrays. The heavy arrays themselves —
     * `controlTasks` / `evidenceLinks` / `evidence` /
     * `frameworkMappings` — are deliberately NOT loaded; each tab
     * fetches its own slice on demand via its own endpoint.
     */
    static async getHeaderById(db: PrismaTx, ctx: RequestContext, id: string) {
        return traceRepository('control.getHeaderById', ctx, async () => {
            return db.control.findFirst({
                where: {
                    id,
                    OR: [{ tenantId: ctx.tenantId }, { tenantId: null }],
                },
                include: {
                    owner: { select: { id: true, name: true, email: true } },
                    createdBy: { select: { id: true, name: true, email: true } },
                    applicabilityDecidedBy: { select: { id: true, name: true, email: true } },
                    contributors: { include: { user: { select: { id: true, name: true, email: true } } } },
                    // Reverse policy↔control links back the Overview's Policies
                    // section (bidirectional control↔policy). Kept here despite
                    // the header-only design: a control links to a handful of
                    // governing policies at most, so this is a small array — and
                    // the section needs the policy refs (names + links), not just
                    // a count.
                    policyLinks: {
                        include: {
                            policy: { select: { id: true, slug: true, title: true, status: true } },
                        },
                    },
                    _count: {
                        select: {
                            evidenceLinks: true,
                            evidenceControlLinks: true,
                            // Canonical control↔requirement links (not the
                            // legacy frameworkMapping island) back the
                            // Mappings tab badge — mapped to the
                            // `frameworkMappings` key in getControlHeader.
                            requirementLinks: true,
                        },
                    },
                },
            });
        });
    }

    /**
     * The framework-requirement links for one control — backs the control
     * detail Requirements tab.
     *
     * Named for what it queries: the CANONICAL `controlRequirementLink` table
     * (NOT the legacy `frameworkMapping` island — a real but separate model on
     * `Control`). SoA / coverage / readiness read the same links, so the tab
     * shows exactly the mappings that drive those surfaces. The row is mapped
     * to the `fromRequirement` + `framework.name` shape the tab renders.
     */
    static async listControlRequirementLinks(db: PrismaTx, ctx: RequestContext, controlId: string) {
        const links = await db.controlRequirementLink.findMany({
            where: { controlId, tenantId: ctx.tenantId },
            take: 500,
            include: {
                requirement: {
                    include: { framework: { select: { name: true } } },
                },
            },
        });
        return links.map((l) => ({
            id: l.id,
            fromRequirementId: l.requirementId,
            toControlId: l.controlId,
            // Per-framework applicability override on the link (null = inherit
            // the control's global value) so the Requirements tab can show +
            // edit it.
            applicability: l.applicability,
            applicabilityJustification: l.applicabilityJustification,
            fromRequirement: {
                id: l.requirement.id,
                code: l.requirement.code,
                title: l.requirement.title,
                description: l.requirement.description,
                section: l.requirement.section,
                category: l.requirement.category,
                framework: { name: l.requirement.framework.name },
            },
        }));
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: Omit<Prisma.ControlUncheckedCreateInput, 'tenantId'>) {
        return traceRepository('control.create', ctx, async () => {
            return db.control.create({
                data: {
                    ...data,
                    tenantId: ctx.tenantId,
                },
            });
        });
    }

    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: Omit<Prisma.ControlUncheckedUpdateInput, 'tenantId'>) {
        const existing = await db.control.findFirst({
            where: { id, tenantId: ctx.tenantId }
        });
        if (!existing) return null;

        return db.control.update({
            where: { id },
            data,
        });
    }

    static async setApplicability(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        applicability: 'APPLICABLE' | 'NOT_APPLICABLE',
        justification: string | null
    ) {
        const existing = await db.control.findFirst({
            where: { id, tenantId: ctx.tenantId },
        });
        if (!existing) return null;

        return db.control.update({
            where: { id },
            data: {
                applicability,
                applicabilityJustification: applicability === 'NOT_APPLICABLE' ? justification : null,
                applicabilityDecidedByUserId: ctx.userId,
                applicabilityDecidedAt: new Date(),
            },
            include: {
                applicabilityDecidedBy: { select: { id: true, name: true, email: true } },
            },
        });
    }

    static async setOwner(db: PrismaTx, ctx: RequestContext, id: string, ownerUserId: string | null) {
        const existing = await db.control.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!existing) return null;
        return db.control.update({
            where: { id },
            data: { ownerUserId },
            include: { owner: { select: { id: true, name: true, email: true } } },
        });
    }

    // ─── Contributors ───

    static async listContributors(db: PrismaTx, ctx: RequestContext, controlId: string) {
        return db.controlContributor.findMany({
            where: { controlId, tenantId: ctx.tenantId },
            take: 500,
            include: { user: { select: { id: true, name: true, email: true } } },
        });
    }

    static async addContributor(db: PrismaTx, ctx: RequestContext, controlId: string, userId: string) {
        const control = await db.control.findFirst({ where: { id: controlId, tenantId: ctx.tenantId } });
        if (!control) return null;
        // The body-supplied userId must be an ACTIVE member of this tenant —
        // FK checks bypass RLS, so an unverified cross-tenant userId would
        // insert cleanly and only surface as a null relation on later reads.
        const membership = await db.tenantMembership.findFirst({
            where: { tenantId: ctx.tenantId, userId, status: 'ACTIVE' },
            select: { id: true },
        });
        if (!membership) throw notFound('User is not an active member of this tenant');
        return db.controlContributor.create({
            data: { tenantId: ctx.tenantId, controlId, userId },
            include: { user: { select: { id: true, name: true, email: true } } },
        });
    }

    static async removeContributor(db: PrismaTx, ctx: RequestContext, controlId: string, userId: string) {
        const control = await db.control.findFirst({ where: { id: controlId, tenantId: ctx.tenantId } });
        if (!control) return null;
        const link = await db.controlContributor.findFirst({ where: { controlId, userId, tenantId: ctx.tenantId } });
        if (!link) return null;
        await db.controlContributor.delete({ where: { id: link.id } });
        return true;
    }

    // ─── Evidence Links ───

    static async listEvidenceLinks(db: PrismaTx, ctx: RequestContext, controlId: string) {
        return db.controlEvidenceLink.findMany({
            where: { controlId, tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            take: 500,
            include: { createdBy: { select: { id: true, name: true } } },
        });
    }

    static async linkEvidence(db: PrismaTx, ctx: RequestContext, controlId: string, data: { kind: string; fileId?: string | null; url?: string | null; note?: string | null }) {
        const control = await db.control.findFirst({ where: { id: controlId, tenantId: ctx.tenantId } });
        if (!control) return null;
        // Verify the body-supplied fileId belongs to this tenant before the
        // insert — the FK check bypasses RLS, so a cross-tenant fileId would
        // insert cleanly and later reads would surface a null FileRecord.
        if (data.fileId) {
            const file = await db.fileRecord.findFirst({
                where: { id: data.fileId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!file) throw notFound('File not found');
        }
        return db.controlEvidenceLink.create({
            data: {
                tenantId: ctx.tenantId,
                controlId,
                kind: data.kind as 'FILE' | 'LINK' | 'INTEGRATION_RESULT',
                fileId: data.fileId || null,
                url: data.url || null,
                note: data.note || null,
                createdByUserId: ctx.userId,
            },
            include: { createdBy: { select: { id: true, name: true } } },
        });
    }

    static async unlinkEvidence(db: PrismaTx, ctx: RequestContext, controlId: string, linkId: string) {
        const link = await db.controlEvidenceLink.findFirst({
            where: { id: linkId, controlId, tenantId: ctx.tenantId },
        });
        if (!link) return null;
        await db.controlEvidenceLink.delete({ where: { id: linkId } });
        return true;
    }

    // ─── Asset Linking ───

    static async linkAsset(db: PrismaTx, ctx: RequestContext, controlId: string, assetId: string) {
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId },
        });
        if (!control) return null;
        // Verify the body-supplied assetId belongs to this tenant before the
        // insert — the FK check bypasses RLS, so a cross-tenant assetId would
        // insert cleanly and later reads would surface a null Asset relation.
        const asset = await db.asset.findFirst({
            where: { id: assetId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!asset) throw notFound('Asset not found');
        return db.controlAsset.create({
            data: { tenantId: ctx.tenantId, controlId, assetId },
        });
    }

    static async unlinkAsset(db: PrismaTx, ctx: RequestContext, controlId: string, assetId: string) {
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId },
        });
        if (!control) return null;
        const link = await db.controlAsset.findFirst({
            where: { controlId, assetId, tenantId: ctx.tenantId },
        });
        if (!link) return null;
        await db.controlAsset.delete({ where: { id: link.id } });
        return true;
    }

    /** Fetch the tenant's controls for the given ids (bulk-action audit source). */
    static async listByIds(db: PrismaTx, ctx: RequestContext, ids: string[]) {
        // Bounded by the `in: ids` set (bulk schemas cap at 100 ids); a `take:`
        // would be redundant. Tenant-owned rows only — framework-global controls
        // (tenantId NULL) are never bulk-editable by a tenant.
        return db.control.findMany({ // guardrail-allow: unbounded
            where: { id: { in: ids }, tenantId: ctx.tenantId },
        });
    }

    /**
     * Tenant-scoped bulk update — one `updateMany` so the bulk-action path
     * never reads/writes per-id in a loop. Returns the affected-row count.
     */
    static async bulkUpdate(
        db: PrismaTx,
        ctx: RequestContext,
        ids: string[],
        data: Omit<Prisma.ControlUncheckedUpdateInput, 'tenantId'>,
    ) {
        return db.control.updateMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId },
            data,
        });
    }
}
