/**
 * Agent register — repository.
 *
 * Every query filters by `tenantId` (defence in depth on top of RLS). All reads
 * and writes run inside `runInTenantContext` at the usecase layer, so `db` here
 * is always the tenant-bound client.
 *
 * The soft-delete rail is `deletedAt IS NULL` on every read. `status` is a
 * separate axis: SUSPENDED is the kill switch (reversible), RETIRED is the end
 * of an agent's life, and neither is a delete.
 */
import { Prisma, AgentStatus } from '@prisma/client';
import type {
    AgentDataAccessScope,
    AgentProvenance,
    AgentReversibility,
} from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { parseEnumListFilter } from '../domain/list-filter';

const listSelect = {
    id: true,
    tenantId: true,
    aiSystemId: true,
    name: true,
    autonomyLevel: true,
    dataAccessScope: true,
    reversibility: true,
    provenance: true,
    status: true,
    riskTier: true,
    riskTierScoredAt: true,
    ownerUserId: true,
    vendorId: true,
    isLegacyPlaceholder: true,
    createdAt: true,
    // The accountable human, by name. The register's whole job is to say who
    // answers for an agent, and a bare user id answers for nothing on a page.
    owner: { select: { id: true, name: true } },
    // The EU AI Act tier, from the required register entry. Shown BESIDE the
    // agent's own `riskTier` and never merged with it: one is the Regulation's
    // classification of the system, the other is operational authority. A LOW
    // agent inside a HIGH AI system is an ordinary combination.
    aiSystem: { select: { id: true, riskTier: true, classificationClauseId: true } },
    // How many credentials speak for this agent — the number that decides
    // whether suspending it actually stops anything.
    _count: { select: { apiKeys: true } },
} as const satisfies Prisma.RegisteredAgentSelect;

export interface RegisteredAgentWriteFields {
    name: string;
    description: string | null;
    autonomyLevel: number;
    dataAccessScope: AgentDataAccessScope;
    reversibility: AgentReversibility;
    provenance: AgentProvenance;
    ownerUserId: string;
    vendorId: string | null;
}

export class RegisteredAgentRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        options: { take?: number; status?: string } = {},
    ) {
        return db.registeredAgent.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                // A raw `?status=` query-string value. `parseEnumListFilter`
                // rejects an unknown or comma-joined value here rather than
                // letting Prisma turn it into a 500 one layer down.
                status: parseEnumListFilter<AgentStatus>(
                    options.status,
                    Object.values(AgentStatus),
                    'agent status',
                ),
            },
            select: listSelect,
            orderBy: [{ createdAt: 'desc' }],
            take: options.take ?? 200,
        });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.registeredAgent.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { ...listSelect, description: true, updatedAt: true },
        });
    }

    static async create(
        db: PrismaTx,
        ctx: RequestContext,
        data: RegisteredAgentWriteFields & { aiSystemId: string },
    ) {
        return db.registeredAgent.create({
            data: {
                tenantId: ctx.tenantId,
                createdByUserId: ctx.userId,
                ...data,
            },
            select: { id: true, status: true, riskTier: true },
        });
    }

    /**
     * Conditional update — the `tenantId` predicate is part of the WHERE, so a
     * caller naming another tenant's id updates ZERO rows rather than throwing.
     * The count is the caller's evidence that the row was theirs.
     */
    static async update(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        data: Partial<RegisteredAgentWriteFields>,
    ): Promise<number> {
        const res = await db.registeredAgent.updateMany({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            data,
        });
        return res.count;
    }

    /** Kill switch / lifecycle move. Same conditional-update contract. */
    static async setStatus(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        status: AgentStatus,
    ): Promise<number> {
        const res = await db.registeredAgent.updateMany({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            data: { status },
        });
        return res.count;
    }
}
