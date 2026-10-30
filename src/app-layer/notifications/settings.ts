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
 * The settings fields the audit row records WITH their values, before and after.
 *
 * Every field this row carries today is configuration and none is a secret:
 * the switch, the sender, the BCC address and the mute list. The values are the
 * point — "since when has every outbox email been copied to this address" is
 * the question the row has to answer. A credential added to this row later
 * (an SMTP password, a signing secret) must NOT join this list: record such a
 * field by NAME only, as `SECURITY_SETTINGS_UPDATED` does for its secrets.
 */
const VALUE_AUDITED_FIELDS = [
    'enabled',
    'defaultFromName',
    'defaultFromEmail',
    'complianceMailbox',
    'mutedInAppTypes',
] as const satisfies readonly (keyof TenantNotificationSettingsData)[];

function sameValue(a: unknown, b: unknown): boolean {
    // The mute list is a SET: re-ordering it changes nothing a reader sees.
    if (Array.isArray(a) && Array.isArray(b)) {
        return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    }
    return a === b;
}

/**
 * Upsert tenant notification settings (admin-only).
 *
 * Audited (#4469): a change writes one NOTIFICATION_SETTINGS_UPDATED row with
 * the changed fields and their before/after values. Switching email off, or
 * pointing the compliance BCC at a new address, left no trace before. A save
 * that changes nothing writes no row.
 */
export async function updateTenantNotificationSettings(
    db: PrismaTx,
    ctx: RequestContext,
    data: Partial<TenantNotificationSettingsData>,
): Promise<TenantNotificationSettingsData> {

    const supplied = definedOnly(data);
    // Read in the caller's transaction, before the write, so the row can say
    // what each value changed FROM. No settings row reads as the defaults,
    // which is what the workspace was sending under.
    const before = await getTenantNotificationSettings(db, ctx.tenantId);
    const row = await db.tenantNotificationSettings.upsert({
        where: { tenantId: ctx.tenantId },
        create: {
            tenantId: ctx.tenantId,
            ...defaults(),
            ...supplied,
        },
        update: supplied,
    });
    const after: TenantNotificationSettingsData = {
        enabled: row.enabled,
        defaultFromName: row.defaultFromName,
        defaultFromEmail: row.defaultFromEmail,
        complianceMailbox: row.complianceMailbox,
        mutedInAppTypes: row.mutedInAppTypes ?? [],
    };

    const changed = VALUE_AUDITED_FIELDS.filter((f) => !sameValue(before[f], after[f]));
    if (changed.length > 0) {
        // Imported HERE, not at the top. This module is reached by the bell
        // emitters (`agentic.ts` → `isInAppTypeEnabled`), the outbox and the
        // settings route, and at module scope it imports nothing at runtime —
        // see `@/lib/email/sender-identity`. A static import of the audit
        // writer would pull the Prisma client, the encryption extension and
        // the BullMQ queue into every one of those graphs for the sake of the
        // one function that writes.
        const { logEvent } = await import('../events/audit');
        await logEvent(db, ctx, {
            action: 'NOTIFICATION_SETTINGS_UPDATED',
            entityType: 'TenantNotificationSettings',
            entityId: ctx.tenantId,
            details: `Updated notification settings: ${changed.join(', ')}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantNotificationSettings',
                operation: 'updated',
                changedFields: [...changed],
                before: Object.fromEntries(changed.map((f) => [f, before[f]])),
                after: Object.fromEntries(changed.map((f) => [f, after[f]])),
            },
        });
    }

    return after;
}

/**
 * Is this in-app notification type switched on for this tenant?
 *
 * The bell-side twin of `isNotificationsEnabled` above, and deliberately a
 * SEPARATE question rather than an extra clause inside it. `enabled` is read
 * only by email paths (`enqueue`, `digest-dispatcher`,
 * `retention-notifications`, `policyReviewReminder`, `action-executor`,
 * `processOutbox`, and the compliance digest and scheduled report delivery
 * through `resolveTenantEmailEnvelope`), and
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
 * The envelope a workspace's own email goes out under: its sender identity and
 * its compliance-mailbox BCC.
 *
 * ONE definition, read by every sender of workspace email — the outbox
 * (`processOutbox`), the weekly compliance digest and scheduled risk-report
 * delivery. Only the outbox applied these until #4469; the other two called
 * `sendEmail` bare, so they went out from the deployment sender with no BCC
 * while the settings page said "all outbound emails" were copied.
 *
 * NOT for invitations or account email (password reset, email verification):
 * those are the platform's own messages, they always send, and they keep the
 * deployment sender. A workspace whose email is switched off must still be
 * able to invite somebody and to let a member reset a password.
 */
export interface TenantEmailEnvelope {
    from: string;
    /** The compliance mailbox, or `undefined` when none is set. */
    bcc: string | undefined;
}

export function tenantEmailEnvelope(
    settings: Pick<TenantNotificationSettingsData, 'defaultFromName' | 'defaultFromEmail' | 'complianceMailbox'>,
): TenantEmailEnvelope {
    return {
        from: `${settings.defaultFromName} <${settings.defaultFromEmail}>`,
        bcc: settings.complianceMailbox || undefined,
    };
}

/**
 * May this workspace send its own email now, and under what envelope?
 *
 * `null` when the workspace has switched email notifications off — the caller
 * sends nothing. Otherwise the envelope to spread into `sendEmail`. Reading
 * the switch and the envelope from one row in one call means a sender cannot
 * apply one without the other.
 *
 * A failed read THROWS rather than falling back to "enabled, deployment
 * sender": the caller's own error handling then skips the send, which is the
 * safe direction for a workspace that may have switched email off.
 */
export async function resolveTenantEmailEnvelope(
    db: PrismaTx,
    tenantId: string,
): Promise<TenantEmailEnvelope | null> {
    const settings = await getTenantNotificationSettings(db, tenantId);
    return settings.enabled ? tenantEmailEnvelope(settings) : null;
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
