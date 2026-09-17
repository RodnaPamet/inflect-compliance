/**
 * Tenant notification settings service.
 *
 * - Get/update tenant-level notification settings (enabled, from, compliance mailbox)
 * - Outbox stats for admin dashboard
 */

import type { NotificationType } from '@prisma/client';

import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '../types';
import { deploymentSenderAddress } from '@/lib/email/sender-identity';

export interface TenantNotificationSettingsData {
    enabled: boolean;
    defaultFromName: string;
    defaultFromEmail: string;
    complianceMailbox: string | null;
    /**
     * IN-APP (bell + SSE) types this workspace has switched OFF (#2564).
     *
     * `enabled` above is EMAIL-scoped — every caller of
     * `isNotificationsEnabled` is an outbox or digest path — so it says
     * nothing about the bell. This is the in-app dimension, and it is a MUTE
     * list so that an absent member means "notify": adding a
     * `NotificationType` must never silently suppress it for tenants who saved
     * their preferences before the member existed.
     */
    mutedInAppTypes: NotificationType[];
}

/**
 * The sender a tenant that has never opened the notifications page sends AS.
 *
 * `processOutbox` overrides each message's `from` from HERE, so for outbox mail
 * this value — not the mailer's transport default — is what reaches the relay.
 * It was its own hardcoded copy of `noreply@inflect.app`, which is why a
 * deployment with `SMTP_FROM` set correctly still had every message rejected
 * `550 ... domain is not verified`. See `@/lib/email/sender-identity` for the
 * full account; the point of importing it is that there is now one thing to set.
 */
function defaults(): TenantNotificationSettingsData {
    return {
        enabled: true,
        defaultFromName: 'Inflect Compliance',
        defaultFromEmail: deploymentSenderAddress(),
        complianceMailbox: null,
        // Nothing muted. A tenant that has never opened the page is notified
        // about everything, which is the behaviour every row had before the
        // column existed.
        mutedInAppTypes: [],
    };
}

/**
 * Drop keys whose value is `undefined` before they reach Prisma.
 *
 * `create: { ...defaults(), ...data }` spreads `data` LAST, so a key that is
 * PRESENT with an undefined value overwrites the resolved default — and Prisma
 * treats an undefined argument as "not supplied", so the column is omitted from
 * the INSERT and the database default decides it instead. That is how a caller
 * who merely omitted `defaultFromEmail` still got `noreply@inflect.app`
 * written, months after #2286 removed that literal from this file.
 *
 * The route now validates its body, which is the real fix; this keeps the
 * usecase correct for every OTHER caller, present and future. Object spread
 * and Prisma disagree about what an undefined value means, and the seam where
 * they meet is here.
 */
function definedOnly<T extends object>(data: T): T {
    return Object.fromEntries(
        Object.entries(data).filter(([, value]) => value !== undefined),
    ) as T;
}

/**
 * Get tenant notification settings.
 * Returns defaults if no row exists yet.
 */
export async function getTenantNotificationSettings(
    db: PrismaTx,
    tenantId: string,
): Promise<TenantNotificationSettingsData> {

    const row = await db.tenantNotificationSettings.findUnique({
        where: { tenantId },
    });
    if (!row) return defaults();
    return {
        enabled: row.enabled,
        defaultFromName: row.defaultFromName,
        defaultFromEmail: row.defaultFromEmail,
        complianceMailbox: row.complianceMailbox,
        // The column is nullable so that a rolling deploy's old containers can
        // INSERT without it. Prisma surfaces a NULL scalar list as `[]`, but
        // the coalesce is written out rather than relied on: "no row yet",
        // "row written by an old container" and "nothing muted" are three
        // different histories that must all read as the same empty list.
        mutedInAppTypes: row.mutedInAppTypes ?? [],
    };
}

/**
 * Upsert tenant notification settings (admin-only).
 */
export async function updateTenantNotificationSettings(
    db: PrismaTx,
    ctx: RequestContext,
    data: Partial<TenantNotificationSettingsData>,
): Promise<TenantNotificationSettingsData> {

    const supplied = definedOnly(data);
    const row = await db.tenantNotificationSettings.upsert({
        where: { tenantId: ctx.tenantId },
        create: {
            tenantId: ctx.tenantId,
            ...defaults(),
            ...supplied,
        },
        update: supplied,
    });
    return {
        enabled: row.enabled,
        defaultFromName: row.defaultFromName,
        defaultFromEmail: row.defaultFromEmail,
        complianceMailbox: row.complianceMailbox,
        mutedInAppTypes: row.mutedInAppTypes ?? [],
    };
}

/**
 * Is this in-app notification type switched on for this tenant?
 *
 * The bell-side twin of `isNotificationsEnabled` above, and deliberately a
 * SEPARATE question rather than an extra clause inside it. `enabled` is read
 * only by email paths (`enqueue`, `digest-dispatcher`,
 * `retention-notifications`, `policyReviewReminder`, `action-executor`), and
 * folding the bell into it would make one switch mean two things — a tenant
 * that wanted to stop one noisy bell would also stop every email.
 *
 * Fails OPEN, on both arms: no settings row, or a row whose list is NULL
 * because an old container inserted it, both mean "notify". A notification
 * subsystem that goes silent because a row is missing is the failure mode
 * nobody notices, and the two types this currently governs are a stop control
 * and a refused agent write.
 */
export async function isInAppTypeEnabled(
    // Narrower than `isNotificationsEnabled`'s `PrismaTx` on purpose: the bell
    // emitters that call this declare their own `Pick<PrismaClient, …>` db so
    // a test can hand them a fake, and a full `PrismaTx` here would force
    // every one of them to widen to the whole client. A real `PrismaTx`
    // satisfies this, so existing call shapes are unaffected.
    db: Pick<PrismaTx, 'tenantNotificationSettings'>,
    tenantId: string,
    type: NotificationType,
): Promise<boolean> {

    const row = await db.tenantNotificationSettings.findUnique({
        where: { tenantId },
        select: { mutedInAppTypes: true },
    });
    return !(row?.mutedInAppTypes ?? []).includes(type);
}

/**
 * Check if notifications are enabled for a tenant.
 * Fast path — avoids fetching full settings when only the toggle is needed.
 */
export async function isNotificationsEnabled(
    db: PrismaTx,
    tenantId: string,
): Promise<boolean> {

    const row = await db.tenantNotificationSettings.findUnique({
        where: { tenantId },
        select: { enabled: true },
    });
    // Default: enabled (when no settings row exists yet)
    return row?.enabled ?? true;
}

export interface OutboxStats {
    last24h: { pending: number; sent: number; failed: number };
    last7d: { pending: number; sent: number; failed: number };
    last30d: { pending: number; sent: number; failed: number };
}

/**
 * Get outbox send statistics for admin dashboard.
 */
export async function getOutboxStats(
    db: PrismaTx,
    tenantId: string,
): Promise<OutboxStats> {
    const now = new Date();
    const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    async function countByWindow(since: Date) {

        const rows = await db.notificationOutbox.groupBy({
            by: ['status'],
            where: { tenantId, createdAt: { gte: since } },
            _count: true,
        });
        const counts = { pending: 0, sent: 0, failed: 0 };
        for (const r of rows) {
            if (r.status === 'PENDING') counts.pending = r._count;
            if (r.status === 'SENT') counts.sent = r._count;
            if (r.status === 'FAILED') counts.failed = r._count;
        }
        return counts;
    }

    const [last24h, last7d, last30d] = await Promise.all([
        countByWindow(h24),
        countByWindow(d7),
        countByWindow(d30),
    ]);

    return { last24h, last7d, last30d };
}
