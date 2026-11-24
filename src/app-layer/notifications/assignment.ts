/**
 * 2026-05-27 — Notification streaming/alerts roadmap PR-A.
 *
 * In-app notifications for task + control assignment. Today the
 * task-assignment path enqueues only an EMAIL via the
 * NotificationOutbox; nothing reaches the bell. The control-owner
 * path doesn't emit any notification at all. This module unifies
 * both: a single `createAssignmentNotification` function that the
 * caller drives with a typed payload.
 *
 * Mirrors the shape of `createTaskDueNotification` (task-due.ts):
 *   - `db.notification.createMany({ skipDuplicates: true })` so
 *     a duplicate dedupeKey returns count=0 with NO exception
 *     (raw `create` throws P2002 which poisons interactive PG
 *     transactions).
 *   - dedupeKey shape `{tenantId}:{TYPE}:{entityId}:{userId}:{date}`
 *     so the same user being assigned the same entity twice in
 *     one day collapses to a single bell notification — matching
 *     the existing TASK_ASSIGNED email idempotency.
 *
 * Fire-and-forget — callers must isolate the write in its own
 * transaction (see `assignTask` and `setControlOwner` paths) so a
 * notification failure never rolls back the parent operation.
 */

import type { PrismaClient } from '@prisma/client';
import { publishNotificationEvent } from '@/lib/notifications/notification-bus';
import { insertedNotificationIds } from './inserted-ids';
import { STOCK_NOTIFICATIONS, recordLabel, stockNotificationText } from '@/lib/notifications/stock-notifications';

export interface AssignmentTarget {
    /** Tenant the entity belongs to. */
    tenantId: string;
    /** Recipient — the new assignee/owner (or, for a review request, the reviewer). */
    assigneeUserId: string;
    /** Entity being assigned. */
    entityId: string;
    /** Display label for the notification body. */
    entityLabel: string;
    /** Optional key for the body (e.g. `T-123` for tasks, control code). */
    entityKey?: string | null;
    /** Tenant slug for the deep link. */
    tenantSlug: string;
}

export type AssignmentNotificationKind =
    | 'TASK_ASSIGNED'
    | 'CONTROL_ASSIGNED'
    | 'RISK_ASSIGNED'
    | 'ASSET_ASSIGNED'
    // B2-4 — the four-eyes counterpart of TASK_ASSIGNED. Same "this is
    // now your responsibility" shape and the same per-(entity, user,
    // day) dedupe, so it belongs on this emitter rather than a parallel
    // one; only the recipient's ROLE differs (reviewer, not assignee).
    | 'TASK_REVIEW_REQUESTED';

/**
 * The deep link per kind. The title and body are the stock sentences in
 * `@/lib/notifications/stock-notifications`, which the bell and the
 * notifications page read back in the reader's language (#5929); the kind's
 * name is its stock kind.
 */
const LINK_SEGMENT: Record<AssignmentNotificationKind, string> = {
    TASK_ASSIGNED: 'tasks',
    CONTROL_ASSIGNED: 'controls',
    RISK_ASSIGNED: 'risks',
    ASSET_ASSIGNED: 'assets',
    TASK_REVIEW_REQUESTED: 'tasks',
};

/**
 * Build the idempotency key. Pure helper so tests can assert the
 * format directly.
 */
export function buildAssignmentDedupeKey(
    tenantId: string,
    kind: AssignmentNotificationKind,
    entityId: string,
    userId: string,
    now: Date = new Date(),
): string {
    // Day granularity in UTC — re-assigning the same user to the
    // same entity within one day shouldn't double-notify the bell.
    const ymd = now.toISOString().slice(0, 10);
    return `${tenantId}:${kind}:${entityId}:${userId}:${ymd}`;
}

export interface AssignmentNotificationOutcome {
    status: 'created' | 'duplicate';
}

export async function createAssignmentNotification(
    db: Pick<PrismaClient, 'notification'>,
    kind: AssignmentNotificationKind,
    target: AssignmentTarget,
    now: Date = new Date(),
): Promise<AssignmentNotificationOutcome> {
    const label = recordLabel(target.entityLabel, target.entityKey);

    const row = {
        tenantId: target.tenantId,
        userId: target.assigneeUserId,
        type: kind,
        title: STOCK_NOTIFICATIONS[kind].title,
        message: stockNotificationText(kind, { label }),
        linkUrl: `/t/${target.tenantSlug}/${LINK_SEGMENT[kind]}/${target.entityId}`,
        dedupeKey: buildAssignmentDedupeKey(
            target.tenantId,
            kind,
            target.entityId,
            target.assigneeUserId,
            now,
        ),
    };

    const result = await db.notification.createMany({
        data: [row],
        skipDuplicates: true,
    });

    // 2026-05-28 — fan the fresh insert out to the SSE bus (set up
    // by PR-C #761) so subscribed bell clients see the assignment
    // alert the moment it lands, not on the next 60s poll. Skip
    // when result.count === 0 — that means the dedupeKey collapsed
    // a duplicate, and we already pushed the original. The event
    // carries the ROW's id (#5305), which marking it read needs.
    if (result.count > 0) {
        const written = (await insertedNotificationIds(db, target.tenantId, [row.dedupeKey])).get(row.dedupeKey);
        if (written) publishNotificationEvent(target.tenantId, target.assigneeUserId, {
            id: written.id,
            type: row.type,
            title: row.title,
            message: row.message,
            read: false,
            linkUrl: row.linkUrl,
            createdAt: written.createdAt.toISOString(),
        });
    }

    return { status: result.count > 0 ? 'created' : 'duplicate' };
}
