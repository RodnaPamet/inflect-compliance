import { PrismaTx } from '@/lib/db-context';
import { buildCursorWhere, computePageInfo, CURSOR_ORDER_BY } from '@/lib/pagination';
import { RequestContext } from '../types';

export class AuditLogRepository {
    static async list(db: PrismaTx, ctx: RequestContext) {
        return db.auditLog.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            take: 100,
            include: { user: { select: { name: true, email: true } } },
        });
    }

    /**
     * One page of the tenant's log, newest first, for the Audit log page.
     *
     * Cursor-paged on `(createdAt, id)` with the shared `@/lib/pagination`
     * helpers — the shape the org audit page uses — reading one row past
     * `limit`, so whether an older page exists is a fact held rather than a
     * guess. A cursor that does not decode reads the newest page.
     *
     * Selects only what the page shows: no metadata, hashes or request ids.
     */
    static async listPage(
        db: PrismaTx,
        ctx: RequestContext,
        input: { cursor?: string | null; limit: number },
    ) {
        const cursorWhere = buildCursorWhere(input.cursor);
        const rows = await db.auditLog.findMany({
            where: { tenantId: ctx.tenantId, ...(cursorWhere ?? {}) },
            orderBy: CURSOR_ORDER_BY,
            take: input.limit + 1,
            select: {
                id: true,
                createdAt: true,
                action: true,
                entity: true,
                details: true,
                detailsJson: true,
                user: { select: { name: true } },
            },
        });
        const { trimmedItems, nextCursor } = computePageInfo(rows, input.limit);
        return { rows: trimmedItems, nextCursor: nextCursor ?? null };
    }
}
