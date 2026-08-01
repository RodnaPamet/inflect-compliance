import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, VendorStatus, VendorCriticality, VendorDataAccess, VendorDocumentType, VendorLinkEntityType, VendorLinkRelation } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import { validateVendorTags } from '../schemas/json-columns.schemas';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import { parseEnumListFilter } from '../domain/list-filter';

export interface VendorFilters {
    status?: string;
    criticality?: string;
    riskRating?: string;
    reviewDue?: 'overdue' | 'next30d';
    q?: string;
}

export interface VendorListParams {
    limit?: number;
    cursor?: string;
    filters?: VendorFilters;
}

const vendorIncludes = {
    owner: { select: { id: true, name: true, email: true } },
    _count: { select: { documents: true, assessments: true, contacts: true, links: true } },
};

// PR-3 — tight SELECT shape for the Vendors list page. The previous
// `include: { owner }` returned every Vendor scalar (long-text
// `description`, encrypted-at-rest `legalName`, jsonb `tags`, etc.).
// Detail page uses the heavier `vendorIncludes` via getById.
const vendorListSelect = {
    id: true,
    name: true,
    status: true,
    criticality: true,
    inherentRisk: true,
    nextReviewAt: true,
    contractRenewalAt: true,
    isSubprocessor: true,
    ownerUserId: true,
    // `createdAt` is required by the cursor-pagination helper
    // (`computePageInfo`) — it's not rendered in the table.
    createdAt: true,
    owner: { select: { name: true } },
} as const;

/**
 * DORA Register of Information projection (Art. 28(3)).
 *
 * Deliberately its own SELECT rather than a widened `vendorListSelect`:
 * the register needs four columns the list page does not render
 * (`legalName`, `country`, `dataAccess`, `description`), and pulling them
 * into the shared shape would make every vendor list read heavier for the
 * benefit of one page.
 */
const informationRegisterSelect = {
    id: true,
    name: true,
    legalName: true,
    country: true,
    status: true,
    criticality: true,
    dataAccess: true,
    isSubprocessor: true,
    contractRenewalAt: true,
    nextReviewAt: true,
    owner: { select: { name: true } },
} as const;

/** Row shape returned by `VendorRepository.listInformationRegister`. */
export type InformationRegisterRow = Prisma.VendorGetPayload<{
    select: typeof informationRegisterSelect;
}>;

export class VendorRepository {
    /**
     * Every live ICT third-party arrangement, ordered by criticality so the
     * ones supporting critical or important functions lead the register.
     *
     * Soft-deleted vendors are excluded — a terminated arrangement is a
     * retention question, not a register row, and DORA's register describes
     * the arrangements currently in force.
     */
    static async listInformationRegister(
        db: PrismaTx,
        ctx: RequestContext,
        options: { take?: number } = {},
    ): Promise<InformationRegisterRow[]> {
        return db.vendor.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null },
            orderBy: [{ criticality: 'desc' }, { name: 'asc' }],
            select: informationRegisterSelect,
            take: options.take ?? 1000,
        });
    }

    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters: VendorFilters = {},
        options: { take?: number } = {},
    ) {
        const where = VendorRepository._buildWhere(ctx, filters);
        return db.vendor.findMany({
            where,
            orderBy: [{ criticality: 'desc' }, { name: 'asc' }],
            select: vendorListSelect,
            ...(options.take ? { take: options.take } : {}),
        });
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: VendorListParams): Promise<PaginatedResponse<unknown>> {
        const limit = clampLimit(params.limit);
        const where = VendorRepository._buildWhere(ctx, params.filters);

        const cursorWhere = buildCursorWhere(params.cursor);
        if (cursorWhere) {
            if (where.AND) {
                (where.AND as Prisma.VendorWhereInput[]).push(cursorWhere as Prisma.VendorWhereInput);
            } else {
                where.AND = [cursorWhere as Prisma.VendorWhereInput];
            }
        }

        const items = await db.vendor.findMany({
            where,
            orderBy: CURSOR_ORDER_BY,
            take: limit + 1,
            select: vendorListSelect,
        });

        const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
        return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
    }

    private static _buildWhere(ctx: RequestContext, filters: VendorFilters = {}): Prisma.VendorWhereInput {
        const where: Prisma.VendorWhereInput = { tenantId: ctx.tenantId };

        // Raw query-string values, NOT validated enums — see
        // `parseEnumListFilter`. The `as` casts these replace 500'd on any
        // two-value selection from the list page's multi-select facets.
        where.status = parseEnumListFilter<VendorStatus>(
            filters.status,
            Object.values(VendorStatus),
            'vendor status',
        );
        where.criticality = parseEnumListFilter<VendorCriticality>(
            filters.criticality,
            Object.values(VendorCriticality),
            'vendor criticality',
        );
        if (filters.riskRating) {
            // PR-T — "EVER rated": matches any historical assessment carrying this
            // rating. This is deliberately DIFFERENT from the vendor dashboard's
            // risk-rating buckets, which key off the LATEST assessment's rating
            // (getVendorMetrics loads `assessments` orderBy createdAt desc take 1).
            // Prisma relation filters can't express "the latest row has X" without
            // denormalisation, and the dashboard's metric is intentionally
            // assessment-derived (not the manually-editable inherentRisk), so the
            // filter is LABELLED "Ever rated {X}" (see vendors filter-defs i18n)
            // rather than silently disagreeing with the dashboard bucket.
            where.assessments = {
                some: {
                    riskRating: parseEnumListFilter<VendorCriticality>(
                        filters.riskRating,
                        Object.values(VendorCriticality),
                        'vendor risk rating',
                    ),
                },
            };
        }
        if (filters.q) {
            where.OR = [
                { name: { contains: filters.q, mode: 'insensitive' } },
                { legalName: { contains: filters.q, mode: 'insensitive' } },
                { domain: { contains: filters.q, mode: 'insensitive' } },
            ];
        }
        if (filters.reviewDue === 'overdue') {
            where.nextReviewAt = { lt: new Date() };
        } else if (filters.reviewDue === 'next30d') {
            const now = new Date();
            const in30 = new Date(now.getTime() + 30 * 86400000);
            where.nextReviewAt = { gte: now, lte: in30 };
        }

        return where;
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.vendor.findFirst({
            where: { id, tenantId: ctx.tenantId },
            include: {
                ...vendorIncludes,
                contacts: { orderBy: { name: 'asc' } },
            },
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: {
        name: string;
        legalName?: string | null;
        websiteUrl?: string | null;
        domain?: string | null;
        country?: string | null;
        description?: string | null;
        ownerUserId?: string | null;
        status?: string;
        criticality?: string;
        inherentRisk?: string | null;
        dataAccess?: string | null;
        isSubprocessor?: boolean;
        tags?: Prisma.InputJsonValue | null;
        nextReviewAt?: string | null;
        contractRenewalAt?: string | null;
    }) {
        return db.vendor.create({
            data: {
                tenantId: ctx.tenantId,
                name: data.name,
                legalName: data.legalName || null,
                websiteUrl: data.websiteUrl || null,
                domain: data.domain || null,
                country: data.country || null,
                description: data.description || null,
                ownerUserId: data.ownerUserId || null,
                status: (data.status as VendorStatus) ?? VendorStatus.ONBOARDING,
                criticality: (data.criticality as VendorCriticality) ?? VendorCriticality.MEDIUM,
                inherentRisk: (data.inherentRisk as VendorCriticality) ?? null,
                dataAccess: (data.dataAccess as VendorDataAccess) ?? null,
                isSubprocessor: data.isSubprocessor ?? false,
                tags: data.tags ? validateVendorTags(data.tags) : Prisma.JsonNull,
                nextReviewAt: data.nextReviewAt ? new Date(data.nextReviewAt) : null,
                contractRenewalAt: data.contractRenewalAt ? new Date(data.contractRenewalAt) : null,
            },
            include: vendorIncludes,
        });
    }

    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: {
        name?: string;
        legalName?: string | null;
        websiteUrl?: string | null;
        domain?: string | null;
        country?: string | null;
        description?: string | null;
        ownerUserId?: string | null;
        status?: string;
        criticality?: string;
        inherentRisk?: string | null;
        residualRisk?: string | null;
        dataAccess?: string | null;
        isSubprocessor?: boolean;
        tags?: Prisma.InputJsonValue | null;
        nextReviewAt?: string | null;
        contractRenewalAt?: string | null;
    }) {
        const existing = await db.vendor.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!existing) return null;

        return db.vendor.update({
            where: { id },
            data: {
                ...(data.name !== undefined && { name: data.name }),
                ...(data.legalName !== undefined && { legalName: data.legalName }),
                ...(data.websiteUrl !== undefined && { websiteUrl: data.websiteUrl }),
                ...(data.domain !== undefined && { domain: data.domain }),
                ...(data.country !== undefined && { country: data.country }),
                ...(data.description !== undefined && { description: data.description }),
                ...(data.ownerUserId !== undefined && { ownerUserId: data.ownerUserId }),
                ...(data.status !== undefined && { status: data.status as VendorStatus }),
                ...(data.criticality !== undefined && { criticality: data.criticality as VendorCriticality }),
                ...(data.inherentRisk !== undefined && { inherentRisk: (data.inherentRisk as VendorCriticality) ?? null }),
                ...(data.residualRisk !== undefined && { residualRisk: (data.residualRisk as VendorCriticality) ?? null }),
                ...(data.dataAccess !== undefined && { dataAccess: (data.dataAccess as VendorDataAccess) ?? null }),
                ...(data.isSubprocessor !== undefined && { isSubprocessor: data.isSubprocessor }),
                ...(data.tags !== undefined && { tags: data.tags ? validateVendorTags(data.tags) : Prisma.JsonNull }),
                ...(data.nextReviewAt !== undefined && { nextReviewAt: data.nextReviewAt ? new Date(data.nextReviewAt) : null }),
                ...(data.contractRenewalAt !== undefined && { contractRenewalAt: data.contractRenewalAt ? new Date(data.contractRenewalAt) : null }),
            },
            include: vendorIncludes,
        });
    }

    static async setStatus(db: PrismaTx, ctx: RequestContext, id: string, status: string) {
        const existing = await db.vendor.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!existing) return null;
        return db.vendor.update({ where: { id }, data: { status: status as VendorStatus } });
    }

    /** Fetch the tenant's vendors for the given ids (bulk-action audit source). */
    static async listByIds(db: PrismaTx, ctx: RequestContext, ids: string[]) {
        // Bounded by the `in: ids` set (bulk schemas cap at 100 ids); a `take:`
        // would be redundant.
        return db.vendor.findMany({ // guardrail-allow: unbounded
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
        data: Omit<Prisma.VendorUncheckedUpdateInput, 'tenantId'>,
    ) {
        return db.vendor.updateMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId },
            data,
        });
    }
}

export class VendorDocumentRepository {
    static async listByVendor(db: PrismaTx, ctx: RequestContext, vendorId: string) {
        return db.vendorDocument.findMany({
            where: { tenantId: ctx.tenantId, vendorId },
            orderBy: { createdAt: 'desc' },
            include: { uploadedBy: { select: { id: true, name: true, email: true } } },
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, vendorId: string, data: {
        type: string;
        fileId?: string | null;
        externalUrl?: string | null;
        title?: string | null;
        validFrom?: string | null;
        validTo?: string | null;
        notes?: string | null;
        folder?: string | null;
    }) {
        return db.vendorDocument.create({
            data: {
                tenantId: ctx.tenantId,
                vendorId,
                type: data.type as VendorDocumentType,
                fileId: data.fileId || null,
                externalUrl: data.externalUrl || null,
                title: data.title || null,
                validFrom: data.validFrom ? new Date(data.validFrom) : null,
                validTo: data.validTo ? new Date(data.validTo) : null,
                notes: data.notes || null,
                // B8 — free-text folder label. Trim + null-coerce so
                // empty input maps to "no folder", not "" (the
                // group-by code keys on null).
                folder: data.folder?.trim() || null,
                uploadedByUserId: ctx.userId,
            },
            include: { uploadedBy: { select: { id: true, name: true, email: true } } },
        });
    }

    static async deleteById(db: PrismaTx, ctx: RequestContext, docId: string) {
        const existing = await db.vendorDocument.findFirst({ where: { id: docId, tenantId: ctx.tenantId } });
        if (!existing) return null;
        return db.vendorDocument.delete({ where: { id: docId } });
    }
}

export class VendorLinkRepository {
    static async listByVendor(db: PrismaTx, ctx: RequestContext, vendorId: string) {
        return db.vendorLink.findMany({
            where: { tenantId: ctx.tenantId, vendorId },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Reverse "where-used" query: given a target entity, list the vendor
     * links pointing at it. Backed by the (tenantId, entityType, entityId)
     * index. Includes the vendor's id + name so callers can render a
     * "Linked vendors" section without an extra round-trip.
     */
    static async listByEntity(db: PrismaTx, ctx: RequestContext, entityType: string, entityId: string) {
        return db.vendorLink.findMany({
            where: { tenantId: ctx.tenantId, entityType: entityType as VendorLinkEntityType, entityId },
            orderBy: { createdAt: 'desc' },
            include: { vendor: { select: { id: true, name: true } } },
            take: 200,
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, vendorId: string, data: {
        entityType: string;
        entityId: string;
        relation?: string;
    }) {
        return db.vendorLink.create({
            data: {
                tenantId: ctx.tenantId,
                vendorId,
                entityType: data.entityType as VendorLinkEntityType,
                entityId: data.entityId,
                relation: (data.relation as VendorLinkRelation) ?? VendorLinkRelation.RELATED,
            },
        });
    }

    static async deleteById(db: PrismaTx, ctx: RequestContext, linkId: string) {
        const existing = await db.vendorLink.findFirst({ where: { id: linkId, tenantId: ctx.tenantId } });
        if (!existing) return null;
        return db.vendorLink.delete({ where: { id: linkId } });
    }
}
