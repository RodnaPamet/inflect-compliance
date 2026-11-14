/**
 * The real `Notification.id` of rows just written by `createMany` (#5305).
 *
 * The bell helpers insert through `createMany({ skipDuplicates: true })`,
 * which returns a count and no ids, and they used to push each SSE event with
 * a synthetic id (the dedupe key, or a `kind:entity:user` string). The bell
 * marks a row read by `PATCH …/notifications/<id>`, so a pushed row's PATCH
 * named no notification: the mark failed, the row came back unread on the
 * next list refetch, and "Mark all read" missed it too.
 *
 * `dedupeKey` is unique across the table, so one bounded read by key gives
 * each pushed row the id the list and the PATCH use.
 *
 * Best-effort, like the push itself: the row is already written, and the next
 * list fetch shows it. A failed read returns an empty map, and the caller
 * pushes nothing rather than an event whose id no request can act on.
 */
import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/observability/logger';

export async function insertedNotificationIds(
    db: Pick<PrismaClient, 'notification'>,
    tenantId: string,
    dedupeKeys: readonly string[],
): Promise<Map<string, { id: string; createdAt: Date }>> {
    const out = new Map<string, { id: string; createdAt: Date }>();
    if (dedupeKeys.length === 0) return out;
    try {
        const rows = await db.notification.findMany({
            where: { tenantId, dedupeKey: { in: [...dedupeKeys] } },
            select: { id: true, dedupeKey: true, createdAt: true },
            take: dedupeKeys.length,
        });
        for (const r of rows) {
            if (r.dedupeKey) out.set(r.dedupeKey, { id: r.id, createdAt: r.createdAt });
        }
    } catch (err) {
        logger.warn('notification push skipped: could not read the inserted ids', {
            component: 'notifications',
            tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    return out;
}
