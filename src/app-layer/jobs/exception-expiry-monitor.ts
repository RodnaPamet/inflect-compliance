/**
 * Epic G-5 — Control exception expiry monitor.
 *
 * Daily scan that fires reminders for APPROVED exceptions whose
 * `expiresAt` falls on a 30 / 14 / 7 day calendar window. Recipients
 * are the exception's `riskAcceptedByUser` (always) and
 * `approvedByUser` (when distinct from the risk-accepter). Outbox
 * dedupe + the calendar-day trigger condition keep the job from
 * spamming.
 *
 * Trigger discipline — the brief calls out "30/14/7 days before".
 * We compute days using calendar-day arithmetic (midnight-to-midnight)
 * so the trigger is robust to time-of-day drift in the cron schedule
 * vs. the stored `expiresAt`. The job ONLY fires when calendar-days
 * is exactly 30, 14, or 7. A day off-cycle (cron crash, missed
 * window) skips that reminder — not all three. Operators have other
 * surfaces (dashboard count, control-detail badge) so a single
 * missed nudge is acceptable.
 *
 * Two scope modes (mirrors `policyReviewReminder`):
 *   - tenantId provided → scan that single tenant.
 *   - tenantId omitted  → scan every tenant (system-wide nightly).
 *
 * Bypassed when:
 *   - Exception is not APPROVED (excluded by query).
 *   - `expiresAt` IS NULL (excluded by query).
 *   - Tenant has notifications disabled (enqueueEmail short-circuits).
 *   - Recipient has no email (logged + skipped).
 */
import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/observability/logger';
import { enqueueEmail } from '../notifications/enqueue';
import { appendAuditEntry } from '@/lib/audit';
import { reopenExpiredHarnessAcceptances } from '../usecases/agent-harness-acceptance';

export const REMINDER_WINDOWS: readonly (30 | 14 | 7)[] = [30, 14, 7];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ExceptionExpiryMonitorOptions {
    tenantId?: string;
    /** Override the "now" anchor — test-only seam. */
    now?: Date;
}

export interface ExceptionExpiryMonitorResult {
    /** Approved-with-expiry rows scanned. */
    scanned: number;
    /** Reminders that successfully landed in the outbox. */
    enqueued: number;
    /** Window matches that didn't end up enqueued (per-day dedupe,
     *  notifications-disabled tenant, missing recipient email). */
    skippedDuplicate: number;
    skippedNoEmail: number;
    /** Rows that were in-window but no recipient could be resolved
     *  (both risk-accepter AND approver missing email). */
    skippedNoRecipient: number;
    /** Rows that crossed `expiresAt` and got transitioned APPROVED →
     *  EXPIRED in this run. Each one emits a `CONTROL_EXCEPTION_EXPIRED`
     *  audit row. */
    transitionedToExpired: number;
    /** Harness shortfalls reopened because their acceptance expired (#3665). */
    harnessShortfallsReopened: number;
}

/**
 * Calendar-day arithmetic — strips time-of-day so day-N counts are
 * robust to wall-clock drift. Pure; suitable for unit tests.
 */
export function calendarDaysUntil(expiresAt: Date, now: Date): number {
    const startOfDay = (d: Date) =>
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return Math.floor((startOfDay(expiresAt) - startOfDay(now)) / MS_PER_DAY);
}

/**
 * Predicate — does today fire a reminder for this expiry?
 * Returns the matching window (30 | 14 | 7) or `null`.
 */
export function reminderWindowFor(
    expiresAt: Date,
    now: Date,
): 30 | 14 | 7 | null {
    const days = calendarDaysUntil(expiresAt, now);
    return REMINDER_WINDOWS.includes(days as 30 | 14 | 7)
        ? (days as 30 | 14 | 7)
        : null;
}

/**
 * Compose the outbox `entityId` for dedupe. The window component
 * means a same-day re-run dedupes (per-day key) AND a different
 * window for the same exception lands in a NEW row (different
 * entityId). Outbox unique key is
 *   (tenantId, type, email, entityId, YYYY-MM-DD)
 * — adding `:N` to entityId gives us per-window dedupe automatically.
 */
function dedupeEntityId(exceptionId: string, window: 30 | 14 | 7): string {
    return `${exceptionId}:${window}d`;
}

export async function runExceptionExpiryMonitor(
    db: PrismaClient,
    options: ExceptionExpiryMonitorOptions = {},
): Promise<ExceptionExpiryMonitorResult> {
    const now = options.now ?? new Date();
    const { tenantId } = options;
    const scope = tenantId ? 'tenant-scoped' : 'system-wide';

    logger.info('exception-expiry monitor scan starting', {
        component: 'exception-expiry-monitor',
        scope,
        ...(tenantId ? { tenantId } : {}),
    });

    // Lookahead just past the largest window so we don't pull every
    // approved exception in the world. 31 days gives a single-day
    // buffer for clock skew between scheduler tick and the
    // calendar-day arithmetic above.
    const horizon = new Date(now.getTime() + 31 * MS_PER_DAY);

    const candidates = await db.controlException.findMany({
        where: {
            status: 'APPROVED',
            deletedAt: null,
            expiresAt: { not: null, gte: now, lte: horizon },
            ...(tenantId ? { tenantId } : {}),
        },
        select: {
            id: true,
            tenantId: true,
            controlId: true,
            expiresAt: true,
            riskAcceptedByUserId: true,
            approvedByUserId: true,
            control: {
                select: { id: true, name: true, code: true },
            },
            tenant: { select: { slug: true } },
            riskAcceptedBy: { select: { email: true, name: true } },
            approvedBy: { select: { email: true, name: true } },
        },
    });

    // ── Phase 1 — flip APPROVED rows past their expiresAt to
    //   EXPIRED, with one audit-log row per transition. Done first
    //   so the post-flip status is observable for any downstream
    //   reporting that runs in the same job tick.
    const transitionedToExpired = await transitionPastDueToExpired(
        db,
        now,
        tenantId,
    );

    // ── Phase 1b — the harness-shortfall acceptances (#3665). The same
    //   monitor on purpose, by the owner's decision: one expiry mechanism in
    //   behaviour, not two that could drift apart.
    const harnessShortfallsReopened = await reopenExpiredHarnessAcceptances(db, now, tenantId);

    let enqueued = 0;
    let skippedDuplicate = 0;
    let skippedNoEmail = 0;
    let skippedNoRecipient = 0;
    let inWindowCount = 0;

    for (const ex of candidates) {
        if (!ex.expiresAt) continue; // type-narrow; `not: null` already filters at DB
        const window = reminderWindowFor(ex.expiresAt, now);
        if (window === null) continue;
        inWindowCount++;

        // Recipient set — risk-accepter + (approver if distinct).
        const recipients: Array<{
            email: string;
            name: string;
        }> = [];
        if (ex.riskAcceptedBy?.email) {
            recipients.push({
                email: ex.riskAcceptedBy.email,
                name: ex.riskAcceptedBy.name ?? ex.riskAcceptedBy.email,
            });
        }
        if (
            ex.approvedBy?.email &&
            ex.approvedByUserId !== ex.riskAcceptedByUserId &&
            ex.approvedBy.email !== ex.riskAcceptedBy?.email
        ) {
            recipients.push({
                email: ex.approvedBy.email,
                name: ex.approvedBy.name ?? ex.approvedBy.email,
            });
        }

        if (recipients.length === 0) {
            skippedNoRecipient++;
            logger.warn('exception-expiry-monitor: no recipient resolvable', {
                component: 'exception-expiry-monitor',
                exceptionId: ex.id,
                tenantId: ex.tenantId,
            });
            continue;
        }

        for (const r of recipients) {
            if (!r.email) {
                skippedNoEmail++;
                continue;
            }
            const result = await enqueueEmail(db, {
                tenantId: ex.tenantId,
                type: 'EXCEPTION_EXPIRING',
                toEmail: r.email,
                entityId: dedupeEntityId(ex.id, window),
                payload: {
                    recipientName: r.name,
                    controlName: ex.control?.name ?? '(unnamed control)',
                    controlCode: ex.control?.code ?? null,
                    daysRemaining: window,
                    expiresAtIso: ex.expiresAt.toISOString(),
                    tenantSlug: ex.tenant.slug,
                    exceptionId: ex.id,
                    controlId: ex.controlId,
                },
            });
            if (result) {
                enqueued++;
            } else {
                skippedDuplicate++;
            }
        }
    }

    const result: ExceptionExpiryMonitorResult = {
        scanned: inWindowCount,
        enqueued,
        skippedDuplicate,
        skippedNoEmail,
        skippedNoRecipient,
        transitionedToExpired,
        harnessShortfallsReopened,
    };

    logger.info('exception-expiry monitor scan complete', {
        component: 'exception-expiry-monitor',
        scope,
        ...result,
        ...(tenantId ? { tenantId } : {}),
    });

    return result;
}

/**
 * Phase 1 of the monitor — APPROVED rows whose expiresAt has
 * elapsed transition to EXPIRED. Each transition emits a
 * `CONTROL_EXCEPTION_EXPIRED` audit row so the lifecycle is
 * reconstructible from the audit log alone (auditors should never
 * have to read the live table to know an exception expired).
 *
 * The transition is per-row (not bulk) so each row gets its own
 * audit entry — the hash chain anchors a separate event-id per
 * exception, and partial failures don't take the whole batch down.
 *
 * Returns the number of rows actually transitioned this run.
 */
async function transitionPastDueToExpired(
    db: PrismaClient,
    now: Date,
    tenantId?: string,
): Promise<number> {
    const candidates = await db.controlException.findMany({
        where: {
            status: 'APPROVED',
            deletedAt: null,
            expiresAt: { not: null, lte: now },
            ...(tenantId ? { tenantId } : {}),
        },
        select: {
            id: true,
            tenantId: true,
            controlId: true,
            expiresAt: true,
        },
    });

    let transitioned = 0;
    for (const row of candidates) {
        // Atomic flip — keyed on the prior-state predicate so a
        // concurrent renew/re-approve never gets clobbered. The CHECK
        // constraint requires the approver triple to remain intact;
        // we only set status, leaving every other field alone.
        const update = await db.controlException.updateMany({
            where: {
                id: row.id,
                tenantId: row.tenantId,
                status: 'APPROVED',
                deletedAt: null,
                expiresAt: { not: null, lte: now },
            },
            data: { status: 'EXPIRED' },
        });
        if (update.count === 0) continue;

        // Durable audit row — the system actor. The hash chain
        // anchors this event before the next run, so an auditor can
        // reconstruct "this exception expired at T" from the log
        // without reading the row.
        await appendAuditEntry({
            tenantId: row.tenantId,
            userId: null,
            actorType: 'SYSTEM',
            entity: 'ControlException',
            entityId: row.id,
            action: 'CONTROL_EXCEPTION_EXPIRED',
            detailsJson: {
                category: 'status_change',
                entityName: 'ControlException',
                fromStatus: 'APPROVED',
                toStatus: 'EXPIRED',
                summary: `Exception ${row.id} transitioned to EXPIRED at scheduled deadline`,
                after: {
                    controlId: row.controlId,
                    expiresAtIso: row.expiresAt?.toISOString() ?? null,
                    transitionedBy: 'exception-expiry-monitor',
                },
            },
        });

        transitioned++;
    }

    return transitioned;
}
