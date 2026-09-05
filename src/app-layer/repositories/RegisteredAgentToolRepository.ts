/**
 * Agent tool exposure — repository.
 *
 * Every query filters by `tenantId` (defence in depth on top of RLS). All calls
 * run inside `runInTenantContext` at the usecase layer, so `db` here is always
 * the tenant-bound client.
 *
 * There is no soft-delete rail: revoking a tool DELETES the row. A grant is
 * authority, not history — an authority record kept "for the trail" with a
 * `revokedAt` on it is one `WHERE` clause away from granting again, and the
 * trail already exists as the hash-chained audit entries the usecase writes.
 */
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

export class RegisteredAgentToolRepository {
    /** Every tool granted to one agent, oldest first. */
    static async listForAgent(db: PrismaTx, ctx: RequestContext, agentId: string) {
        return db.registeredAgentTool.findMany({
            where: { tenantId: ctx.tenantId, agentId },
            select: {
                id: true,
                toolName: true,
                grantedByUserId: true,
                createdAt: true,
            },
            orderBy: [{ createdAt: 'asc' }],
            // The catalogue is a handful of tools; more rows than this means a
            // bug worth noticing rather than a page worth loading.
            take: 200,
        });
    }

    /**
     * Grant a tool. Idempotent by the `(tenantId, agentId, toolName)` unique —
     * a repeat grant updates the grantor rather than throwing, because "grant
     * this tool" is a statement about the desired state and a caller retrying
     * after a network timeout should not get a 409.
     */
    static async grant(
        db: PrismaTx,
        ctx: RequestContext,
        agentId: string,
        toolName: string,
    ) {
        return db.registeredAgentTool.upsert({
            where: {
                tenantId_agentId_toolName: { tenantId: ctx.tenantId, agentId, toolName },
            },
            create: {
                tenantId: ctx.tenantId,
                agentId,
                toolName,
                grantedByUserId: ctx.userId,
            },
            update: { grantedByUserId: ctx.userId },
            select: { id: true, toolName: true, createdAt: true },
        });
    }

    /**
     * Revoke a tool. Conditional delete — the `tenantId` predicate is part of
     * the WHERE, so a caller naming another tenant's agent deletes ZERO rows
     * rather than throwing, and the count is the caller's evidence.
     */
    static async revoke(
        db: PrismaTx,
        ctx: RequestContext,
        agentId: string,
        toolName: string,
    ): Promise<number> {
        const res = await db.registeredAgentTool.deleteMany({
            where: { tenantId: ctx.tenantId, agentId, toolName },
        });
        return res.count;
    }
}
