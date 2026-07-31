import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, EvidenceType, EvidenceStatus } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import { traceRepository } from '@/lib/observability/repository-tracing';
import type { EvidenceRetentionMetrics } from '@/lib/evidence-review-currency';
import { parseEnumListFilter } from '../domain/list-filter';

export interface EvidenceListFilters {
    type?: string;
    /** EvidenceStatus: DRAFT | SUBMITTED | APPROVED | REJECTED */
    status?: string;
    controlId?: string;
    /** EP-3 Part 5 — category filter (exact match). */
    category?: string;
    /** Tag filter — exact match on the normalised (lower-cased) tag. */
    tag?: string;
    /**
     * B8 follow-up — folder filter. `__none__` is the sentinel for
     * "evidence with NULL or empty folder"; any other value is an
     * exact-match. Omitted ⇒ no filter.
     */
    folder?: string;
    q?: string;
    archived?: boolean;
    expiring?: boolean;
}

export interface EvidenceListParams {
    limit?: number;
    cursor?: string;
    filters?: EvidenceListFilters;
}

// PR-3 — tight SELECT shape for the Evidence list page. Lists exactly
// the columns EvidenceClient.tsx renders. The previous `include`
// returned every Evidence scalar (encrypted-at-rest `data` blob,
// `summary`, `transcript`, etc.) — none rendered in list view.
const evidenceListSelect = {
    id: true,
    title: true,
    fileName: true,
    type: true,
    status: true,
    // The note body / link URL. Selected so the list-row edit affordance
    // can seed the body field — without it the edit modal opened blank
    // and a save silently blanked the note. NOT prose for FILE rows (it
    // is the storage pathKey there); see @/lib/evidence-content.
    content: true,
    // EP-3 Part 5 — category is now a rendered column + filter.
    category: true,
    owner: true,
    // Real owner FK — seeds the edit modal's owner picker when the
    // Evidence list-row edit affordance opens it (B8 follow-up parity
    // with the detail sheet's edit).
    ownerUserId: true,
    // B8 follow-up — folder label is rendered as a column + drives
    // the Folder filter's option set.
    folder: true,
    isArchived: true,
    expiredAt: true,
    deletedAt: true,
    retentionUntil: true,
    // EP-2 — review-currency drives the freshness badge + the
    // freshness filter/KPIs. `nextReviewDate` (primary anchor) +
    // `reviewCycle` (cadence) surface the review schedule.
    nextReviewDate: true,
    reviewCycle: true,
    updatedAt: true,
    dateCollected: true,
    fileRecordId: true,
    // `createdAt` is required by the cursor-pagination helper
    // (`computePageInfo`) — it's not rendered in the table.
    createdAt: true,
    // EP-3 — linked controls now come through the join. The list row
    // renders the count + first control's label; the detail sheet reads
    // the full set via getById.
    evidenceControlLinks: {
        select: { control: { select: { id: true, name: true, annexId: true, code: true } } },
    },
    fileRecord: { select: { id: true, mimeType: true, scanStatus: true } },
    // Tag chips on the list row + the tag filter's client-side match.
    tags: { select: { tag: true }, orderBy: { tag: 'asc' } },
} as const;

export class EvidenceRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters?: EvidenceListFilters,
        options: { take?: number } = {},
    ) {
        return traceRepository('evidence.list', ctx, async () => {
            const where = EvidenceRepository._buildWhere(ctx, filters);
            return db.evidence.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                select: evidenceListSelect,
                ...(options.take ? { take: options.take } : {}),
            });
        });
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: EvidenceListParams): Promise<PaginatedResponse<unknown>> {
        return traceRepository('evidence.listPaginated', ctx, async () => {
            const limit = clampLimit(params.limit);
            const where = EvidenceRepository._buildWhere(ctx, params.filters);

            // Apply cursor
            const cursorWhere = buildCursorWhere(params.cursor);
            if (cursorWhere) {
                if (where.AND) {
                    (where.AND as Prisma.EvidenceWhereInput[]).push(cursorWhere as Prisma.EvidenceWhereInput);
                } else {
                    where.AND = [cursorWhere as Prisma.EvidenceWhereInput];
                }
            }

            const items = await db.evidence.findMany({
                where,
                orderBy: CURSOR_ORDER_BY,
                take: limit + 1,
                select: evidenceListSelect,
            });

            const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
            return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
        });
    }

    private static _buildWhere(ctx: RequestContext, filters?: EvidenceListFilters): Prisma.EvidenceWhereInput {
        const where: Prisma.EvidenceWhereInput = { tenantId: ctx.tenantId };
        const andConditions: Prisma.EvidenceWhereInput[] = [];

        // Raw query-string values, NOT validated enum filters — see
        // `parseEnumListFilter`. The `as Prisma.Enum…Filter` casts these
        // replace 500'd on any two-value selection from the list page's
        // multi-select facets. (The route's Zod schema narrows `status` to
        // the enum, but only ONE member at a time — it cannot express the
        // comma-joined form the UI actually sends, and `type` was unnarrowed
        // either way.)
        where.type = parseEnumListFilter<EvidenceType>(
            filters?.type,
            Object.values(EvidenceType),
            'evidence type',
        );
        where.status = parseEnumListFilter<EvidenceStatus>(
            filters?.status,
            Object.values(EvidenceStatus),
            'evidence status',
        );
        if (filters?.controlId) {
            // EP-3 — filter through the many-to-many join.
            where.evidenceControlLinks = { some: { controlId: filters.controlId } };
        }
        if (filters?.category) {
            where.category = filters.category;
        }
        if (filters?.tag) {
            // Indexed join lookup on the normalised value — see
            // EvidenceTag's @@index([tenantId, tag]).
            where.tags = { some: { tag: filters.tag.trim().toLowerCase() } };
        }
        if (filters?.folder) {
            // B8 follow-up — `__none__` matches rows with a NULL
            // or empty-string folder; any other value is exact.
            if (filters.folder === '__none__') {
                where.OR = [
                    { folder: null },
                    { folder: '' },
                ];
            } else {
                where.folder = filters.folder;
            }
        }
        if (filters?.archived !== undefined) {
            where.isArchived = filters.archived;
        }
        if (filters?.expiring) {
            // Evidence expiring within 30 days
            const soon = new Date();
            soon.setDate(soon.getDate() + 30);
            where.retentionUntil = { lte: soon };
        }
        if (filters?.q) {
            andConditions.push({
                OR: [
                    { title: { contains: filters.q, mode: 'insensitive' } },
                    { content: { contains: filters.q, mode: 'insensitive' } },
                    { fileName: { contains: filters.q, mode: 'insensitive' } },
                ],
            });
        }

        if (andConditions.length > 0) {
            where.AND = andConditions;
        }

        return where;
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return traceRepository('evidence.getById', ctx, async () => {
            return db.evidence.findFirst({
                where: { id, tenantId: ctx.tenantId },
                include: {
                    // EP-3 — the "used by N controls" where-used list.
                    evidenceControlLinks: {
                        select: {
                            id: true,
                            controlId: true,
                            createdAt: true,
                            control: { select: { id: true, name: true, annexId: true, code: true } },
                        },
                        orderBy: { createdAt: 'asc' },
                    },
                    // The where-used footprint: one artifact can now be
                    // reused across many controls, risks AND assets, so the
                    // sheet reports all three rather than a single source.
                    evidenceRiskLinks: {
                        select: {
                            id: true,
                            riskId: true,
                            risk: { select: { id: true, key: true, title: true } },
                        },
                        orderBy: { createdAt: 'asc' },
                    },
                    evidenceAssetLinks: {
                        select: {
                            id: true,
                            assetId: true,
                            asset: { select: { id: true, key: true, name: true } },
                        },
                        orderBy: { createdAt: 'asc' },
                    },
                    tags: { select: { id: true, tag: true }, orderBy: { tag: 'asc' } },
                    // Source task / risk / asset — powers the "uploaded
                    // from" back-reference on the evidence detail sheet.
                    task: { select: { id: true, key: true, title: true } },
                    risk: { select: { id: true, key: true, title: true } },
                    asset: { select: { id: true, key: true, name: true } },
                    reviews: { include: { reviewer: { select: { name: true, email: true } } }, orderBy: { createdAt: 'desc' } },
                    // EP-2 — file metadata (name/size/MIME/SHA-256 +
                    // retention) powering the detail sheet's inline
                    // preview, download affordance, and metadata block.
                    fileRecord: {
                        select: {
                            id: true,
                            originalName: true,
                            mimeType: true,
                            sizeBytes: true,
                            sha256: true,
                            retentionUntil: true,
                            // R5-P2 #1 — the UI must know the AV verdict so it can
                            // refuse download/preview of an INFECTED/PENDING file
                            // before the server has to (and never auto-<img> it).
                            scanStatus: true,
                            scannedAt: true,
                        },
                    },
                },
            });
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: Omit<Prisma.EvidenceUncheckedCreateInput, 'tenantId'>) {
        return traceRepository('evidence.create', ctx, async () => {
            return db.evidence.create({
                data: {
                    ...data,
                    tenantId: ctx.tenantId,
                },
            });
        });
    }

    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: Omit<Prisma.EvidenceUncheckedUpdateInput, 'tenantId'>) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return null;

        return db.evidence.update({
            where: { id },
            data,
        });
    }

    static async addReview(db: PrismaTx, ctx: RequestContext, evidenceId: string, action: 'SUBMITTED' | 'APPROVED' | 'REJECTED', comment?: string | null) {
        return db.evidenceReview.create({
            data: {
                tenantId: ctx.tenantId,
                evidenceId,
                reviewerId: ctx.userId,
                action,
                comment,
            },
        });
    }

    /**
     * Segregation-of-duties source: for each evidence id, the reviewer
     * who last SUBMITTED it. One `findMany` (newest-first) reduced into a
     * per-evidence map — no per-id read (query-shape guardrails). Rows
     * without a SUBMITTED review are simply absent from the map; the
     * caller falls back to `Evidence.ownerUserId`.
     */
    static async getLatestSubmitters(
        db: PrismaTx,
        ctx: RequestContext,
        evidenceIds: string[],
    ): Promise<Map<string, string>> {
        const map = new Map<string, string>();
        if (evidenceIds.length === 0) return map;
        const reviews = await db.evidenceReview.findMany({ // guardrail-allow: unbounded
            where: {
                tenantId: ctx.tenantId,
                evidenceId: { in: evidenceIds },
                action: 'SUBMITTED',
            },
            select: { evidenceId: true, reviewerId: true },
            orderBy: { createdAt: 'desc' },
        });
        // Newest-first ⇒ the first row seen per evidence is the latest.
        for (const r of reviews) {
            if (!map.has(r.evidenceId)) map.set(r.evidenceId, r.reviewerId);
        }
        return map;
    }

    /** Fetch the tenant's evidence for the given ids (bulk-action audit source). */
    static async listByIds(db: PrismaTx, ctx: RequestContext, ids: string[]) {
        // Bounded by the `in: ids` set (bulk schemas cap at 100 ids); a `take:`
        // would be redundant.
        return db.evidence.findMany({ // guardrail-allow: unbounded
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
        data: Omit<Prisma.EvidenceUncheckedUpdateInput, 'tenantId'>,
    ) {
        return db.evidence.updateMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId },
            data,
        });
    }

    /**
     * EP-4 — authoritative tenant-wide retention/KPI aggregate.
     *
     * Computed by DB aggregate over the FULL dataset (not the ≤100-row SSR
     * page the list loads), so the Evidence KPI strips + the "all current"
     * celebration are correct on large tenants. A fixed 5 queries — one
     * `groupBy(status)` plus four `count`s — never a per-row loop. Bucket
     * definitions mirror `evidenceFreshnessBucket` so the server counts
     * agree with the per-row badge the table renders.
     */
    static async retentionMetrics(
        db: PrismaTx,
        ctx: RequestContext,
    ): Promise<EvidenceRetentionMetrics> {
        return traceRepository('evidence.retentionMetrics', ctx, async () => {
            const tenantId = ctx.tenantId;
            const now = new Date();
            const soon = new Date(now.getTime() + 30 * 86_400_000);
            // Soft-deleted rows are excluded everywhere (parity with the
            // client's per-row pass, which `continue`s on `deletedAt`).
            const base = { tenantId, deletedAt: null } as const;
            // NEEDS_REVIEW wins the freshness bucket outright, so the
            // expired/expiring counts exclude it to stay mutually exclusive.
            const nonReview = {
                ...base,
                status: { not: 'NEEDS_REVIEW' as const },
            };

            const [byStatusRaw, archived, active, expired, expiringSoon] =
                await Promise.all([
                    db.evidence.groupBy({
                        by: ['status'],
                        where: base,
                        _count: true,
                    }),
                    db.evidence.count({ where: { ...base, isArchived: true } }),
                    db.evidence.count({
                        where: { ...base, isArchived: false, expiredAt: null },
                    }),
                    // expired: expiredAt set, OR (no expiredAt) the review date
                    // lapsed, OR (no review date) the retention date lapsed.
                    db.evidence.count({
                        where: {
                            ...nonReview,
                            OR: [
                                { expiredAt: { not: null } },
                                { expiredAt: null, nextReviewDate: { not: null, lt: now } },
                                {
                                    expiredAt: null,
                                    nextReviewDate: null,
                                    retentionUntil: { not: null, lt: now },
                                },
                            ],
                        },
                    }),
                    // expiring: not expired, review date within 30d (else the
                    // retention date within 30d when no review date is set).
                    db.evidence.count({
                        where: {
                            ...nonReview,
                            expiredAt: null,
                            OR: [
                                { nextReviewDate: { not: null, gte: now, lte: soon } },
                                {
                                    nextReviewDate: null,
                                    retentionUntil: { not: null, gte: now, lte: soon },
                                },
                            ],
                        },
                    }),
                ]);

            const byStatus = {
                DRAFT: 0,
                SUBMITTED: 0,
                APPROVED: 0,
                REJECTED: 0,
                NEEDS_REVIEW: 0,
            } as EvidenceRetentionMetrics['byStatus'];
            let total = 0;
            for (const g of byStatusRaw) {
                const count = g._count;
                total += count;
                if (g.status in byStatus) {
                    byStatus[g.status as keyof typeof byStatus] = count;
                }
            }
            const needsReview = byStatus.NEEDS_REVIEW;
            // Every non-deleted row lands in exactly one freshness bucket, so
            // `current` is the arithmetic remainder — no extra query.
            const current = Math.max(
                0,
                total - needsReview - expired - expiringSoon,
            );

            return {
                total,
                byStatus,
                active,
                archived,
                expiringSoon,
                expired,
                needsReview,
                current,
            };
        });
    }

    // ─── EP-3 — evidence↔control join management ───

    /**
     * Return the control ids that exist in this tenant among `controlIds`.
     * One bounded `findMany` — the caller compares the returned set against
     * its input to reject foreign/unknown controls.
     */
    static async filterExistingControlIds(
        db: PrismaTx,
        ctx: RequestContext,
        controlIds: string[],
    ): Promise<Set<string>> {
        if (controlIds.length === 0) return new Set();
        const rows = await db.control.findMany({ // guardrail-allow: unbounded
            where: { id: { in: controlIds }, tenantId: ctx.tenantId },
            select: { id: true },
        });
        return new Set(rows.map((r) => r.id));
    }

    /** The control ids currently linked to this evidence. */
    static async listControlLinks(db: PrismaTx, ctx: RequestContext, evidenceId: string) {
        return db.evidenceControlLink.findMany({ // guardrail-allow: unbounded
            where: { tenantId: ctx.tenantId, evidenceId },
            select: { id: true, controlId: true },
        });
    }

    /**
     * Create one EvidenceControlLink. Idempotent on the
     * (tenant, evidence, control) unique — a duplicate insert is swallowed
     * so re-linking is a no-op. Returns true if a NEW row was created.
     */
    static async linkControl(
        db: PrismaTx,
        ctx: RequestContext,
        evidenceId: string,
        controlId: string,
    ): Promise<boolean> {
        const existing = await db.evidenceControlLink.findUnique({
            where: {
                tenantId_evidenceId_controlId: {
                    tenantId: ctx.tenantId,
                    evidenceId,
                    controlId,
                },
            },
            select: { id: true },
        });
        if (existing) return false;
        await db.evidenceControlLink.create({
            data: {
                tenantId: ctx.tenantId,
                evidenceId,
                controlId,
                createdByUserId: ctx.userId,
            },
        });
        return true;
    }

    /** Remove one EvidenceControlLink. Returns the deleted count (0 or 1). */
    static async unlinkControl(
        db: PrismaTx,
        ctx: RequestContext,
        evidenceId: string,
        controlId: string,
    ): Promise<number> {
        const res = await db.evidenceControlLink.deleteMany({
            where: { tenantId: ctx.tenantId, evidenceId, controlId },
        });
        return res.count;
    }

    /** Create links for many controls at once (skips duplicates). */
    static async createControlLinks(
        db: PrismaTx,
        ctx: RequestContext,
        evidenceId: string,
        controlIds: string[],
    ): Promise<void> {
        if (controlIds.length === 0) return;
        await db.evidenceControlLink.createMany({
            data: controlIds.map((controlId) => ({
                tenantId: ctx.tenantId,
                evidenceId,
                controlId,
                createdByUserId: ctx.userId,
            })),
            skipDuplicates: true,
        });
    }

    /**
     * Reconcile an evidence row's tags to exactly `tags`.
     *
     * Tags are normalised (trimmed + lower-cased) so "SOC2", "soc2" and
     * " soc2 " are one tag — the unique key is on the normalised value,
     * and a filter that matched case-sensitively would be useless as an
     * organisation dimension.
     */
    static async setTags(
        db: PrismaTx,
        ctx: RequestContext,
        evidenceId: string,
        tags: string[],
    ): Promise<void> {
        const normalised = [...new Set(
            tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
        )];
        await db.evidenceTag.deleteMany({
            where: {
                tenantId: ctx.tenantId,
                evidenceId,
                ...(normalised.length > 0 ? { tag: { notIn: normalised } } : {}),
            },
        });
        if (normalised.length === 0) return;
        await db.evidenceTag.createMany({
            data: normalised.map((tag) => ({ tenantId: ctx.tenantId, evidenceId, tag })),
            skipDuplicates: true,
        });
    }

    /** Distinct tags in use, for the filter's option set. */
    static async listTenantTags(db: PrismaTx, ctx: RequestContext): Promise<string[]> {
        const rows = await db.evidenceTag.findMany({
            where: { tenantId: ctx.tenantId },
            select: { tag: true },
            distinct: ['tag'],
            orderBy: { tag: 'asc' },
            take: 500,
        });
        return rows.map((r) => r.tag);
    }
}
