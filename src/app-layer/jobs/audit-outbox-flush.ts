/**
 * #2657 — drain queued audit entries onto the hash chain.
 *
 * `appendAuditEntryOrQueue` writes an `AuditOutbox` row when the chain
 * write fails. This is the out-of-band half that replays those rows.
 * Until it runs, the event is durable but not yet evidence; after it
 * runs, the entry is on the chain like any other.
 *
 * ═══════════════════════════════════════════════════════════════════
 * THE TIMESTAMP, WHICH IS THE SUBTLE PART
 * ═══════════════════════════════════════════════════════════════════
 *
 * `appendAuditEntry` stamps `createdAt` ITSELF, after taking the
 * per-tenant advisory lock, because strictly-monotonic ordering within
 * a tenant is exactly what that lock buys. It accepts no caller-supplied
 * time, and it should not: a backdated entry would break the ordering
 * the chain's `previousHash` lookup depends on.
 *
 * So a replayed entry necessarily lands on the chain stamped at DRAIN
 * time. That is honest for the chain — it really was recorded then —
 * and misleading for a reader, who cares when the denial happened.
 *
 * The resolution is to carry BOTH: the chain keeps its own monotonic
 * `createdAt`, and the drain injects the original event time into the
 * entry's `detailsJson` as `occurredAt`, alongside a marker saying the
 * entry was replayed. A reader who does not know about the outbox reads
 * a truthful record; a reader who does can tell the two times apart.
 *
 * ═══════════════════════════════════════════════════════════════════
 * FAILURE IS LOUD BY CONSTRUCTION
 * ═══════════════════════════════════════════════════════════════════
 *
 * A row that exhausts its attempts becomes FAILED and stays in the
 * table. It is never deleted and never silently dropped: the whole
 * point of #2657 is that a lost audit entry leaves a trace, so the
 * terminal bad state is a queryable row, not an absence.
 */

import { prisma } from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { appendAuditEntry, type AppendAuditInput } from '@/lib/audit/audit-writer';
import { logger } from '@/lib/observability/logger';

export interface FlushAuditOutboxOptions {
    /** Rows to consider in one pass. Default: 100. */
    limit?: number;
    /** Restrict to one tenant. Default: every tenant. */
    tenantId?: string;
    /** Attempts before a row is parked as FAILED. Default: 5. */
    maxAttempts?: number;
}

export interface FlushAuditOutboxResult {
    applied: number;
    failed: number;
    skipped: number;
}

/**
 * Retry backoff, in ms, by attempt number.
 *
 * Deliberately short at the start: the failure this backs up is lock
 * contention, which clears in seconds, not an outage that needs hours.
 */
function backoffMs(attempt: number): number {
    const schedule = [5_000, 30_000, 120_000, 600_000];
    return schedule[Math.min(attempt, schedule.length - 1)] ?? 600_000;
}

/**
 * Merge the original event time into the entry's structured details.
 *
 * `detailsJson` is `unknown` on the input type, so this has to cope with
 * a non-object payload rather than assume a shape. A caller that stored
 * a string or null still gets its `occurredAt`, wrapped rather than
 * dropped.
 */
function withReplayMarkers(detailsJson: unknown, occurredAt: Date): unknown {
    const markers = {
        occurredAt: occurredAt.toISOString(),
        replayedFromOutbox: true,
    };

    if (detailsJson !== null && typeof detailsJson === 'object' && !Array.isArray(detailsJson)) {
        return { ...(detailsJson as Record<string, unknown>), ...markers };
    }
    // Non-object (string, array, number, null, undefined): keep it under a
    // named key rather than discarding it to make room for the markers.
    return { originalDetails: detailsJson ?? null, ...markers };
}

export async function flushAuditOutbox(
    options: FlushAuditOutboxOptions = {},
): Promise<FlushAuditOutboxResult> {
    const limit = options.limit ?? 100;
    const maxAttempts = options.maxAttempts ?? 5;
    const now = new Date();

    const rows = await prisma.auditOutbox.findMany({
        where: {
            status: 'PENDING',
            nextAttemptAt: { lte: now },
            attempts: { lt: maxAttempts },
            ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        },
        // Oldest event first: the chain should receive a backlog in the
        // order the events happened, not the order rows were inserted.
        orderBy: { occurredAt: 'asc' },
        take: limit,
    });

    let applied = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of rows) {
        let attemptsNow: number | undefined;
        try {
            // Claim, exactly as processOutbox does. `attempts` is the
            // optimistic-concurrency token: the claim only matches while the
            // row still holds the value we read, so one pass wins and the
            // loser sees count 0. Incrementing BEFORE the append is the
            // correct meaning — an attempt HAS been made whether or not we
            // live to record its outcome.
            const claim = await prisma.auditOutbox.updateMany({
                where: { id: row.id, status: 'PENDING', attempts: row.attempts },
                data: { attempts: { increment: 1 } },
            });
            if (claim.count === 0) {
                skipped++;
                continue;
            }
            attemptsNow = row.attempts + 1;

            const payload = row.payloadJson as unknown as AppendAuditInput;
            const result = await appendAuditEntry({
                ...payload,
                detailsJson: withReplayMarkers(payload.detailsJson, row.occurredAt),
            });

            // Predicated on PENDING so this cannot resurrect a row another
            // actor has since moved to FAILED or APPLIED.
            await prisma.auditOutbox.updateMany({
                where: { id: row.id, status: 'PENDING' },
                data: {
                    status: 'APPLIED',
                    appliedAt: new Date(),
                    appliedAuditId: result.id,
                },
            });
            applied++;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            // The claim already incremented, so do NOT increment again and do
            // NOT write an absolute value — that is the read-modify-write bug
            // processOutbox records having had.
            const newAttempts = attemptsNow ?? row.attempts + 1;
            const newStatus = newAttempts >= maxAttempts ? 'FAILED' : 'PENDING';

            await prisma.auditOutbox.updateMany({
                where: { id: row.id, status: 'PENDING' },
                data: {
                    status: newStatus,
                    lastError: message,
                    nextAttemptAt: new Date(Date.now() + backoffMs(newAttempts)),
                },
            });

            if (newStatus === 'FAILED') {
                failed++;
                // ERROR, not warn: a security audit entry has now failed
                // every retry it is going to get, and the row is parked for a
                // human. This is the loudest thing the mechanism can do, and
                // it is still not a silent drop — the row remains queryable.
                logger.error('audit outbox: entry permanently failed', {
                    outboxId: row.id,
                    tenantId: row.tenantId,
                    action: row.action,
                    occurredAt: row.occurredAt.toISOString(),
                    attempts: newAttempts,
                    error: message,
                });
            } else {
                skipped++;
                logger.warn('audit outbox: replay failed, will retry', {
                    outboxId: row.id,
                    tenantId: row.tenantId,
                    action: row.action,
                    attempt: newAttempts,
                    error: message,
                });
            }
        }
    }

    return { applied, failed, skipped };
}

/** Rows one scheduled pass will consider. */
export const AUDIT_OUTBOX_FLUSH_LIMIT = 200;

/**
 * Drain the audit outbox once, as a scheduled job.
 *
 * Wrapped in `runJob` for the reason every other job is: it is what puts a
 * jobRunId on the log lines, opens the trace span, and reports a failure to
 * Sentry. A stuck audit outbox is invisible in exactly the way #2657 exists
 * to fix, so the drain being unobservable would reintroduce the defect one
 * level up.
 */
export async function runAuditOutboxFlush(
    options: FlushAuditOutboxOptions = {},
): Promise<FlushAuditOutboxResult> {
    return runJob('audit-outbox-flush', async () => {
        const result = await flushAuditOutbox({
            limit: options.limit ?? AUDIT_OUTBOX_FLUSH_LIMIT,
            tenantId: options.tenantId,
            maxAttempts: options.maxAttempts,
        });

        logger.info('audit outbox flushed', {
            component: 'job',
            applied: result.applied,
            failed: result.failed,
            skipped: result.skipped,
            tenantId: options.tenantId,
        });

        return result;
    }, { tenantId: options.tenantId });
}
