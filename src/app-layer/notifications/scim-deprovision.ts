/**
 * Tell a workspace's Owners when its identity provider switches off an AI
 * admin (owner decision, 2026-10-25).
 *
 * A SCIM deprovision deactivates an AI_ADMIN membership as it does an
 * EDITOR's (`isScimStatusProtectedRole`, owner decision of 2026-10-18): a
 * Groups push can grant the role, so the directory must be able to take it
 * away, or a leaver keeps the agent keys until somebody notices. That rule
 * stands. What it lacked was the noticing — on the members page only an
 * Owner deactivates an AI admin (#4118), so the directory doing it is the one
 * path an Owner would not otherwise learn of from their own act.
 *
 * One bell notification per ACTIVE Owner, bounded as the agentic fallback is.
 * The type is `GENERAL`: a new `NotificationType` value would need two
 * deploys, because a container whose Prisma client predates it fails every
 * read of a row carrying it — the bell list among them. The dedupe key carries
 * the deactivation's own timestamp, so a SCIM retry of the same deprovision
 * tells nobody twice and a later deprovision of the same person tells them
 * again.
 */
import type { PrismaClient } from '@prisma/client';
import { publishNotificationEvent } from '@/lib/notifications/notification-bus';
import { tenantPageLink } from './tenant-link';

/** Same bound as `resolveAgenticRecipients`: a broadcast must not become a mail bomb. */
const MAX_OWNER_RECIPIENTS = 50;

export const SCIM_AI_ADMIN_DEPROVISIONED_TITLE = 'An AI admin was deactivated by your directory';

export interface ScimAiAdminDeprovision {
    tenantId: string;
    /** The deactivated person. */
    userId: string;
    membershipId: string;
    /** The `deactivatedAt` the SCIM write stamped. */
    deactivatedAt: Date;
}

export async function notifyOwnersOfScimAiAdminDeprovision(
    db: Pick<PrismaClient, 'tenantMembership' | 'user' | 'tenant' | 'notification'>,
    input: ScimAiAdminDeprovision,
): Promise<{ created: number }> {
    const owners = await db.tenantMembership.findMany({
        where: { tenantId: input.tenantId, role: 'OWNER', status: 'ACTIVE' },
        select: { userId: true },
        orderBy: { createdAt: 'asc' },
        take: MAX_OWNER_RECIPIENTS,
    });
    if (owners.length === 0) return { created: 0 };

    const person = await db.user.findUnique({
        where: { id: input.userId },
        select: { name: true, email: true },
    });
    const who = person?.name || person?.email || 'A member';
    const message =
        `${who} was deactivated in this workspace by your identity provider (SCIM). ` +
        'They held the AI admin role. Review the agents they own on the agent register.';
    // A SCIM context carries no slug, so it is looked up, as
    // `resolveTenantSlugForLinks` does for a context without one.
    const tenant = await db.tenant.findUnique({ where: { id: input.tenantId }, select: { slug: true } });
    const linkUrl = tenantPageLink(tenant?.slug, '/admin/members');
    const stamp = input.deactivatedAt.toISOString();

    const res = await db.notification.createMany({
        data: owners.map((o) => ({
            tenantId: input.tenantId,
            userId: o.userId,
            type: 'GENERAL' as const,
            title: SCIM_AI_ADMIN_DEPROVISIONED_TITLE,
            message,
            linkUrl,
            dedupeKey: `SCIM_AI_ADMIN_DEPROVISIONED:${input.membershipId}:${stamp}:${o.userId}`,
        })),
        skipDuplicates: true,
    });

    // Published only on a real write, as `createAgenticNotification` does: an
    // SSE event for a row the dedupe key rejected would show a notification
    // that is not in the list the bell opens.
    if (res.count > 0) {
        for (const o of owners) {
            publishNotificationEvent(input.tenantId, o.userId, {
                id: `SCIM_AI_ADMIN_DEPROVISIONED:${input.membershipId}:${o.userId}`,
                type: 'GENERAL',
                title: SCIM_AI_ADMIN_DEPROVISIONED_TITLE,
                message,
                read: false,
                linkUrl,
                createdAt: stamp,
            });
        }
    }
    return { created: res.count };
}
