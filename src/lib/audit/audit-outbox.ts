/**
 * #2657 — record an audit entry, or make its absence impossible to miss.
 *
 * ═══════════════════════════════════════════════════════════════════
 * THE DEFECT THIS REPLACES
 * ═══════════════════════════════════════════════════════════════════
 *
 * The AUTHZ_DENIED write in `permission-middleware.ts` was wrapped in a
 * catch that logged a warning and returned. The denial still happened,
 * the user was still refused, and the evidence that we refused them was
 * gone. A missing security audit row is worse than a failed request: a
 * failed request is visible to the user and to error monitoring, a
 * missing row is visible to nobody, and is discovered — if ever — by an
 * auditor asking why the log is thinner than the incident.
 *
 * ═══════════════════════════════════════════════════════════════════
 * THE CONTRACT
 * ═══════════════════════════════════════════════════════════════════
 *
 * Exactly one of three things happens, and the caller can tell which:
 *
 *   1. `chain`  — the entry reached the hash chain. Normal path.
 *   2. `queued` — the chain write failed, and a durable AuditOutbox row
 *                 exists instead. Drained out-of-band.
 *   3. it THROWS — both writes failed. The caller learns, and fails
 *                  closed.
 *
 * There is no fourth outcome, and in particular there is no outcome
 * where the entry is gone and nobody knows. That is the whole point:
 * the failure mode being fixed is SILENCE, so any path that can go
 * quiet has not fixed it.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY THE FALLBACK IS MORE AVAILABLE THAN THE THING IT BACKS UP
 * ═══════════════════════════════════════════════════════════════════
 *
 * This is the load-bearing claim, so it should not be taken on faith.
 * `appendAuditEntry` takes a per-tenant `pg_advisory_xact_lock` INSIDE
 * its transaction. Concurrent appends for one tenant therefore serialise,
 * each holding a pooled connection while idling on the lock, and the
 * last of them can fail to START inside Prisma's `maxWait` — which is
 * the failure #2653 observed and #2660 declared limits for.
 *
 * The outbox insert takes no advisory lock and contends with nothing.
 * So this is NOT the same failure retried: it is a different failure
 * mode with a different cause. When they BOTH fail, the database is
 * down, and failing closed is correct rather than merely unavoidable.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ═══════════════════════════════════════════════════════════════════
 *
 * It does not retry in-process. A retry loop would hold the request open
 * across the exact contention window that caused the failure, and would
 * reject real user actions on a transient blip — including the denials
 * that are themselves security events.
 *
 * It does not write to a second audit store. That would be a second
 * source of audit truth to reconcile against the hash chain; the outbox
 * is explicitly a QUEUE, and a row leaves it by becoming a chain entry.
 */

import type { PrismaClient } from '@prisma/client';
import { appendAuditEntry, type AppendAuditInput } from './audit-writer';
import * as prismaModule from '../prisma';
import { logger } from '@/lib/observability/logger';

/**
 * How a single audit entry was recorded.
 *
 * Returned rather than logged, so a caller that needs to behave
 * differently on `queued` (an operator surface, say) can, without
 * re-deriving it from a log line.
 */
export type AuditRecordOutcome =
    | { recorded: 'chain'; auditId: string }
    | { recorded: 'queued'; outboxId: string };

/** Thrown when neither the chain nor the outbox could take the entry. */
export class AuditNotRecordedError extends Error {
    readonly appendError: unknown;
    readonly queueError: unknown;

    constructor(action: string, appendError: unknown, queueError: unknown) {
        super(
            `audit entry '${action}' reached neither the hash chain nor the outbox; ` +
                `failing closed rather than losing the record`,
        );
        this.name = 'AuditNotRecordedError';
        this.appendError = appendError;
        this.queueError = queueError;
    }
}

function getPrisma(): PrismaClient {
    return (prismaModule as unknown as { prisma: PrismaClient }).prisma;
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Append an audit entry, falling back to a durable queue, never dropping it.
 *
 * `occurredAt` is captured BEFORE the first attempt, so a queued entry
 * carries the time the event happened rather than the time it was
 * eventually written. See `AuditOutbox.occurredAt` in the schema for why
 * that cannot simply be the chain row's `createdAt`.
 */
export async function appendAuditEntryOrQueue(
    input: AppendAuditInput,
    client?: PrismaClient,
): Promise<AuditRecordOutcome> {
    const occurredAt = new Date();

    try {
        const result = await appendAuditEntry(input, client);
        return { recorded: 'chain', auditId: result.id };
    } catch (appendError) {
        // Fall through to the outbox. Deliberately NOT logged as an error
        // here — this path is a successful degradation, and the row it
        // writes is a better record than any log line. The failure is
        // reported on the row itself, in `lastError`.
        try {
            // ALWAYS the global client, NEVER the caller's `client`.
            //
            // `appendAuditEntry` accepts a transaction client, and callers
            // pass one. If the outbox insert joined that transaction, a
            // caller whose transaction later rolls back would take the
            // outbox row down with it — and the entry would be gone with
            // nobody knowing, which is precisely the defect this module
            // exists to remove, reintroduced one layer deeper.
            //
            // The fallback has to outlive the thing it is backing up, so it
            // runs on its own connection by construction rather than by the
            // caller remembering not to pass a tx.
            const db = getPrisma();
            const row = await db.auditOutbox.create({
                data: {
                    tenantId: input.tenantId,
                    action: input.action,
                    occurredAt,
                    // Stored whole: the drain must reproduce the caller's
                    // intent, and a column set would silently drop any
                    // field added to AppendAuditInput later.
                    payloadJson: input as unknown as object,
                    lastError: messageOf(appendError),
                },
                select: { id: true },
            });

            logger.warn('audit: entry queued to outbox after chain write failed', {
                tenantId: input.tenantId,
                action: input.action,
                outboxId: row.id,
                requestId: input.requestId ?? null,
                error: messageOf(appendError),
            });

            return { recorded: 'queued', outboxId: row.id };
        } catch (queueError) {
            // Both failed. The caller MUST learn — this is the branch that
            // makes the mechanism honest, and the one a future edit is
            // most likely to soften back into a warning.
            logger.error('audit: entry reached neither chain nor outbox', {
                tenantId: input.tenantId,
                action: input.action,
                requestId: input.requestId ?? null,
                appendError: messageOf(appendError),
                queueError: messageOf(queueError),
            });
            throw new AuditNotRecordedError(input.action, appendError, queueError);
        }
    }
}
