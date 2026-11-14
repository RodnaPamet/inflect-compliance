/**
 * TP-2 (task-lifecycle roadmap) — in-app bell notifications for task
 * WATCHERS.
 *
 * `TaskWatcher` add/remove was fully wired (usecase + repo + route + UI)
 * but nothing ever notified a watcher: watching a task delivered nothing.
 * This module fans the three task-activity emitters (comment-add,
 * status-change, assign) out to every watcher.
 *
 * Channel decision — BELL, not per-event email. A watched task can take
 * many comments / status changes in a day; an email per event to every
 * watcher is the notification fatigue that makes people stop watching
 * (the GitHub / Linear default routes watched-item activity to the
 * in-app feed, not the inbox). Email stays reserved for direct
 * assignment — a stronger, lower-frequency signal. The bell is
 * SSE-pushed so a watcher sees the update immediately.
 *
 * Mirrors `assignment.ts`:
 *   - `db.notification.createMany({ skipDuplicates: true })` so a repeated
 *     dedupeKey collapses with NO exception (raw create throws P2002 and
 *     poisons interactive PG transactions).
 *   - Fire-and-forget — the caller isolates this in its own transaction
 *     AFTER the task write commits, so a notification failure never rolls
 *     back the task.
 */

import type { PrismaClient } from '@prisma/client';
import { publishNotificationEvent } from '@/lib/notifications/notification-bus';
import { insertedNotificationIds } from './inserted-ids';

/**
 * `updated` covers MATERIAL field edits (due-date reschedule, reviewer
 * reassignment) — the changes a watcher needs to know about that aren't a
 * comment, status move, or assignment. Cosmetic edits (title/description
 * wording) deliberately do NOT notify: a bell for every keystroke-level save
 * trains people to ignore the bell.
 */
export type WatcherActivityKind = 'commented' | 'status_changed' | 'assigned' | 'updated';

export interface WatcherActivity {
    tenantId: string;
    tenantSlug: string;
    taskId: string;
    taskKey: string | null;
    taskTitle: string;
    kind: WatcherActivityKind;
    /**
     * Distinguishes genuinely different events while deduping retries of
     * the SAME event — e.g. the comment id, `${from}->${to}` for a status
     * change, or the new assignee id. Without it, two comments in a day
     * would collapse to one bell entry (too coarse for activity).
     */
    discriminator: string;
    /** Short human phrase for the body, e.g. "status OPEN → IN_PROGRESS". */
    detail: string;
}

/**
 * Idempotency key — finer than the assignment key (which is per-day):
 * watcher activity keys on the event discriminator so distinct events
 * don't collapse, but a retry of the same event still dedupes.
 */
export function buildWatcherDedupeKey(a: WatcherActivity, watcherUserId: string): string {
    return `${a.tenantId}:TASK_WATCH:${a.taskId}:${watcherUserId}:${a.kind}:${a.discriminator}`;
}

export async function createWatcherNotifications(
    db: Pick<PrismaClient, 'notification'>,
    watcherUserIds: string[],
    a: WatcherActivity,
    now: Date = new Date(),
): Promise<{ created: number }> {
    if (watcherUserIds.length === 0) return { created: 0 };

    const label = a.taskKey ? `${a.taskKey} "${a.taskTitle}"` : `"${a.taskTitle}"`;
    const title = 'Watched task updated';
    const linkUrl = `/t/${a.tenantSlug}/tasks/${a.taskId}`;

    const rows = watcherUserIds.map((userId) => ({
        tenantId: a.tenantId,
        userId,
        type: 'TASK_WATCH_UPDATE' as const,
        title,
        message: `${label}: ${a.detail}`,
        linkUrl,
        dedupeKey: buildWatcherDedupeKey(a, userId),
    }));

    const result = await db.notification.createMany({ data: rows, skipDuplicates: true });

    // Push to the SSE bus so subscribed bell clients see it without waiting
    // for the next poll. The client keys on `id`, so a re-push of an
    // already-seen row is a no-op in the UI. The id is the ROW's (#5305),
    // read back by the unique dedupe key: the dedupe key itself, which the
    // event used to carry, named no notification to mark read.
    if (result.count > 0) {
        const inserted = await insertedNotificationIds(db, a.tenantId, rows.map((r) => r.dedupeKey));
        for (const row of rows) {
            const written = inserted.get(row.dedupeKey);
            if (!written) continue;
            publishNotificationEvent(a.tenantId, row.userId, {
                id: written.id,
                type: row.type,
                title: row.title,
                message: row.message,
                read: false,
                linkUrl: row.linkUrl,
                createdAt: written.createdAt.toISOString(),
            });
        }
    }

    return { created: result.count };
}
