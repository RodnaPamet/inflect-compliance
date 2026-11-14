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
import { getTenantNotificationSettings, tenantEmailEnvelope } from './settings';
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

/**
 * How long a claim keeps a row out of every other pass's reach (#5110).
 *
 * The claim moves `sendAfter` this far into the future, so a row whose send
 * is in flight is not selectable — by the drain's `findMany` or by another
 * claim — until the lease runs out. It must outlast one slow send, not a
 * whole batch: each row is leased immediately before its own send. The
 * production transport is nodemailer with its default timeouts — 2 minutes
 * to connect, 30 seconds for the greeting, 10 minutes of socket inactivity —
 * so 15 minutes covers a send that hangs until nodemailer gives up on it.
 *
 * Erring long costs only latency on the crash path: a pass that dies
 * mid-send leaves its row PENDING, and the row is retried once the lease
 * expires (at-least-once, the contract this processor has always had).
 * Erring short is the bug this lease exists to fix — a second send of an
 * email that is still on the wire.
 */
export const OUTBOX_CLAIM_LEASE_MS = 15 * 60 * 1000;

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

    // Fetch PENDING rows where sendAfter <= now and attempts < maxAttempts.
    // The `sendAfter` filter is also what hides a row another pass is
    // sending: its claim moved `sendAfter` forward by the lease (#5110).

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

            // The tenant disabled notifications after this row was queued.
            // SETTLE the row rather than leave it PENDING (#5237): a PENDING
            // row is selected again by every pass, so 200 of them at the head
            // of the queue filled each batch and stopped every other tenant's
            // email, and each one counted as overdue to the work-overdue
            // reporter for ever. Conditional on PENDING so a concurrent pass
            // that already claimed it is not overwritten.
            if (!settings.enabled) {
                await prisma.notificationOutbox.updateMany({
                    where: { id: row.id, status: 'PENDING' },
                    data: { status: 'FAILED', lastError: 'notifications disabled for tenant' },
                });
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
            // `attempts` is the optimistic-concurrency token among passes that
            // read the row BEFORE any of them claimed it: the claim only matches
            // while the row still holds the value we read, so of those, one
            // wins and the rest see count 0. That also fixes a second bug —
            // `attempts: row.attempts + 1` was a stale read-modify-write, so
            // two failing passes both wrote 1 and burned one unit of a
            // three-attempt budget instead of two.
            //
            // The token alone does NOT exclude a pass that reads AFTER our
            // claim (#5110): the row is still PENDING with attempts below the
            // ceiling, so that pass selects it, claims it on the new attempts
            // value, and sends it again while our send is in flight. The claim
            // therefore also takes a LEASE on `sendAfter` — it moves it
            // `OUTBOX_CLAIM_LEASE_MS` into the future, and requires it to be
            // due — so a row mid-send is invisible to every other pass's
            // `findMany` and refused by every other pass's claim. Success
            // settles it SENT; failure puts `sendAfter` back (below); a crash
            // leaves the lease to expire, after which the row is retried.
            //
            // Incrementing BEFORE the send is the correct meaning of the
            // field: it counts attempts made, and after this point an attempt
            // HAS been made whether or not we live to record the outcome.
            const claimAt = new Date();
            const claim = await prisma.notificationOutbox.updateMany({
                where: {
                    id: row.id,
                    status: 'PENDING',
                    attempts: row.attempts,
                    sendAfter: { lte: claimAt },
                },
                data: {
                    attempts: { increment: 1 },
                    sendAfter: new Date(claimAt.getTime() + OUTBOX_CLAIM_LEASE_MS),
                },
            });
            if (claim.count === 0) {
                // Another pass owns this row. Not an error, and not a failure:
                // it will be sent (or has been) by them.
                skipped++;
                continue;
            }
            attemptsNow = row.attempts + 1;

            await sendEmail({
                to: row.toEmail,
                subject: row.subject,
                text: row.bodyText,
                html: row.bodyHtml || undefined,
                // The workspace's sender and compliance BCC — the same
                // definition the digest and scheduled reports use.
                ...tenantEmailEnvelope(settings),
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
            //
            // When we DID claim, the write also releases our lease by putting
            // `sendAfter` back to the value we read. No backoff is applied
            // here (none ever was), so the row is due again on the next pass,
            // and the work-overdue reporter, which ages PENDING rows by
            // `sendAfter`, keeps measuring from when the row first came due.
            // It is predicated on the attempts value our claim wrote: if our
            // lease expired and another pass has re-claimed the row, that
            // pass's lease is not ours to release.
            const claimed = attemptsNow !== undefined;
            await prisma.notificationOutbox.updateMany({
                where: {
                    id: row.id,
                    status: 'PENDING',
                    ...(claimed ? { attempts: attemptsNow } : {}),
                },
                data: {
                    status: newStatus,
                    lastError: errorMessage,
                    ...(claimed ? { sendAfter: row.sendAfter } : {}),
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
