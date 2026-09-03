/**
 * Tenant notification settings service.
 *
 * - Get/update tenant-level notification settings (enabled, from, compliance mailbox)
 * - Outbox stats for admin dashboard
 */

import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '../types';
import { deploymentSenderAddress } from '@/lib/email/sender-identity';

export interface TenantNotificationSettingsData {
    enabled: boolean;
    defaultFromName: string;
    defaultFromEmail: string;
    complianceMailbox: string | null;
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
    };
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

    const row = await db.tenantNotificationSettings.upsert({
        where: { tenantId: ctx.tenantId },
        create: {
            tenantId: ctx.tenantId,
            ...defaults(),
            ...data,
        },
        update: data,
    });
    return {
        enabled: row.enabled,
        defaultFromName: row.defaultFromName,
        defaultFromEmail: row.defaultFromEmail,
        complianceMailbox: row.complianceMailbox,
    };
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
