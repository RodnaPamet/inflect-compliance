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
import { Prisma, AgentStatus, AgentDataAccessScope, AgentRiskTier } from '@prisma/client';
import type { AgentProvenance, AgentReversibility } from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { parseEnumListFilter } from '../domain/list-filter';

/**
 * The register's LIST FILTERS, as the page's own filter keys.
 *
 * Parsed from the query string by `parseAgentListFilters` below and applied in
 * SQL — NOT over the loaded rows. The register used to SSR every agent and
 * re-filter in the browser, which is survivable while the table is the only
 * consumer and is not survivable the moment a KPI card quotes a number: the
 * card's filter resolves against the whole tenant while the array it would be
 * counted from is capped, so the card reads 3 and the click produces 47. That
 * is #1905, and it is the reason both halves moved to the database together.
 */
export interface AgentListFilters {
    status?: readonly AgentStatus[];
    dataAccessScope?: readonly AgentDataAccessScope[];
    /**
     * The AUTHORITY TIER filter, with `UNSCORED` as a first-class member
     * rather than an absence.
     *
     * `riskTier` is NULL for an agent nobody has assessed, and every consumer
     * reads NULL as DENY — so "not yet scored" is the single most important
     * thing this register can be filtered to, and a filter that could only
     * name the four real tiers could not express it. `UNSCORED` maps to
     * `riskTier: null`, never to a tier, and never to "no filter".
     */
    riskTier?: readonly AgentTierFilterValue[];
}

/** `UNSCORED` is not an `AgentRiskTier` — see `AgentListFilters.riskTier`. */
export const AGENT_TIER_UNSCORED = 'UNSCORED';

export type AgentTierFilterValue = AgentRiskTier | typeof AGENT_TIER_UNSCORED;

export const AGENT_TIER_FILTER_VALUES: readonly AgentTierFilterValue[] = [
    AGENT_TIER_UNSCORED,
    ...Object.values(AgentRiskTier),
] as const;

/**
 * The four numbers above the register's table.
 *
 * Each one answers exactly one question: "how many rows will I see if I click
 * this card". That is the only contract a FILTER card can honour — a number
 * that does not predict its own click is worse than no number, because the
 * reader takes it as a promise.
 */
export interface AgentKpiCounts {
    /** Tenant-wide, ignoring every active filter — the card calls `clearAll()`. */
    total: number;
    /** Current filters with `status` REPLACED by ACTIVE. */
    active: number;
    /** Current filters with `riskTier` REPLACED by UNSCORED (`riskTier IS NULL`). */
    unscored: number;
    /** Current filters with `dataAccessScope` REPLACED by EXTERNAL_EGRESS. */
    egress: number;
}

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
    /**
     * The register's WHERE clause, built once and shared by the list and every
     * KPI count.
     *
     * ONE builder, deliberately. The four cards each promise the row count
     * their own click produces, and the only way a card and its destination
     * cannot disagree is for both to be the same SQL predicate with one term
     * swapped. Two hand-written predicates that "should match" is exactly the
     * arrangement that let a card read 3 and filter to 47.
     */
    static _buildWhere(
        ctx: RequestContext,
        filters: AgentListFilters = {},
    ): Prisma.RegisteredAgentWhereInput {
        const where: Prisma.RegisteredAgentWhereInput = {
            tenantId: ctx.tenantId,
            deletedAt: null,
        };
        if (filters.status && filters.status.length > 0) {
            where.status = { in: [...filters.status] };
        }
        if (filters.dataAccessScope && filters.dataAccessScope.length > 0) {
            where.dataAccessScope = { in: [...filters.dataAccessScope] };
        }
        if (filters.riskTier && filters.riskTier.length > 0) {
            // UNSCORED is `riskTier IS NULL`, and it composes with real tiers:
            // selecting UNSCORED and HIGH together must yield both, so the two
            // halves go into an OR rather than one overwriting the other.
            const wantsUnscored = filters.riskTier.includes(AGENT_TIER_UNSCORED);
            const tiers = filters.riskTier.filter(
                (t): t is AgentRiskTier => t !== AGENT_TIER_UNSCORED,
            );
            const arms: Prisma.RegisteredAgentWhereInput[] = [];
            if (wantsUnscored) arms.push({ riskTier: null });
            if (tiers.length > 0) arms.push({ riskTier: { in: tiers } });
            // `arms` is never empty here — the enclosing `if` guarantees at
            // least one member, and every member is either UNSCORED or a tier.
            where.OR = arms;
        }
        return where;
    }

    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        options: { take?: number; status?: string; filters?: AgentListFilters } = {},
    ) {
        // `options.status` is the RAW `?status=` query-string form the HTTP
        // route has always passed, kept for that caller; `options.filters` is
        // the parsed shape the register page passes. When both are absent the
        // predicate is the tenant's whole live register, as before.
        const rawStatus = parseEnumListFilter<AgentStatus>(
            options.status,
            Object.values(AgentStatus),
            'agent status',
        );
        const where = RegisteredAgentRepository._buildWhere(ctx, options.filters);
        return db.registeredAgent.findMany({
            where: rawStatus === undefined ? where : { ...where, status: rawStatus },
            select: listSelect,
            orderBy: [{ createdAt: 'desc' }],
            take: options.take ?? 200,
        });
    }

    /**
     * The four register KPI numbers, by aggregate.
     *
     * Follows `PolicyRepository.kpiCounts` and is wired the same way at the
     * usecase seam. The mapping below is SPELLED OUT rather than inferred,
     * because each line is a promise about one click and the page's card
     * handlers have to make the same move:
     *
     *   total     clearAll()                            -> tenant, NO filters
     *   active    set('status', 'ACTIVE')               -> current filters, status replaced
     *   unscored  set('riskTier', 'UNSCORED')           -> current filters, tier replaced
     *   egress    set('dataAccessScope', 'EXTERNAL_EGRESS')
     *                                                  -> current filters, scope replaced
     *
     * REPLACED, not intersected: `set` on the filter context overwrites the
     * key. So each count drops the term its own card owns and keeps the rest,
     * which is what makes the number survive having another filter already on.
     */
    static async kpiCounts(
        db: PrismaTx,
        ctx: RequestContext,
        filters: AgentListFilters = {},
    ): Promise<AgentKpiCounts> {
        const replacing = <K extends keyof AgentListFilters>(
            key: K,
            value: AgentListFilters[K],
        ): Prisma.RegisteredAgentWhereInput =>
            RegisteredAgentRepository._buildWhere(ctx, { ...filters, [key]: value });

        const [total, active, unscored, egress] = await Promise.all([
            // `total` is the ONLY unfiltered count, and that is not an
            // oversight: its card calls `clearAll()`, so the tenant-wide
            // number is precisely what the click produces. Intersecting it
            // with the active filters would make the card disagree with
            // itself the moment any filter was set.
            db.registeredAgent.count({
                where: RegisteredAgentRepository._buildWhere(ctx, {}),
            }),
            db.registeredAgent.count({ where: replacing('status', [AgentStatus.ACTIVE]) }),
            db.registeredAgent.count({ where: replacing('riskTier', [AGENT_TIER_UNSCORED]) }),
            db.registeredAgent.count({
                where: replacing('dataAccessScope', [AgentDataAccessScope.EXTERNAL_EGRESS]),
            }),
        ]);

        return { total, active, unscored, egress };
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
                        // THE RETIREMENT CASCADE, PREVIEWED (#3698). Retiring an
                        // agent expires every PENDING proposal and drops every
                        // tool grant (`applyRetirementCascadeInTx`), and the retire
                        // dialog states both numbers BEFORE the operator commits —
                        // an irreversible act should say what it will change, not
                        // report it afterwards.
                        //
                        // Each predicate here is the cascade's own: PENDING is
                        // what it expires, and every grant is what it deletes. If
                        // either widens there, it must widen here, or the dialog
                        // understates what the click does. `apiKeys` above is the
                        // LIVE count, which is what stops being accepted; the
                        // cascade also revokes keys that had already expired, and
                        // its audit row reports both figures.
                        proposals: { where: { status: 'PENDING' } },
                        tools: true,
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
     *
     * `ownerUserId` is excluded by TYPE: after registration the owner moves only
     * through `moveOwner`, the completion of a two-step transfer (#3698).
     */
    static async update(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        data: Partial<Omit<RegisteredAgentWriteFields, 'ownerUserId'>>,
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

    /**
     * The columns a lifecycle move — or an ownership transfer — decides on, and
     * nothing else: whether the agent exists here, where it is on its
     * lifecycle, who owns it, and the names an audit row about it carries
     * (`aiSystemId` so a transfer can record the register entry's own owner
     * beside the agent's).
     */
    static async getLifecycleState(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.registeredAgent.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, status: true, name: true, ownerUserId: true, aiSystemId: true },
        });
    }

    /**
     * `getLifecycleState`, read `FOR SHARE` — the same columns, with the agent
     * row's share lock held until the caller's transaction ends.
     *
     * For a caller that is about to lock a row that depends on the agent (step
     * one of an ownership transfer, #3698) and so must take the agent row FIRST,
     * the order retirement and completion take it in. `FOR SHARE` conflicts with
     * their UPDATE of this row, so it waits for either to commit and then
     * returns what it left — a RETIRED status included — and it does not
     * conflict with another share reader. Prisma has no locking read, hence the
     * raw statement; it runs on the caller's tenant-bound client, under RLS.
     */
    static async lockLifecycleStateForShare(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
    ): Promise<{
        id: string;
        status: AgentStatus;
        name: string;
        ownerUserId: string;
        aiSystemId: string;
    } | null> {
        const rows = await db.$queryRaw<
            Array<{ id: string; status: AgentStatus; name: string; ownerUserId: string; aiSystemId: string }>
        >`
            SELECT "id", "status", "name", "ownerUserId", "aiSystemId"
              FROM "RegisteredAgent"
             WHERE "id" = ${id} AND "tenantId" = ${ctx.tenantId} AND "deletedAt" IS NULL
               FOR SHARE`;
        return rows[0] ?? null;
    }

    /**
     * Kill switch / lifecycle move. Same conditional-update contract — and
     * RETIRED IS TERMINAL (#3698): a retired agent matches zero rows, whatever
     * status is asked for. Retirement revoked its credentials, dropped its
     * grants and froze its card, so a move back into service would hand back a
     * register row whose authority had been taken apart underneath it.
     *
     * The predicate sits on the row being updated, so under READ COMMITTED a
     * concurrent retirement is re-checked against the committed status rather
     * than the one this transaction read; the caller's pre-read gives the
     * precise error, and a zero count after it means the row moved meanwhile.
     * The trigger `registered_agent_retirement_is_terminal` refuses the same move
     * from any writer that bypasses this method.
     */
    static async setStatus(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        status: AgentStatus,
    ): Promise<number> {
        const res = await db.registeredAgent.updateMany({
            where: { id, tenantId: ctx.tenantId, deletedAt: null, status: { not: 'RETIRED' } },
            data: { status },
        });
        return res.count;
    }

    /**
     * Move the accountable owner — the completion of a two-step ownership
     * transfer, and the ONLY write of `ownerUserId` after registration (#3698;
     * the register's PATCH refuses the field).
     *
     * Conditional on everything step one assumed and step two must re-check:
     * the agent still exists, is not RETIRED, and is STILL owned by the person
     * the transfer was proposed away from. The predicate sits on the row being
     * updated, so under READ COMMITTED a concurrent retirement or a concurrent
     * transfer is re-evaluated against the committed row. Zero means one of
     * them happened, and the caller rolls the completion back.
     */
    static async moveOwner(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        fromUserId: string,
        toUserId: string,
    ): Promise<number> {
        const res = await db.registeredAgent.updateMany({
            where: {
                id,
                tenantId: ctx.tenantId,
                deletedAt: null,
                status: { not: 'RETIRED' },
                ownerUserId: fromUserId,
            },
            data: { ownerUserId: toUserId },
        });
        return res.count;
    }
}
