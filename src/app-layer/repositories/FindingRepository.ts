import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, FindingStatus } from '@prisma/client';
import { parseEnumListFilter } from '../domain/list-filter';

// PR-3 — tight SELECT shape for the Findings list page. Drops the
// encrypted free-text scalars (`description`, `rootCause`,
// `correctiveAction`, …) that the list never renders (detail loads them
// separately). It DOES carry the lightweight `audit` provenance relation
// (feat/audit-cycle-unify) so the register can show a finding's originating
// audit + cycle without a second query.
const findingListSelect = {
    id: true,
    title: true,
    severity: true,
    type: true,
    owner: true,
    status: true,
    assignee: { select: { id: true, name: true, email: true } },
    control: { select: { id: true, code: true, name: true } },
    // feat/audit-cycle-unify — surface the finding's audit/cycle provenance
    // in the register (a finding raised during an audit keeps its context).
    audit: {
        select: {
            id: true,
            title: true,
            auditCycleId: true,
            auditCycle: { select: { id: true, name: true } },
        },
    },
    _count: { select: { riskLinks: true } },
} as const;

export class FindingRepository {
    /**
     * `status` is the register's facet, raw off the query string
     * (`OPEN,IN_PROGRESS`); an unknown member is a 400, never a silent
     * zero-row match.
     */
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        options: { take?: number; status?: string } = {},
    ) {
        return db.finding.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: parseEnumListFilter<FindingStatus>(
                    options.status,
                    Object.values(FindingStatus),
                    'finding status',
                ),
            },
            orderBy: { createdAt: 'desc' },
            select: findingListSelect,
            ...(options.take ? { take: options.take } : {}),
        });
    }

    /**
     * Findings tagged with a given provenance source (e.g. all
     * NIS2_SELF_ASSESSMENT findings). Indexed by
     * [tenantId, sourceKind, sourceRef]. Used by materializers to dedupe +
     * reconcile. Bounded.
     */
    static async listBySource(db: PrismaTx, ctx: RequestContext, sourceKind: string) {
        return db.finding.findMany({
            where: { tenantId: ctx.tenantId, sourceKind, deletedAt: null },
            select: { id: true, sourceRef: true, status: true, title: true },
            take: 1000,
        });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.finding.findFirst({
            where: { id, tenantId: ctx.tenantId },
            include: {
                audit: { select: { id: true, title: true } },
                evidenceLinks: { include: { evidence: true } },
                assignee: { select: { id: true, name: true, email: true } },
                control: { select: { id: true, code: true, name: true } },
                compensatingControl: { select: { id: true, code: true, name: true } },
                riskLinks: {
                    include: {
                        risk: { select: { id: true, key: true, title: true } },
                    },
                },
            },
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: Omit<Prisma.FindingUncheckedCreateInput, 'tenantId'>) {
        return db.finding.create({
            data: {
                ...data,
                tenantId: ctx.tenantId,
            },
        });
    }

    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: Omit<Prisma.FindingUncheckedUpdateInput, 'tenantId'>) {
        const existing = await this.getById(db, ctx, id);
        if (!existing) return null;

        return db.finding.update({
            where: { id },
            data,
        });
    }
}
