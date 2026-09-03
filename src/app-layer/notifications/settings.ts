/**
 * Tenant notification settings service.
 *
 * - Get/update tenant-level notification settings (enabled, from, compliance mailbox)
 * - Outbox stats for admin dashboard
 */

import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '../types';

export interface TenantNotificationSettingsData {
    enabled: boolean;
    defaultFromName: string;
    defaultFromEmail: string;
    complianceMailbox: string | null;
}

/**
 * The sender a tenant that has never opened the notifications page sends AS.
 *
 * THIS IS A DEPLOYMENT FACT, NOT A PRODUCT CONSTANT. It was the literal
 * `noreply@inflect.app`, and that address is deliverable only from a deployment
 * whose relay has verified the `inflect.app` domain. On any other deployment —
 * including this product's own production VM — the relay rejects it:
 *
 *     550 The inflect.app domain is not verified.
 *
 * That failure is per-message and silent. `processOutbox` marks the row FAILED
 * and moves on, nothing reads `lastError`, and no alert fires on the rate — so
 * production sent its last successful email on 2026-06-03 and accumulated 520
 * failures across digests, policy-approval requests and identity-leaver alerts
 * before anyone looked. Every tenant was affected, because the fallback applies
 * to any tenant with no `TenantNotificationSettings` row and none of the seven
 * had one.
 *
 * `SMTP_FROM` was configured correctly (`noreply@inflect.bg`, the verified
 * domain) the whole time. It simply was not on this path: the mailer reads it
 * for its transport default, and then `processOutbox` overrides `from` per
 * tenant from HERE. Two sender defaults, one of them right, and the wrong one won.
 *
 * Read from `process.env` rather than `@/env` for the reason given at
 * `src/lib/mailer.ts` — a bundled chunk can carry an `@/env` copy whose
 * server-only vars are not surfaced, which is the same silent-drop this fixes.
 *
 * Resolved per call, not at module load: the worker reads it after
 * `initMailerFromEnv`, and pinning it at import time would reintroduce an
 * order dependency between two modules that otherwise have none.
 */
function fallbackFromEmail(): string {
    return process.env.SMTP_FROM || 'noreply@inflect.app';
}

function defaults(): TenantNotificationSettingsData {
    return {
        enabled: true,
        defaultFromName: 'Inflect Compliance',
        defaultFromEmail: fallbackFromEmail(),
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
