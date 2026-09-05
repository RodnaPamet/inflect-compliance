/**
 * Agent policy card — repository.
 *
 * Every query filters by `tenantId` (defence in depth on top of RLS). All calls
 * run inside `runInTenantContext` at the usecase layer, so `db` here is always
 * the tenant-bound client.
 *
 * ## There is no update method, and that is the shape of the table
 *
 * A version row is written once and never changed: `app_user` holds no UPDATE
 * privilege on `AgentPolicyCardVersion` and a trigger refuses one from any role.
 * So an "edit" here is `appendVersion` — a new row plus a pointer move on the
 * head — and the absence of an update method is not an oversight to be filled in
 * later, it is the reason the next prompt can pin a version and have the pin
 * mean something.
 */
import type { AgentDataAccessScope, AgentRiskTier } from '@prisma/client';

import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

/** The columns that make up one version's policy, selected everywhere alike. */
const VERSION_SELECT = {
    id: true,
    version: true,
    permittedTools: true,
    maxDataScope: true,
    maxAutonomyLevel: true,
    maxActionsPerRun: true,
    maxActionsPerDay: true,
    escalationTriggers: true,
    approvalRung: true,
    seeded: true,
    seededFromTier: true,
    createdByUserId: true,
    createdAt: true,
} as const;

export class AgentPolicyCardRepository {
    /** The card head for one agent, or null. */
    static async findForAgent(db: PrismaTx, ctx: RequestContext, agentId: string) {
        return db.agentPolicyCard.findUnique({
            where: { tenantId_agentId: { tenantId: ctx.tenantId, agentId } },
            select: {
                id: true,
                agentId: true,
                currentVersion: true,
                usageWindowDate: true,
                actionsInWindow: true,
                createdAt: true,
                updatedAt: true,
            },
        });
    }

    /** The version in force — by NUMBER, never "the newest". */
    static async findVersion(
        db: PrismaTx,
        ctx: RequestContext,
        cardId: string,
        version: number,
    ) {
        return db.agentPolicyCardVersion.findUnique({
            where: {
                tenantId_cardId_version: { tenantId: ctx.tenantId, cardId, version },
            },
            select: VERSION_SELECT,
        });
    }

    /** Every version of one card, newest first — the reconstruction trail. */
    static async listVersions(db: PrismaTx, ctx: RequestContext, cardId: string) {
        return db.agentPolicyCardVersion.findMany({
            where: { tenantId: ctx.tenantId, cardId },
            select: VERSION_SELECT,
            orderBy: [{ version: 'desc' }],
            // A card edited more than this many times is a card somebody is
            // driving from a script, which is worth noticing rather than
            // paginating.
            take: 200,
        });
    }

    /**
     * Create the card and its version 1 together.
     *
     * One nested write, so a card can never exist without the version its
     * pointer names — the state `loadPolicyCardInForce` has to treat as
     * deny-everything, and which should therefore be unreachable rather than
     * merely unlikely.
     */
    static async createWithFirstVersion(
        db: PrismaTx,
        ctx: RequestContext,
        agentId: string,
        version: VersionInput,
    ) {
        return db.agentPolicyCard.create({
            data: {
                tenantId: ctx.tenantId,
                agentId,
                currentVersion: 1,
                createdByUserId: ctx.userId,
                versions: {
                    // No `tenantId` here, deliberately: it is one of the two
                    // scalars of the composite `card` relation, so Prisma sets
                    // it from the parent and REFUSES it as an explicit argument.
                    // That is the composite parent key doing its job — a version
                    // cannot be inserted under another tenant's card, because
                    // there is no way to say so.
                    create: {
                        version: 1,
                        seeded: true,
                        createdByUserId: ctx.userId,
                        ...version,
                    },
                },
            },
            select: { id: true, currentVersion: true },
        });
    }

    /**
     * Append a version and move the head to it, in one statement each.
     *
     * Both statements run inside the usecase's `runInTenantContext`
     * transaction, so a failure between them rolls the pointer back rather than
     * leaving the head naming a version that was never written.
     *
     * The pointer move is a CONDITIONAL update on the version the caller read —
     * `currentVersion: expectedFrom` is part of the WHERE — so two operators
     * editing the same card concurrently cannot both write version N+1 against
     * the same base. The loser matches zero rows and the count is the caller's
     * evidence, the same shape `revoke` uses in the tool-exposure repository.
     */
    static async appendVersion(
        db: PrismaTx,
        ctx: RequestContext,
        cardId: string,
        expectedFrom: number,
        version: VersionInput,
    ): Promise<number> {
        const moved = await db.agentPolicyCard.updateMany({
            where: { id: cardId, tenantId: ctx.tenantId, currentVersion: expectedFrom },
            data: { currentVersion: expectedFrom + 1 },
        });
        if (moved.count === 0) return 0;

        await db.agentPolicyCardVersion.create({
            data: {
                tenantId: ctx.tenantId,
                cardId,
                version: expectedFrom + 1,
                seeded: false,
                createdByUserId: ctx.userId,
                ...version,
            },
        });
        return expectedFrom + 1;
    }
}

/** The policy columns of one version — everything except its identity. */
export interface VersionInput {
    permittedTools: string[];
    maxDataScope: AgentDataAccessScope;
    maxAutonomyLevel: number;
    maxActionsPerRun: number;
    maxActionsPerDay: number;
    escalationTriggers: string[];
    approvalRung: string;
    seededFromTier?: AgentRiskTier | null;
}
