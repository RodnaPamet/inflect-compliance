/**
 * Outbox processor: picks up PENDING emails and sends them via the configured
 * email provider. Marks rows SENT or FAILED with retry tracking.
 *
 * Usage (cron or manual):
 *   import { processOutbox } from '@/app-layer/notifications/processOutbox';
 *   const result = await processOutbox({ limit: 50 });
 *     // { sent: 12, failed: 1, skipped: 0 }
 */

import { prisma } from '@/lib/prisma';
import { sendEmail } from '@/lib/mailer';
import { getTenantNotificationSettings } from './settings';
import { logger } from '@/lib/observability/logger';

export interface ProcessOutboxOptions {
    /** Max emails to process in one run. Default: 50 */
    limit?: number;
    /** Max attempts before marking permanently FAILED. Default: 3 */
    maxAttempts?: number;
    /**
     * Restrict the drain to one tenant.
     *
     * Omitted by the scheduled jobs, which legitimately drain every tenant.
     * REQUIRED from any tenant-scoped caller: without it a tenant ADMIN
     * pressing "Process Outbox" in their own settings page sends every other
     * tenant's queued mail, and reports the combined total back to them.
     */
    tenantId?: string;
}

export interface ProcessOutboxResult {
    sent: number;
    failed: number;
    skipped: number;
}

export async function processOutbox(
    options: ProcessOutboxOptions = {},
): Promise<ProcessOutboxResult> {
    const limit = options.limit ?? 50;
    const maxAttempts = options.maxAttempts ?? 3;
    const now = new Date();

    // Fetch PENDING rows where sendAfter <= now and attempts < maxAttempts

    const pending = await prisma.notificationOutbox.findMany({
        where: {
            status: 'PENDING',
            sendAfter: { lte: now },
            attempts: { lt: maxAttempts },
            // Scoped when the caller names a tenant. The scheduled jobs
            // deliberately pass nothing — draining every tenant's queue is
            // their job — but the tenant-scoped admin route must not, or one
            // tenant's ADMIN pressing "Process Outbox" sends every other
            // tenant's queued mail.
            ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
    });

    // Cache tenant settings to avoid N+1 queries
    const settingsCache = new Map<string, Awaited<ReturnType<typeof getTenantNotificationSettings>>>();

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of pending) {
        // Declared outside the try so the catch can tell "we claimed and the
        // send failed" from "we threw before claiming".
        let attemptsNow: number | undefined;
        try {
            // Look up tenant settings (cached)
            if (!settingsCache.has(row.tenantId)) {
                settingsCache.set(row.tenantId, await getTenantNotificationSettings(prisma, row.tenantId));
            }
            const settings = settingsCache.get(row.tenantId)!;

            // Skip if tenant disabled notifications after enqueue
            if (!settings.enabled) {
                skipped++;
                continue;
            }

            // ═══ CLAIM THE ROW BEFORE SENDING ═══
            //
            // The send is an irreversible outbound email. Marking the row
            // afterwards — which is what this did — cannot prevent a second
            // send, it can only record that one happened.
            //
            // The old completing write was `update({ where: { id } })` with NO
            // state predicate at all, so it was not even an atomic claim: two
            // overlapping passes both selected the row as PENDING, both sent,
            // and both wrote SENT successfully while each reported sent++. The
            // row then showed a single SENT and the stats looked clean; the
            // only trace was in the SMTP provider's log.
            //
            // The window is not theoretical. The 06:00 evidence-expiry job can
            // overlap an admin pressing "Process Outbox", and at real SMTP
            // latency a 200-row batch is tens of seconds wide.
            //
            // `attempts` doubles as the optimistic-concurrency token: the
            // claim only matches while the row still holds the value we read,
            // so exactly one caller wins and the loser sees count 0. That also
            // fixes a second bug — `attempts: row.attempts + 1` was a stale
            // read-modify-write, so two failing passes both wrote 1 and burned
            // one unit of a three-attempt budget instead of two.
            //
            // Incrementing BEFORE the send is the correct meaning of the
            // field: it counts attempts made, and after this point an attempt
            // HAS been made whether or not we live to record the outcome.
            const claim = await prisma.notificationOutbox.updateMany({
                where: { id: row.id, status: 'PENDING', attempts: row.attempts },
                data: { attempts: { increment: 1 } },
            });
            if (claim.count === 0) {
                // Another pass owns this row. Not an error, and not a failure:
                // it will be sent (or has been) exactly once, by them.
                skipped++;
                continue;
            }
            attemptsNow = row.attempts + 1;

            await sendEmail({
                to: row.toEmail,
                subject: row.subject,
                text: row.bodyText,
                html: row.bodyHtml || undefined,
                from: `${settings.defaultFromName} <${settings.defaultFromEmail}>`,
                bcc: settings.complianceMailbox || undefined,
            });

            // Predicated on PENDING so this cannot resurrect a row that some
            // other actor has since moved to FAILED or SENT.
            await prisma.notificationOutbox.updateMany({
                where: { id: row.id, status: 'PENDING' },
                data: { status: 'SENT', sentAt: new Date() },
            });

            sent++;
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            // The claim already incremented `attempts`, so this must NOT
            // increment again — and it must not write an absolute value either,
            // which is what made the old code lose concurrent attempts.
            const newAttempts = attemptsNow ?? row.attempts + 1;
            const newStatus = newAttempts >= maxAttempts ? 'FAILED' : 'PENDING';

            // Predicated on PENDING: if the row was claimed by us it is still
            // PENDING, and if anything else has moved it we must not overwrite
            // that. A settings-lookup failure throws BEFORE the claim, in which
            // case there is nothing of ours to record and the predicate simply
            // matches the untouched row.
            await prisma.notificationOutbox.updateMany({
                where: { id: row.id, status: 'PENDING' },
                data: {
                    status: newStatus,
                    lastError: errorMessage,
                },
            });

            if (newStatus === 'FAILED') {
                failed++;
                logger.error('email permanently failed', { component: 'notifications', dedupeKey: row.dedupeKey, attempts: maxAttempts });
            } else {
                skipped++;
                logger.warn('email attempt failed, will retry', { component: 'notifications', dedupeKey: row.dedupeKey, attempt: newAttempts });
            }
        }
    }

    return { sent, failed, skipped };
}
