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
    AgentRiskTier,
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
    /**
     * The declared underlying model. Present here because `MODEL_CHANGED` is an
     * assessment staleness trigger and a trigger with no write path can never
     * fire — this field was missing from the write shape, so the column was
     * permanently NULL and the comparison behind it permanently false.
     */
    modelRef: string | null;
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
            // `modelRef` is on the DETAIL read, not `listSelect`: it is one
            // agent's declaration, not a column any register list renders.
            select: { ...listSelect, description: true, modelRef: true, updatedAt: true },
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

    /**
     * The five scorer inputs plus the granted-tool count — everything the agent
     * risk assessment needs to score and to detect staleness, in ONE read.
     *
     * A separate selection from `listSelect` on purpose: that one is the
     * OPERATOR's view of an agent (owner name, AI-Act tier, credential count)
     * and this one is the SCORER's. Widening `listSelect` to serve both would
     * mean every list page pays for columns it never renders, and — worse —
     * that a future trim of a column nobody could see on a page would silently
     * change what the scorer reads.
     */
    static async getScoringState(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.registeredAgent.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: {
                id: true,
                name: true,
                autonomyLevel: true,
                dataAccessScope: true,
                reversibility: true,
                provenance: true,
                // The supplier, for the merged-row attribution rule in
                // `updateRegisteredAgent`. A THIRD_PARTY agent must name a
                // vendor, and an edit that strips the vendor names no
                // provenance — so the check needs both halves of the row it is
                // about to become, not just the half the payload carries.
                vendorId: true,
                modelRef: true,
                riskTier: true,
                riskTierScoredAt: true,
                _count: { select: { tools: true } },
            },
        });
    }

    /**
     * Write a scored tier back onto the agent.
     *
     * The two columns move TOGETHER — a CHECK constraint pins
     * `riskTier IS NULL` ⇔ `riskTierScoredAt IS NULL`, so a tier can never be
     * read without knowing how old it is. That is why this takes both and why
     * there is no method that sets one of them.
     */
    static async setRiskTier(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        riskTier: AgentRiskTier,
        scoredAt: Date,
    ): Promise<number> {
        const res = await db.registeredAgent.updateMany({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            data: { riskTier, riskTierScoredAt: scoredAt },
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
