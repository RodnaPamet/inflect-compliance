/**
 * Digest Dispatcher — Owner-Grouped Notification Dispatch
 *
 * Takes DueItem[] from monitoring jobs, groups items by owner/tenant,
 * resolves recipient emails, builds digest templates, and enqueues
 * through the existing NotificationOutbox with deduplication.
 *
 * Architecture:
 *   Monitor → DueItem[] → DigestDispatcher → NotificationOutbox → processOutbox → Email
 *
 * Grouping rules:
 *   1. Group by tenantId first (tenant isolation)
 *   2. Within tenant, group by ownerUserId
 *   3. Items without ownerUserId go to tenant admins
 *   4. One digest email per owner per category per day
 *
 * Deduplication:
 *   Uses the existing dedupeKey pattern: {tenantId}:{type}:{email}:{digest}:{YYYY-MM-DD}
 *   Since the key includes the date, the same digest is sent at most once per day per recipient.
 *
 * @module app-layer/notifications/digest-dispatcher
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import type { DueItem } from '../jobs/types';
import { isNotificationsEnabled } from './settings';
import {
    buildDeadlineDigestEmail,
    buildEvidenceExpiryDigestEmail,
    buildVendorRenewalDigestEmail,
} from './digest-templates';

// ─── Types ──────────────────────────────────────────────────────────

export type DigestCategory = 'DEADLINE_DIGEST' | 'EVIDENCE_EXPIRY_DIGEST' | 'VENDOR_RENEWAL_DIGEST';

export interface DispatchDigestOptions {
    /** The category of digest to send */
    category: DigestCategory;
    /** DueItems from the monitoring job */
    items: DueItem[];
    /** Override current time (for testing) */
    now?: Date;
}

export interface DispatchDigestResult {
    /** Number of digest emails enqueued */
    enqueued: number;
    /** Number of digests skipped (duplicate / disabled) */
    skipped: number;
    /** Number of items that had no resolvable recipient */
    unroutable: number;
    /** Total items processed */
    totalItems: number;
    /** Number of items suppressed due to tenant notifications disabled */
    suppressed: number;
    /** Per-tenant breakdown */
    tenants: Record<string, { enqueued: number; skipped: number; suppressed?: boolean }>;
}

export interface RecipientInfo {
    userId: string;
    email: string;
    name: string;
}

// ─── Recipient Resolution ───────────────────────────────────────────

/** Map key for a resolved recipient — a user is only ever a recipient OF a tenant. */
const recipientKey = (tenantId: string, userId: string) => `${tenantId}:${userId}`;

/**
 * Resolve (tenant, user) pairs to email addresses, for users who are STILL
 * MEMBERS of that tenant.
 *
 * The membership join is the whole point. Owner ids reach this function from
 * entity columns — `Control.ownerUserId`, `Policy.ownerUserId`,
 * `Task.assigneeUserId`, `Risk.ownerUserId`, … — and NONE of them are cleared
 * when a membership is deactivated (`deactivateTenantMember` writes only
 * `status` + `deactivatedAt`). This used to be a bare
 * `prisma.user.findMany({ where: { id: { in: userIds } } })`, so a departed
 * employee kept receiving that tenant's compliance deadlines — entity names,
 * due dates and links — nightly, forever.
 *
 * RLS is not a backstop here and cannot be one: `User` is a global model with
 * no `tenantId` and no row-level policies, and this runs on the unscoped
 * client outside `runInTenantContext`. The predicate below IS the control —
 * the same one `resolveTenantAdmins` has always had.
 *
 * Keyed per (tenant, user), not per user: the same person can be ACTIVE in one
 * tenant and DEACTIVATED in another, and a userId-only key would collapse those
 * into one entry and leak the second tenant's deadlines to them.
 *
 * Still ONE query, not one per tenant — a read inside the caller's loop would
 * trip the N+1 guardrail.
 */
async function resolveRecipients(
    pairs: Array<{ tenantId: string; userId: string }>,
): Promise<Map<string, RecipientInfo>> {
    if (pairs.length === 0) return new Map();

    const memberships = await prisma.tenantMembership.findMany({
        where: {
            status: 'ACTIVE',
            OR: pairs.map(({ tenantId, userId }) => ({ tenantId, userId })),
        },
        select: {
            tenantId: true,
            user: { select: { id: true, email: true, name: true } },
        },
    });

    const result = new Map<string, RecipientInfo>();
    for (const m of memberships) {
        if (m.user.email) {
            result.set(recipientKey(m.tenantId, m.user.id), {
                userId: m.user.id,
                email: m.user.email,
                name: m.user.name ?? m.user.email.split('@')[0],
            });
        }
    }

    // Recipient shrinkage is otherwise silent: the caller counts a dropped
    // owner as `unroutable`, which is indistinguishable from "this user was
    // deleted". Log the count so an operator can tell a healthy offboarding
    // from a broken lookup.
    const dropped = pairs.length - result.size;
    if (dropped > 0) {
        logger.info('digest recipients dropped — no active membership', {
            component: 'digest-dispatcher',
            requested: pairs.length,
            resolved: result.size,
            dropped,
        });
    }

    return result;
}

/**
 * Resolve tenant admins as fallback recipients for unowned items.
 *
 * OWNER is included, not just ADMIN. Epic 1 made OWNER strictly superior to
 * ADMIN — it holds every admin flag plus `tenant_lifecycle` and
 * `owner_management` — so a role filter of `'ADMIN'` alone excluded the most
 * privileged member of the tenant. A tenant whose only privileged member is an
 * OWNER (the shape every tenant starts in: `createTenantWithOwner` mints an
 * OWNER and nothing else) resolved ZERO fallback recipients, and every unowned
 * item was counted `unroutable` and silently dropped. No digest at all.
 */
async function resolveTenantAdmins(
    tenantId: string,
): Promise<RecipientInfo[]> {
    const memberships = await prisma.tenantMembership.findMany({
        where: {
            tenantId,
            role: { in: ['OWNER', 'ADMIN'] },
            status: 'ACTIVE',
        },
        select: {
            user: {
                select: { id: true, email: true, name: true },
            },
        },
        take: 10, // Cap to avoid spamming large admin teams
    });

    return memberships
        .filter(m => m.user.email)
        .map(m => ({
            userId: m.user.id,
            email: m.user.email,
            name: m.user.name ?? m.user.email.split('@')[0],
        }));
}

/**
 * Resolve tenant slug for building links.
 */
async function resolveTenantSlug(tenantId: string): Promise<string> {
    const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { slug: true },
    });
    return tenant?.slug ?? tenantId;
}

// ─── Dedupe Key Builder ─────────────────────────────────────────────

/**
 * Build a dedupe key for digest emails.
 * Format: {tenantId}:{category}:{email}:digest:{YYYY-MM-DD}
 *
 * The key is scoped to the date, so the same digest is sent at most
 * once per day per recipient per category.
 */
export function buildDigestDedupeKey(
    tenantId: string,
    category: DigestCategory,
    email: string,
    date: Date = new Date(),
): string {
    const day = date.toISOString().slice(0, 10); // YYYY-MM-DD
    return `${tenantId}:${category}:${email}:digest:${day}`;
}

// ─── Template Selector ──────────────────────────────────────────────

function buildDigestEmail(
    category: DigestCategory,
    recipientName: string,
    tenantSlug: string,
    items: DueItem[],
): { subject: string; bodyText: string; bodyHtml: string } {
    switch (category) {
        case 'DEADLINE_DIGEST':
            return buildDeadlineDigestEmail({ recipientName, tenantSlug, items });
        case 'EVIDENCE_EXPIRY_DIGEST':
            return buildEvidenceExpiryDigestEmail({ recipientName, tenantSlug, items });
        case 'VENDOR_RENEWAL_DIGEST':
            return buildVendorRenewalDigestEmail({ recipientName, tenantSlug, items });
        default: {
            const _exhaustive: never = category;
            throw new Error(`Unknown digest category: ${_exhaustive}`);
        }
    }
}

// ─── Grouping ───────────────────────────────────────────────────────

interface GroupedItems {
    /** Items grouped by tenantId → ownerUserId → DueItem[] */
    byOwner: Map<string, Map<string, DueItem[]>>;
    /** Items without ownerUserId, grouped by tenantId */
    unowned: Map<string, DueItem[]>;
}

function groupItems(items: DueItem[]): GroupedItems {
    const byOwner = new Map<string, Map<string, DueItem[]>>();
    const unowned = new Map<string, DueItem[]>();

    for (const item of items) {
        if (item.ownerUserId) {
            if (!byOwner.has(item.tenantId)) {
                byOwner.set(item.tenantId, new Map());
            }
            const tenantMap = byOwner.get(item.tenantId)!;
            if (!tenantMap.has(item.ownerUserId)) {
                tenantMap.set(item.ownerUserId, []);
            }
            tenantMap.get(item.ownerUserId)!.push(item);
        } else {
            if (!unowned.has(item.tenantId)) {
                unowned.set(item.tenantId, []);
            }
            unowned.get(item.tenantId)!.push(item);
        }
    }

    return { byOwner, unowned };
}

// ─── Main Dispatch Function ─────────────────────────────────────────

/**
 * Dispatch grouped digest notifications for DueItems.
 *
 * 1. Groups items by tenant → owner
 * 2. Resolves recipient emails
 * 3. Builds digest template per recipient
 * 4. Enqueues through NotificationOutbox with deduplication
 *
 * Idempotent: safe to call multiple times per day — duplicates
 * are silently skipped via the outbox dedupeKey unique constraint.
 */
export async function dispatchDigest(
    options: DispatchDigestOptions,
): Promise<DispatchDigestResult> {
    const { category, items, now = new Date() } = options;

    if (items.length === 0) {
        return {
            enqueued: 0,
            skipped: 0,
            unroutable: 0,
            suppressed: 0,
            totalItems: 0,
            tenants: {},
        };
    }

    const { byOwner, unowned } = groupItems(items);
    let enqueued = 0;
    let skipped = 0;
    let unroutable = 0;
    let suppressed = 0;
    const tenants: Record<string, { enqueued: number; skipped: number; suppressed?: boolean }> = {};

    // Collect (tenant, user) pairs for batch resolution. Iterating `entries`
    // rather than `values` keeps the tenant, which is what lets the lookup
    // below require an ACTIVE membership IN THAT TENANT.
    const ownerPairs: Array<{ tenantId: string; userId: string }> = [];
    for (const [tenantId, tenantMap] of byOwner) {
        for (const userId of tenantMap.keys()) {
            ownerPairs.push({ tenantId, userId });
        }
    }
    const recipients = await resolveRecipients(ownerPairs);

    // Collect all unique tenant IDs
    const allTenantIds = new Set<string>();
    for (const item of items) allTenantIds.add(item.tenantId);

    // ── Tenant notification eligibility check ───────────────────────
    // Enforce the same isNotificationsEnabled rule used by enqueue.ts.
    // Disabled tenants are skipped entirely — no digest email is sent.
    const eligibleTenants = new Set<string>();
    for (const tenantId of allTenantIds) {
        const enabled = await isNotificationsEnabled(prisma, tenantId);
        if (enabled) {
            eligibleTenants.add(tenantId);
        } else {
            // Count suppressed items for this tenant
            const tenantItemCount = items.filter(i => i.tenantId === tenantId).length;
            suppressed += tenantItemCount;
            tenants[tenantId] = { enqueued: 0, skipped: 0, suppressed: true };
            logger.info('digest suppressed — notifications disabled for tenant', {
                component: 'digest-dispatcher',
                category,
                tenantId,
                itemCount: tenantItemCount,
            });
        }
    }

    // Resolve tenant slugs in batch (only eligible tenants)
    const slugs = new Map<string, string>();
    for (const tenantId of eligibleTenants) {
        slugs.set(tenantId, await resolveTenantSlug(tenantId));
    }

    // Process owned items (grouped by user)
    for (const [tenantId, tenantMap] of byOwner) {
        if (!eligibleTenants.has(tenantId)) continue; // Notifications disabled
        if (!tenants[tenantId]) tenants[tenantId] = { enqueued: 0, skipped: 0 };
        const tenantSlug = slugs.get(tenantId) ?? tenantId;

        for (const [userId, userItems] of tenantMap) {
            const recipient = recipients.get(recipientKey(tenantId, userId));
            if (!recipient) {
                // Either the user is gone, or — the common case — they are no
                // longer an active member of THIS tenant. Their items are not
                // re-routed to admins: `groupItems` already classified them as
                // owned, and an offboarded owner's deadlines becoming admin
                // mail on the night of deactivation would be its own surprise.
                unroutable += userItems.length;
                logger.warn('digest recipient not resolvable', {
                    component: 'digest-dispatcher',
                    category,
                    tenantId,
                    userId,
                    itemCount: userItems.length,
                });
                continue;
            }

            const result = await enqueueDigest(
                tenantId, category, recipient, tenantSlug, userItems, now,
            );
            if (result) {
                enqueued++;
                tenants[tenantId].enqueued++;
            } else {
                skipped++;
                tenants[tenantId].skipped++;
            }
        }
    }

    // Process unowned items → send to tenant admins
    for (const [tenantId, unownedItems] of unowned) {
        if (!eligibleTenants.has(tenantId)) continue; // Notifications disabled
        if (!tenants[tenantId]) tenants[tenantId] = { enqueued: 0, skipped: 0 };
        const tenantSlug = slugs.get(tenantId) ?? tenantId;
        const admins = await resolveTenantAdmins(tenantId);

        if (admins.length === 0) {
            unroutable += unownedItems.length;
            logger.warn('no tenant admins for unowned items', {
                component: 'digest-dispatcher',
                category,
                tenantId,
                itemCount: unownedItems.length,
            });
            continue;
        }

        // Send unowned items to all admins
        for (const admin of admins) {
            const result = await enqueueDigest(
                tenantId, category, admin, tenantSlug, unownedItems, now,
            );
            if (result) {
                enqueued++;
                tenants[tenantId].enqueued++;
            } else {
                skipped++;
                tenants[tenantId].skipped++;
            }
        }
    }

    logger.info('digest dispatch completed', {
        component: 'digest-dispatcher',
        category,
        totalItems: items.length,
        enqueued,
        skipped,
        suppressed,
        unroutable,
    });

    return { enqueued, skipped, unroutable, suppressed, totalItems: items.length, tenants };
}

// ─── Outbox Enqueue ─────────────────────────────────────────────────

/**
 * Enqueue a single digest email into the outbox.
 * Returns the record if created, null if deduplicated or error.
 */
async function enqueueDigest(
    tenantId: string,
    category: DigestCategory,
    recipient: RecipientInfo,
    tenantSlug: string,
    items: DueItem[],
    now: Date,
): Promise<{ id: string; dedupeKey: string } | null> {
    const dedupeKey = buildDigestDedupeKey(tenantId, category, recipient.email, now);
    const { subject, bodyText, bodyHtml } = buildDigestEmail(
        category, recipient.name, tenantSlug, items,
    );

    try {
        const record = await prisma.notificationOutbox.create({
            data: {
                tenantId,
                type: category,
                toEmail: recipient.email,
                subject,
                bodyText,
                bodyHtml,
                dedupeKey,
            },
        });
        return { id: record.id, dedupeKey };
    } catch (error: unknown) {
        // P2002 = unique constraint = duplicate dedupe key → skip
        const errorCode = typeof error === 'object' && error !== null && 'code' in error
            ? (error as Record<string, unknown>).code
            : undefined;
        const errorMessage = error instanceof Error ? error.message : undefined;
        if (errorCode === 'P2002' || errorMessage?.includes('Unique constraint')) {
            logger.debug('digest skipped — duplicate', {
                component: 'digest-dispatcher',
                category,
                dedupeKey,
            });
            return null;
        }
        throw error;
    }
}
