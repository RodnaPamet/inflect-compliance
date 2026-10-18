/**
 * Agent ownership transfer — repository (#3698, step 2a).
 *
 * Every query filters by `tenantId` (defence in depth on top of RLS). All calls
 * run inside `runInTenantContext` at the usecase layer, so `db` here is always
 * the tenant-bound client.
 *
 * Every state change is a CONDITIONAL `updateMany` on `status: 'PENDING'`, so a
 * row that moved meanwhile matches nothing and the caller's zero count is its
 * evidence. The database backs each one up: a trigger refuses any update of a
 * row that has left PENDING, a partial unique index admits one PENDING row per
 * agent, and CHECKs make "completed by anyone but the recipient" and "started by
 * the recipient" unrepresentable. There is no delete — `app_user` holds no
 * DELETE on the table, and the row is the record.
 */
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

const transferSelect = {
    id: true,
    agentId: true,
    fromOwnerUserId: true,
    toOwnerUserId: true,
    initiatedByUserId: true,
    status: true,
    expiresAt: true,
    completedAt: true,
    completedByUserId: true,
    cancelledAt: true,
    cancelledByUserId: true,
    createdAt: true,
} as const;

/** How many past transfers the agent's history read returns. */
export const OWNERSHIP_TRANSFER_HISTORY_LIMIT = 20;

export class AgentOwnershipTransferRepository {
    /** One transfer of one agent, or null — absent and foreign read the same. */
    static async findById(db: PrismaTx, ctx: RequestContext, agentId: string, id: string) {
        return db.agentOwnershipTransfer.findFirst({
            where: { id, agentId, tenantId: ctx.tenantId },
            select: transferSelect,
        });
    }

    /** The agent's one PENDING transfer, if any (the partial unique admits one). */
    static async findOpenForAgent(db: PrismaTx, ctx: RequestContext, agentId: string) {
        return db.agentOwnershipTransfer.findFirst({
            where: { tenantId: ctx.tenantId, agentId, status: 'PENDING' },
            select: transferSelect,
        });
    }

    /** The agent's transfers, newest first, bounded. */
    static async listForAgent(db: PrismaTx, ctx: RequestContext, agentId: string) {
        return db.agentOwnershipTransfer.findMany({
            where: { tenantId: ctx.tenantId, agentId },
            select: transferSelect,
            orderBy: [{ createdAt: 'desc' }],
            take: OWNERSHIP_TRANSFER_HISTORY_LIMIT,
        });
    }

    /**
     * Mark the agent's lapsed PENDING transfer EXPIRED. Lazy expiry: no job does
     * this, so whichever request next needs the slot (a new proposal) or finds
     * the row lapsed (a refused completion) stamps it. Writes no audit row — no
     * person acted; the row's own `status` and `expiresAt` are the record.
     */
    static async expireLapsedForAgent(
        db: PrismaTx,
        ctx: RequestContext,
        agentId: string,
        now: Date,
    ): Promise<number> {
        const res = await db.agentOwnershipTransfer.updateMany({
            where: { tenantId: ctx.tenantId, agentId, status: 'PENDING', expiresAt: { lte: now } },
            data: { status: 'EXPIRED' },
        });
        return res.count;
    }

    static async create(
        db: PrismaTx,
        ctx: RequestContext,
        data: {
            agentId: string;
            fromOwnerUserId: string;
            toOwnerUserId: string;
            expiresAt: Date;
        },
    ) {
        return db.agentOwnershipTransfer.create({
            data: { tenantId: ctx.tenantId, initiatedByUserId: ctx.userId, status: 'PENDING', ...data },
            select: transferSelect,
        });
    }

    /**
     * Step two's claim. Every condition of a valid completion is in the WHERE —
     * still PENDING, still unexpired, and naming THIS person — so the claim
     * itself is the check, and a concurrent cancel, expiry or second claim makes
     * it match nothing.
     */
    static async claimCompletion(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        now: Date,
    ): Promise<number> {
        const res = await db.agentOwnershipTransfer.updateMany({
            where: {
                id,
                tenantId: ctx.tenantId,
                status: 'PENDING',
                toOwnerUserId: ctx.userId,
                expiresAt: { gt: now },
            },
            data: { status: 'COMPLETED', completedAt: now, completedByUserId: ctx.userId },
        });
        return res.count;
    }

    /** Cancel one PENDING transfer. Zero means it was not PENDING (or not here). */
    static async cancel(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        now: Date,
    ): Promise<number> {
        const res = await db.agentOwnershipTransfer.updateMany({
            where: { id, tenantId: ctx.tenantId, status: 'PENDING' },
            data: { status: 'CANCELLED', cancelledAt: now, cancelledByUserId: ctx.userId },
        });
        return res.count;
    }

    /**
     * Close the transfer that is open for an agent, for the retirement cascade:
     * a retired agent can never be completed into, so the act that made it
     * impossible closes it. Returns the row it CANCELLED, for the cascade's
     * audit row, or null.
     *
     * The agent's one PENDING row (the partial unique admits one) is closed
     * either way, so a retired agent holds no PENDING transfer at all:
     *
     *   live    → CANCELLED, attributed to the retiring actor;
     *   lapsed  → EXPIRED, exactly the stamp every request that finds it writes,
     *             with no actor — it ended on its own before anybody retired
     *             anything, and recording it as a cancellation would attribute
     *             an act to a person who did not perform one. Returns null.
     *
     * Retirement calls this holding the agent row's lock, and every other path
     * that locks a transfer row and the agent row takes the agent row first, so
     * writing the lapsed row here cannot close a cycle. (It once skipped lapsed
     * rows for exactly that reason, while step one locked them in the other
     * order; step one now reads the agent `FOR SHARE` first.) A row a concurrent
     * cancel closed meanwhile matches neither write, and is not reported.
     */
    static async closeOpenForAgent(
        db: PrismaTx,
        ctx: RequestContext,
        agentId: string,
        now: Date,
    ): Promise<{ id: string; toOwnerUserId: string } | null> {
        const pending = { tenantId: ctx.tenantId, agentId, status: 'PENDING' };
        const open = await db.agentOwnershipTransfer.findFirst({
            where: pending,
            select: { id: true, toOwnerUserId: true, expiresAt: true },
        });
        if (!open) return null;
        if (open.expiresAt.getTime() <= now.getTime()) {
            await db.agentOwnershipTransfer.updateMany({
                where: { ...pending, id: open.id },
                data: { status: 'EXPIRED' },
            });
            return null;
        }
        const res = await db.agentOwnershipTransfer.updateMany({
            where: { ...pending, id: open.id },
            data: { status: 'CANCELLED', cancelledAt: now, cancelledByUserId: ctx.userId },
        });
        return res.count > 0 ? { id: open.id, toOwnerUserId: open.toOwnerUserId } : null;
    }
}
