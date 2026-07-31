import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, AssetType, AssetStatus, Criticality } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import { withDeleted } from '@/lib/soft-delete';
import { parseEnumListFilter } from '../domain/list-filter';

export interface AssetFilters {
    type?: string;
    status?: string;
    criticality?: string;
    q?: string;
}

export interface AssetListParams {
    limit?: number;
    cursor?: string;
    filters?: AssetFilters;
}

/**
 * Hard ceiling for the flat (non-paginated) `list` / `listDeleted` reads.
 * The list page windows client-side over the returned array, so it needs the
 * full set — but "full" must still be bounded so one tenant can never pull an
 * unbounded row count in a single query. Tenants above this use the cursor-
 * paginated `listPaginated` path.
 */
const FLAT_LIST_CAP = 1000;

export class AssetRepository {
    static async list(db: PrismaTx, ctx: RequestContext, filters?: AssetFilters) {
        const where = AssetRepository._buildWhere(ctx, filters);
        return db.asset.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: FLAT_LIST_CAP,
            include: {
                _count: { select: { controls: true } },
                ownerUser: { select: { id: true, name: true, email: true } },
            },
        });
    }

    /**
     * Deleted-assets view: ONLY soft-deleted rows, honouring the same
     * type/status/criticality/q filters as the live list. `withDeleted` opts
     * out of the soft-delete read-filter; the explicit `deletedAt: { not: null }`
     * then narrows to just the deleted set (opting out alone would return
     * everything). Includes the who/when lifecycle columns.
     */
    static async listDeleted(db: PrismaTx, ctx: RequestContext, filters?: AssetFilters) {
        const where = AssetRepository._buildWhere(ctx, filters);
        where.deletedAt = { not: null };
        return db.asset.findMany(withDeleted({
            where,
            orderBy: { deletedAt: 'desc' as const },
            take: FLAT_LIST_CAP,
            include: {
                _count: { select: { controls: true } },
                ownerUser: { select: { id: true, name: true, email: true } },
            },
        }));
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: AssetListParams): Promise<PaginatedResponse<unknown>> {
        const limit = clampLimit(params.limit);
        const where = AssetRepository._buildWhere(ctx, params.filters);

        const cursorWhere = buildCursorWhere(params.cursor);
        if (cursorWhere) {
            if (where.AND) {
                (where.AND as Prisma.AssetWhereInput[]).push(cursorWhere as Prisma.AssetWhereInput);
            } else {
                where.AND = [cursorWhere as Prisma.AssetWhereInput];
            }
        }

        const items = await db.asset.findMany({
            where,
            orderBy: CURSOR_ORDER_BY,
            take: limit + 1,
            include: {
                _count: { select: { controls: true } },
                ownerUser: { select: { id: true, name: true, email: true } },
            },
        });

        const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
        return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
    }

    private static _buildWhere(ctx: RequestContext, filters?: AssetFilters): Prisma.AssetWhereInput {
        const where: Prisma.AssetWhereInput = { tenantId: ctx.tenantId };

        // Raw query-string values, NOT validated enums — see
        // `parseEnumListFilter`. The `as` casts these replace 500'd on any
        // two-value selection from the list page's multi-select facets
        // (`?status=ACTIVE,ONBOARDING` reached Prisma as one literal string).
        where.type = parseEnumListFilter<AssetType>(
            filters?.type,
            Object.values(AssetType),
            'asset type',
        );
        where.status = parseEnumListFilter<AssetStatus>(
            filters?.status,
            Object.values(AssetStatus),
            'asset status',
        );
        where.criticality = parseEnumListFilter<Criticality>(
            filters?.criticality,
            Object.values(Criticality),
            'asset criticality',
        );
        if (filters?.q) {
            where.OR = [
                { name: { contains: filters.q, mode: 'insensitive' } },
                { classification: { contains: filters.q, mode: 'insensitive' } },
                // Legacy free-text owner (import fallback) …
                { owner: { contains: filters.q, mode: 'insensitive' } },
                // … AND the resolved assignee's name/email, so searching by the
                // owner set in the UI (ownerUserId) actually matches.
                { ownerUser: { is: { name: { contains: filters.q, mode: 'insensitive' } } } },
                { ownerUser: { is: { email: { contains: filters.q, mode: 'insensitive' } } } },
            ];
        }

        return where;
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.asset.findFirst({
            where: { id, tenantId: ctx.tenantId },
            include: {
                controls: { include: { control: true } },
                ownerUser: { select: { id: true, name: true, email: true } },
            },
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: Omit<Prisma.AssetUncheckedCreateInput, 'tenantId'>) {
        // Mint a per-tenant `AST-N` key from an atomic counter.
        // Mirrors `RiskRepository.create` / the TaskKeySequence
        // pattern — the upsert compiles to a native
        // `INSERT … ON CONFLICT DO UPDATE`, race-free under
        // concurrent imports. Callers that supply their own `key`
        // (the migration backfill path / future imports) win — we
        // only mint when none is set.
        let key = (data as { key?: string | null }).key ?? null;
        if (!key) {
            const seq = await db.assetKeySequence.upsert({
                where: { tenantId: ctx.tenantId },
                create: { tenantId: ctx.tenantId, lastValue: 1 },
                update: { lastValue: { increment: 1 } },
            });
            key = `AST-${seq.lastValue}`;
        }
        return db.asset.create({
            data: {
                ...data,
                key,
                tenantId: ctx.tenantId,
            },
        });
    }

    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: Omit<Prisma.AssetUncheckedUpdateInput, 'tenantId'>) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return null;

        return db.asset.update({
            where: { id },
            data,
        });
    }

    /** Fetch the tenant's assets for the given ids (bulk-action audit source). */
    static async listByIds(db: PrismaTx, ctx: RequestContext, ids: string[]) {
        // Bounded by the `in: ids` set (bulk schemas cap at 100 ids); a `take:`
        // would be redundant.
        return db.asset.findMany({ // guardrail-allow: unbounded
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
        data: Omit<Prisma.AssetUncheckedUpdateInput, 'tenantId'>,
    ) {
        return db.asset.updateMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId },
            data,
        });
    }

    static async delete(db: PrismaTx, ctx: RequestContext, id: string) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return false;

        await db.asset.delete({ where: { id } });
        return true;
    }
}
