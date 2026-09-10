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
    // The accountable human, by name AND by email. The register's whole job is
    // to say who answers for an agent, and a bare user id answers for nothing
    // on a page.
    //
    // The email is here because `ownerUserId` is NOT NULL behind a real FK
    // while `User.name` is nullable: a row with no name is an owner whose
    // DISPLAY NAME was never set, never an agent nobody owns. Without a second
    // identifier the only fallback left is a phrase, and the register — the
    // surface whose entire question is "who is accountable for this agent" —
    // answers it with prose instead of with somebody a reader can go and ask.
    // Same shape the control, policy and vendor registers already select.
    owner: { select: { id: true, name: true, email: true } },
    // The EU AI Act tier, from the required register entry. Shown BESIDE the
    // agent's own `riskTier` and never merged with it: one is the Regulation's
    // classification of the system, the other is operational authority. A LOW
    // agent inside a HIGH AI system is an ordinary combination.
    aiSystem: { select: { id: true, riskTier: true, classificationClauseId: true } },
    // The supplier, by name. `vendor` is the composite `[vendorId, tenantId]`
    // relation, so it cannot resolve another tenant's supplier — the same FK
    // the create path is checked against. Selected because a THIRD_PARTY
    // agent's profile could otherwise offer a link to the vendor record and
    // never the name: a third-party accountability surface unable to say which
    // third party.
    vendor: { select: { id: true, name: true } },
    // How many credentials are BOUND to this agent — every key that still
    // carries its `agentId`, including revoked and expired ones.
    //
    // Deliberately UNFILTERED here, and `getById` overrides it with the live
    // count rather than this select being narrowed. Two reasons, and the first
    // is a bug: a `where` on `expiresAt` would need a `new Date()`, and this
    // object is built ONCE at module import, so a long-lived process would
    // compare every request against the "now" of the last deploy. The second
    // is meaning: the register's Keys column has always counted bound keys,
    // and filtering here would silently change what that column says without
    // touching the page that renders it.
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
            select: {
                ...listSelect,
                description: true,
                modelRef: true,
                updatedAt: true,
                // The count of credentials that are STILL ACCEPTED, replacing
                // the spread's bound count. `TenantApiKey` keeps revoked rows
                // (`revokedAt` set, never deleted) and expired ones, and both
                // keep their `agentId` — so "3 API keys" on a suspend dialog
                // was never a count of what stops being accepted, and an agent
                // holding three dead keys read as an agent whose suspension cut
                // off traffic that had already stopped.
                //
                // It lives HERE, inside the method, precisely because of the
                // `new Date()`: evaluated per call, it is the real now. The
                // same expression in the module-level `listSelect` is evaluated
                // once at import and freezes "now" at process start.
                //
                // THE DEFINITION OF "LIVE" IS NOT OURS. It is
                // `checkCredentialLiveness` in
                // `src/lib/agentic/agent-credential-state.ts`, which the MCP
                // funnel re-asks once per TOOL CALL and which is therefore the
                // only answer that decides anything:
                //
                //     if (row.revokedAt !== null) return 'revoked';
                //     if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime())
                //         return 'expired';
                //
                // The `where` below is that predicate restated in SQL so the
                // page can count rows instead of fetching them, and the two
                // must agree at the boundary as well as in the middle: `<= now`
                // is dead there, so `> now` is live here, and a NULL expiry is
                // live in both. IF A COLUMN IS EVER ADDED TO THAT FUNCTION — a
                // `disabledAt`, a tenant-level freeze — IT MUST BE ADDED HERE
                // TOO, or this page will keep counting credentials the boundary
                // has already stopped accepting, which is the exact class of
                // lie this change exists to remove. There is no shared
                // expression to import: one is a JavaScript predicate over a
                // fetched row and the other a Prisma filter, so the coupling is
                // this comment and the back-reference beside the function.
                _count: {
                    select: {
                        apiKeys: {
                            where: {
                                revokedAt: null,
                                // NULL expiry is "no expiry", not "expired at
                                // the epoch" — Prisma would drop the row from
                                // a bare `gt` comparison.
                                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                            },
                        },
                    },
                },
            },
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
