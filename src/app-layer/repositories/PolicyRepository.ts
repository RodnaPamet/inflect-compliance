import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, PolicyStatus } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import { parseEnumListFilter } from '../domain/list-filter';

/** Counts backing the six KPI filter cards on the Policies list page. */
export interface PolicyKpiCounts {
    total: number;
    draft: number;
    inReview: number;
    approved: number;
    overdueReview: number;
    outstandingAck: number;
}

export interface PolicyFilters {
    status?: string;
    category?: string;
    language?: string;
    q?: string;
    /** Review-cycle bucket: 'overdue' (nextReviewAt past) | 'upcoming' (≤30d). */
    reviewBucket?: 'overdue' | 'upcoming';
    /**
     * Restrict to policies whose CURRENT version has an unmet mandatory
     * acknowledgement. Resolved SERVER-side (see `outstandingAckVersionIds`)
     * and folded into the `where` as a `currentVersionId IN (…)`, so the filter
     * survives pagination instead of being a post-fetch client predicate.
     */
    outstandingAck?: boolean;
}

/** Per-version assigned ∧ acknowledged counts, keyed by policyVersionId. */
export interface AckCountRow {
    policyVersionId: string;
    assigned: number;
    acked: number;
}

export interface PolicyListParams {
    limit?: number;
    cursor?: string;
    filters?: PolicyFilters;
}

// PR-3 — tight SELECT shape for the Policies list page. Replaces the
// previous `include: { currentVersion: true }` which dragged in the
// (encrypted) `currentVersion.contentText` blob plus several body
// fields the page never reads. Trimmed to exactly what
// PoliciesClient.tsx renders.
const policyListSelect = {
    id: true,
    slug: true,
    title: true,
    description: true,
    status: true,
    category: true,
    nextReviewAt: true,
    updatedAt: true,
    ownerUserId: true,
    lifecycleVersion: true,
    // `createdAt` is required by the cursor-pagination helper
    // (`computePageInfo`) — it's not rendered in the table.
    createdAt: true,
    owner: { select: { id: true, name: true, email: true } },
    currentVersion: { select: { id: true, versionNumber: true } },
    _count: { select: { versions: true, controlLinks: true, approvals: true } },
} as const;

export class PolicyRepository {
    /**
     * Assigned ∧ acknowledged counts for a set of policy versions — ONE
     * aggregate, no row fetch, no cap.
     *
     * Completion is DERIVED: `PolicyAcknowledgementAssignment` records the
     * requirement and `PolicyAcknowledgement` records the act, with no relation
     * between them, so the LEFT JOIN on `(policyVersionId, userId)` is what
     * makes `acked` the INTERSECTION. A plain `groupBy` over acknowledgements
     * would wrongly count a VOLUNTARY ack by a non-assigned user and under-report
     * the outstanding set.
     *
     * Tenant scoping is belt-and-braces: the JOIN to PolicyVersion pins
     * `tenantId` explicitly, and RLS independently enforces the same via its
     * EXISTS-on-PolicyVersion policy (this runs inside `runInTenantContext`).
     */
    static async ackCountsByVersion(
        db: PrismaTx,
        ctx: RequestContext,
        versionIds: string[],
    ): Promise<AckCountRow[]> {
        // `Prisma.join` rejects an empty list — and there is nothing to count.
        if (versionIds.length === 0) return [];
        return db.$queryRaw<AckCountRow[]>`
            SELECT a."policyVersionId"      AS "policyVersionId",
                   COUNT(*)::int            AS "assigned",
                   COUNT(k."userId")::int   AS "acked"
            FROM "PolicyAcknowledgementAssignment" a
            JOIN "PolicyVersion" pv
              ON pv.id = a."policyVersionId"
             AND pv."tenantId" = ${ctx.tenantId}
            LEFT JOIN "PolicyAcknowledgement" k
              ON k."policyVersionId" = a."policyVersionId"
             AND k."userId" = a."userId"
            WHERE a."policyVersionId" IN (${Prisma.join(versionIds)})
            GROUP BY a."policyVersionId"
        `;
    }

    /**
     * Policy-version ids carrying an UNMET mandatory acknowledgement, for the
     * server-side `outstandingAck` filter. Same derivation as above, expressed
     * as `HAVING assigned > acked` — the SQL twin of
     * `hasOutstandingAcknowledgement` (assignedCount > 0 is implied: a version
     * with no assignments produces no group).
     */
    static async outstandingAckVersionIds(
        db: PrismaTx,
        ctx: RequestContext,
    ): Promise<string[]> {
        const rows = await db.$queryRaw<Array<{ policyVersionId: string }>>`
            SELECT a."policyVersionId" AS "policyVersionId"
            FROM "PolicyAcknowledgementAssignment" a
            JOIN "PolicyVersion" pv
              ON pv.id = a."policyVersionId"
             AND pv."tenantId" = ${ctx.tenantId}
            LEFT JOIN "PolicyAcknowledgement" k
              ON k."policyVersionId" = a."policyVersionId"
             AND k."userId" = a."userId"
            GROUP BY a."policyVersionId"
            HAVING COUNT(*) > COUNT(k."userId")
        `;
        return rows.map((r) => r.policyVersionId);
    }

    /**
     * Resolve the `outstandingAck` filter into a concrete `currentVersionId`
     * restriction. An empty result must narrow to ZERO rows (the facet was
     * requested and matched nothing) — never silently drop the filter.
     */
    private static async _applyOutstandingAck(
        db: PrismaTx,
        ctx: RequestContext,
        where: Prisma.PolicyWhereInput,
        filters?: PolicyFilters,
    ): Promise<Prisma.PolicyWhereInput> {
        if (!filters?.outstandingAck) return where;
        const ids = await PolicyRepository.outstandingAckVersionIds(db, ctx);
        return { ...where, currentVersionId: { in: ids } };
    }

    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters?: PolicyFilters,
        options: { take?: number } = {},
    ) {
        const where = await PolicyRepository._applyOutstandingAck(
            db,
            ctx,
            PolicyRepository._buildWhere(ctx, filters),
            filters,
        );
        return db.policy.findMany({
            where,
            orderBy: { updatedAt: 'desc' },
            select: policyListSelect,
            ...(options.take ? { take: options.take } : {}),
        });
    }

    /**
     * Counts for the KPI filter cards.
     *
     * Each number answers exactly one question: "how many rows will I see if
     * I click this card". That is the only contract a FILTER card can honour
     * — a number that does not predict its own click is worse than no number,
     * because the user reads it as a promise.
     *
     * They were previously derived client-side from the loaded array, which
     * is the current-filter result capped at LIST_BACKFILL_CAP (and merely
     * the first SSR_PAGE_LIMIT rows before the SWR backfill lands), while
     * every card's filter resolves against the whole tenant. So a card could
     * read 3 and produce 47.
     *
     * The shapes below mirror each def's `apply` in PoliciesClient — change
     * one and you must change the other, which is why the mapping is spelled
     * out rather than inferred:
     *   total          clearAll()                  -> tenant, no filters
     *   draft/inReview/approved
     *                  set('status', X)            -> current filters, status replaced
     *   overdueReview  set('reviewBucket','overdue')
     *   outstandingAck set('outstanding','true')
     */
    static async kpiCounts(
        db: PrismaTx,
        ctx: RequestContext,
        filters?: PolicyFilters,
    ): Promise<PolicyKpiCounts> {
        // Status is replaced (not intersected) by the status cards, so the
        // groupBy runs over the other active filters only.
        const withoutStatus: PolicyFilters | undefined = filters
            ? { ...filters, status: undefined }
            : undefined;
        const statusWhere = await PolicyRepository._applyOutstandingAck(
            db,
            ctx,
            PolicyRepository._buildWhere(ctx, withoutStatus),
            withoutStatus,
        );

        const overdueFilters: PolicyFilters = { ...(filters ?? {}), reviewBucket: 'overdue' };
        const ackFilters: PolicyFilters = { ...(filters ?? {}), outstandingAck: true };

        const [byStatus, total, overdueReview, outstandingAck] = await Promise.all([
            db.policy.groupBy({
                by: ['status'],
                where: statusWhere,
                _count: { _all: true },
            }),
            db.policy.count({ where: { tenantId: ctx.tenantId } }),
            db.policy.count({
                where: await PolicyRepository._applyOutstandingAck(
                    db,
                    ctx,
                    PolicyRepository._buildWhere(ctx, overdueFilters),
                    overdueFilters,
                ),
            }),
            db.policy.count({
                where: await PolicyRepository._applyOutstandingAck(
                    db,
                    ctx,
                    PolicyRepository._buildWhere(ctx, ackFilters),
                    ackFilters,
                ),
            }),
        ]);

        const statusCount = (...wanted: PolicyStatus[]) =>
            byStatus
                .filter((g) => wanted.includes(g.status))
                .reduce((n, g) => n + g._count._all, 0);

        return {
            total,
            draft: statusCount(PolicyStatus.DRAFT),
            inReview: statusCount(PolicyStatus.IN_REVIEW),
            // APPROVED *and* PUBLISHED — the card has always displayed both,
            // and its `apply` now selects both to match. Counting one set and
            // filtering to another is the same class of lie as counting a
            // page and filtering a tenant.
            approved: statusCount(PolicyStatus.APPROVED, PolicyStatus.PUBLISHED),
            overdueReview,
            outstandingAck,
        };
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: PolicyListParams): Promise<PaginatedResponse<unknown>> {
        const limit = clampLimit(params.limit);
        const where = await PolicyRepository._applyOutstandingAck(
            db,
            ctx,
            PolicyRepository._buildWhere(ctx, params.filters),
            params.filters,
        );

        const cursorWhere = buildCursorWhere(params.cursor);
        if (cursorWhere) {
            if (where.AND) {
                (where.AND as Prisma.PolicyWhereInput[]).push(cursorWhere as Prisma.PolicyWhereInput);
            } else {
                where.AND = [cursorWhere as Prisma.PolicyWhereInput];
            }
        }

        const items = await db.policy.findMany({
            where,
            orderBy: CURSOR_ORDER_BY,
            take: limit + 1,
            select: policyListSelect,
        });

        const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
        return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
    }

    private static _buildWhere(ctx: RequestContext, filters?: PolicyFilters): Prisma.PolicyWhereInput {
        const where: Prisma.PolicyWhereInput = { tenantId: ctx.tenantId };
        // Raw query-string value, NOT a validated enum filter — see
        // `parseEnumListFilter`. The `as Prisma.EnumPolicyStatusFilter` cast
        // this replaces 500'd on any two-value selection from the list page's
        // multi-select facet.
        where.status = parseEnumListFilter<PolicyStatus>(
            filters?.status,
            Object.values(PolicyStatus),
            'policy status',
        );
        if (filters?.category) where.category = filters.category;
        if (filters?.language) where.language = filters.language;
        if (filters?.q) {
            where.OR = [
                { title: { contains: filters.q, mode: 'insensitive' } },
                { description: { contains: filters.q, mode: 'insensitive' } },
            ];
        }
        // Review-cycle bucket. `overdue` = nextReviewAt in the past; `upcoming`
        // = due within the next 30 days. Makes "policies overdue for review"
        // findable from the list (previously only surfaced via email reminders).
        if (filters?.reviewBucket === 'overdue') {
            where.nextReviewAt = { lt: new Date() };
        } else if (filters?.reviewBucket === 'upcoming') {
            const now = new Date();
            const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
            where.nextReviewAt = { gte: now, lte: in30 };
        }
        return where;
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.policy.findFirst({
            where: { id, tenantId: ctx.tenantId },
            include: {
                currentVersion: {
                    include: {
                        createdBy: { select: { id: true, name: true } },
                    },
                },
                owner: { select: { id: true, name: true, email: true } },
                versions: {
                    orderBy: { versionNumber: 'desc' },
                    include: {
                        createdBy: { select: { id: true, name: true } },
                        approvals: {
                            include: {
                                requestedBy: { select: { id: true, name: true } },
                                approvedBy: { select: { id: true, name: true } },
                            },
                        },
                    },
                },
                // Top-level approvals so `policy.approvals` is defined — the
                // IN_REVIEW ApprovalBanner reads the pending approval off the
                // detail payload, not the per-version nesting (previously
                // undefined, so the banner never rendered).
                approvals: {
                    orderBy: { createdAt: 'desc' },
                    include: {
                        requestedBy: { select: { id: true, name: true } },
                        approvedBy: { select: { id: true, name: true } },
                    },
                },
                controlLinks: {
                    include: {
                        control: { select: { id: true, name: true, annexId: true } },
                    },
                },
                evidenceItems: {
                    orderBy: { sortOrder: 'asc' },
                    include: {
                        evidence: { select: { id: true, title: true, type: true, retentionUntil: true } },
                    },
                },
            },
        });
    }

    static async getBySlug(db: PrismaTx, ctx: RequestContext, slug: string) {
        return db.policy.findFirst({
            where: { slug, tenantId: ctx.tenantId },
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: {
        slug: string;
        title: string;
        description?: string | null;
        category?: string | null;
        ownerUserId?: string | null;
        reviewFrequencyDays?: number | null;
        nextReviewAt?: Date | null;
        language?: string | null;
    }) {
        return db.policy.create({
            data: {
                tenantId: ctx.tenantId,
                slug: data.slug,
                title: data.title,
                description: data.description,
                category: data.category,
                ownerUserId: data.ownerUserId,
                reviewFrequencyDays: data.reviewFrequencyDays,
                nextReviewAt: data.nextReviewAt,
                language: data.language || 'en',
                status: 'DRAFT',
            },
        });
    }

    static async updateMetadata(db: PrismaTx, ctx: RequestContext, id: string, data: {
        title?: string;
        description?: string | null;
        category?: string | null;
        ownerUserId?: string | null;
        reviewFrequencyDays?: number | null;
        nextReviewAt?: Date | null;
        lastReviewedAt?: Date | null;
        language?: string | null;
    }) {
        return db.policy.updateMany({
            where: { id, tenantId: ctx.tenantId },
            data,
        });
    }

    static async updateStatus(db: PrismaTx, ctx: RequestContext, id: string, status: string) {
        return db.policy.updateMany({
            where: { id, tenantId: ctx.tenantId },
            data: { status: status as PolicyStatus },
        });
    }

    static async setCurrentVersion(db: PrismaTx, ctx: RequestContext, id: string, versionId: string | null) {
        return db.policy.updateMany({
            where: { id, tenantId: ctx.tenantId },
            data: { currentVersionId: versionId },
        });
    }

    /** Fetch the tenant's policies for the given ids (bulk-action audit source). */
    static async listByIds(db: PrismaTx, ctx: RequestContext, ids: string[]) {
        // Bounded by the `in: ids` set (bulk schemas cap at 100 ids); a `take:`
        // would be redundant.
        return db.policy.findMany({ // guardrail-allow: unbounded
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
        data: Omit<Prisma.PolicyUncheckedUpdateInput, 'tenantId'>,
    ) {
        return db.policy.updateMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId },
            data,
        });
    }
}
