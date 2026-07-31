import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, RiskStatus, TreatmentDecision } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import { traceRepository } from '@/lib/observability/repository-tracing';
import { parseEnumListFilter } from '../domain/list-filter';

export interface RiskFilters {
    status?: string;
    scoreMin?: number;
    scoreMax?: number;
    category?: string;
    ownerUserId?: string;
    q?: string;
    // PR-K — after-controls posture + treatment/quant filters so a
    // reviewer can slice the register by residual score, treatment
    // decision, and whether a risk is quantified (has an ALE).
    residualScoreMin?: number;
    residualScoreMax?: number;
    treatment?: string;
    /**
     * Exact (likelihood, impact) matrix cell(s) as comma-joined
     * `L{likelihood}xI{impact}` tokens (e.g. `L2xI6,L3xI4`). Distinct from
     * `scoreMin/Max`: score is the PRODUCT, so a score range cannot express
     * "this one cell" — 2×6 and 3×4 both score 12. The heatmap drill-down
     * uses this so a cell click lands on exactly that cell's risks.
     */
    cell?: string;
    /** 'yes' → has a FAIR ALE or an SLE×ARO pair; 'no' → neither. */
    quantified?: 'yes' | 'no';
    /**
     * Restrict to an explicit id set. PR-K resolves the multi-signal
     * staleness detector (`getRiskStaleness`) to a stale-risk id list in
     * the usecase, then passes it here so the "stale/overdue" register
     * filter runs server-side (respects pagination + no-client-filtering).
     */
    idIn?: string[];
}

export interface RiskListParams {
    limit?: number;
    cursor?: string;
    filters?: RiskFilters;
}

// PR-3 — tight SELECT shape for the Risks list page. Lists exactly the
// columns RisksClient.tsx renders. The previous `include: { controls }`
// returned all Risk scalars (incl. long-text `description`, `mitigation`,
// `treatmentNotes` cipher blob, etc.); the page only uses the metadata
// + scoring fields enumerated below.
const riskListSelect = {
    id: true,
    // PR-B — RSK-N short identifier surfaced as the Code column.
    key: true,
    title: true,
    threat: true,
    likelihood: true,
    impact: true,
    inherentScore: true,
    score: true,
    status: true,
    treatment: true,
    treatmentOwner: true,
    nextReviewAt: true,
    category: true,
    ownerUserId: true,
    // RQ2-5 — quant inputs for the list-side ALE chip + the matrix
    // ALE heat overlay (`resolveALE` runs client-side on these).
    sleAmount: true,
    aroAmount: true,
    fairAle: true,
    // RQ2-9 — decomposed residual dims power the matrix movement
    // view (inherent → residual arrows). Null for legacy rows.
    residualLikelihood: true,
    residualImpact: true,
    residualScore: true,
    // `createdAt` is required by the cursor-pagination helper
    // (`computePageInfo`) — it's not rendered in the table.
    createdAt: true,
    controls: {
        select: {
            id: true,
            control: { select: { id: true, name: true, annexId: true, status: true } },
        },
    },
} as const;

export class RiskRepository {
    /**
     * List risks scoped to tenant (unpaginated — backward compat).
     */
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters: RiskFilters = {},
        options: { take?: number } = {},
    ) {
        return traceRepository('risk.list', ctx, async () => {
            const where = RiskRepository._buildWhere(ctx, filters);
            return db.risk.findMany({
                where,
                orderBy: { inherentScore: 'desc' },
                select: riskListSelect,
                ...(options.take ? { take: options.take } : {}),
            });
        });
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: RiskListParams): Promise<PaginatedResponse<unknown>> {
        return traceRepository('risk.listPaginated', ctx, async () => {
            const limit = clampLimit(params.limit);
            const where = RiskRepository._buildWhere(ctx, params.filters);

            const cursorWhere = buildCursorWhere(params.cursor);
            if (cursorWhere) {
                where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), cursorWhere as Prisma.RiskWhereInput];
            }

            const items = await db.risk.findMany({
                where,
                orderBy: CURSOR_ORDER_BY,
                take: limit + 1,
                select: riskListSelect,
            });

            const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
            return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
        });
    }

    private static _buildWhere(ctx: RequestContext, filters: RiskFilters = {}): Prisma.RiskWhereInput {
        const where: Prisma.RiskWhereInput = { tenantId: ctx.tenantId };

        // `status` is raw query-string input, NOT a validated enum. It was
        // cast straight onto the column (`as RiskStatus`), which 500'd on
        // both reachable shapes: a comma-joined multi-select
        // (`?status=OPEN,MITIGATING`) and a value carried over from another
        // list page (`?status=ACTIVE` — an AssetStatus/VendorStatus, never a
        // RiskStatus). Prisma rejects both with a validation error that maps
        // to 500, and `/risks` reads the same filters in its Server
        // Component, so the whole section fell over.
        where.status = parseEnumListFilter<RiskStatus>(
            filters.status,
            Object.values(RiskStatus),
            'risk status',
        );
        // An empty id set means "no stale risks" — return nothing, not all.
        if (filters.idIn !== undefined) where.id = { in: filters.idIn };
        if (filters.scoreMin !== undefined || filters.scoreMax !== undefined) {
            where.score = {};
            if (filters.scoreMin !== undefined) where.score.gte = filters.scoreMin;
            if (filters.scoreMax !== undefined) where.score.lte = filters.scoreMax;
        }
        if (filters.cell) {
            // Parse `L{l}xI{i}` tokens → an OR over exact (likelihood, impact)
            // pairs. Composed under AND so it never clobbers the `q` search OR.
            const pairs = filters.cell
                .split(',')
                .map((tok) => /^L(\d+)xI(\d+)$/i.exec(tok.trim()))
                .filter((m): m is RegExpExecArray => m !== null)
                .map((m) => ({ likelihood: Number(m[1]), impact: Number(m[2]) }));
            if (pairs.length > 0) {
                where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), { OR: pairs }];
            }
        }
        if (filters.category) where.category = filters.category;
        if (filters.ownerUserId) where.ownerUserId = filters.ownerUserId;
        if (filters.residualScoreMin !== undefined || filters.residualScoreMax !== undefined) {
            where.residualScore = {};
            if (filters.residualScoreMin !== undefined) where.residualScore.gte = filters.residualScoreMin;
            if (filters.residualScoreMax !== undefined) where.residualScore.lte = filters.residualScoreMax;
        }
        // `treatment` already handled the comma-joined multi-select, but
        // still cast the members onto the enum unchecked — so an unknown
        // decision was the same 500 as `status`.
        where.treatment = parseEnumListFilter<TreatmentDecision>(
            filters.treatment,
            Object.values(TreatmentDecision),
            'risk treatment',
        );
        if (filters.quantified) {
            // Quantified = a FAIR ALE OR a legacy SLE×ARO pair. Compose via
            // AND (not top-level OR) so it never clobbers the `q` search OR.
            const quantifiedClause: Prisma.RiskWhereInput =
                filters.quantified === 'yes'
                    ? {
                          OR: [
                              { fairAle: { not: null } },
                              { AND: [{ sleAmount: { not: null } }, { aroAmount: { not: null } }] },
                          ],
                      }
                    : {
                          fairAle: null,
                          OR: [{ sleAmount: null }, { aroAmount: null }],
                      };
            where.AND = [
                ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
                quantifiedClause,
            ];
        }
        if (filters.q) {
            where.OR = [
                { title: { contains: filters.q, mode: 'insensitive' } },
                { description: { contains: filters.q, mode: 'insensitive' } },
                { category: { contains: filters.q, mode: 'insensitive' } },
            ];
        }

        return where;
    }

    /**
     * Get a single risk by ID, scoped to tenant.
     */
    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return traceRepository('risk.getById', ctx, async () => {
            return db.risk.findFirst({
                where: { id, tenantId: ctx.tenantId },
                include: {
                    controls: { include: { control: true } },
                },
            });
        });
    }

    /**
     * Create a risk scoped to tenant.
     */
    static async create(db: PrismaTx, ctx: RequestContext, data: Omit<Prisma.RiskUncheckedCreateInput, 'tenantId'>) {
        return traceRepository('risk.create', ctx, async () => {
            // PR-B — mint a per-tenant `RSK-N` key from an atomic
            // counter. Mirrors `WorkItemRepository.create` / the
            // `TaskKeySequence` pattern: the upsert compiles to a
            // native `INSERT … ON CONFLICT DO UPDATE`, so the
            // increment is race-free under concurrent imports.
            // Callers that supply their own `key` (the migration
            // backfill path) win — we only mint when none is set.
            let key = (data as { key?: string | null }).key ?? null;
            if (!key) {
                const seq = await db.riskKeySequence.upsert({
                    where: { tenantId: ctx.tenantId },
                    create: { tenantId: ctx.tenantId, lastValue: 1 },
                    update: { lastValue: { increment: 1 } },
                });
                key = `RSK-${seq.lastValue}`;
            }
            return db.risk.create({
                data: {
                    ...data,
                    key,
                    tenantId: ctx.tenantId,
                },
            });
        });
    }

    /**
     * Update a risk, enforcing tenant ownership.
     */
    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: Omit<Prisma.RiskUncheckedUpdateInput, 'tenantId'>) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return null;

        return db.risk.update({
            where: { id },
            data,
        });
    }

    /**
     * Delete a risk, enforcing tenant ownership.
     */
    static async delete(db: PrismaTx, ctx: RequestContext, id: string) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return false;

        await db.risk.delete({ where: { id } });
        return true;
    }

    /**
     * Link a control to a risk.
     *
     * BOTH sides must live in the caller's tenant. The join row is stamped
     * with `ctx.tenantId` regardless, so verifying only the risk (the URL id)
     * would let a body-supplied `controlId` from another tenant be linked in —
     * a cross-tenant reference forged through an otherwise-authorised call.
     * Returns null (→ 404 at the route) when either side is missing, so the
     * id namespace stays non-enumerable.
     */
    static async linkControl(db: PrismaTx, ctx: RequestContext, riskId: string, controlId: string) {
        const [existing, control] = await Promise.all([
            this.getById(db, ctx, riskId),
            db.control.findFirst({
                where: { id: controlId, tenantId: ctx.tenantId },
                select: { id: true },
            }),
        ]);
        if (!existing || !control) return null;

        return db.riskControl.create({
            data: { tenantId: ctx.tenantId, riskId, controlId },
        });
    }

    /**
     * Unlink a control from a risk.
     */
    static async unlinkControl(db: PrismaTx, ctx: RequestContext, riskId: string, controlId: string) {
        const existing = await this.getById(db, ctx, riskId);
        if (!existing) return null;

        const link = await db.riskControl.findFirst({
            where: { riskId, controlId, tenantId: ctx.tenantId },
        });
        if (!link) return null;

        await db.riskControl.delete({ where: { id: link.id } });
        return true;
    }

    /** Fetch the tenant's risks for the given ids (bulk-action audit source). */
    static async listByIds(db: PrismaTx, ctx: RequestContext, ids: string[]) {
        // Bounded by the `in: ids` set (bulk schemas cap at 100 ids); a `take:`
        // would be redundant.
        return db.risk.findMany({ // guardrail-allow: unbounded
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
        data: Omit<Prisma.RiskUncheckedUpdateInput, 'tenantId'>,
    ) {
        return db.risk.updateMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId },
            data,
        });
    }
}
