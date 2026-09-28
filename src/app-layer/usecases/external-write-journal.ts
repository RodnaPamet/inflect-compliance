/**
 * The write seam for `ExternalWriteJournal` (#2861).
 *
 * One place where a row is created and one where it is settled, mirroring
 * `identity-write-journal.ts`. That is not tidiness: the rich-text coverage
 * guardrail derives its inventory from `ENCRYPTED_FIELDS` and requires every
 * encrypted business-content model to have a classified write path, and its
 * `KNOWN_UNCOVERED` ratchet is at ZERO with a cap of zero — so a model whose
 * `detail` column has no sanitising seam cannot be added at all. The guard is
 * asking for this file, and it is right to.
 *
 * ## Why `detail` is sanitised even though nobody types it
 *
 * The identity equivalent sanitises because a revert reason is operator free
 * text. Here `detail` is never operator-authored — it is the FAR END's rejection
 * message. That is a stronger reason rather than a weaker one: it is untrusted
 * text, written by a third party, stored, and later rendered on an operator
 * surface. `sanitizePlainText` is Epic C.5's markup defence and it is applied at
 * the one seam that can write the column.
 *
 * What is deliberately NOT applied is `redactDirectoryIdentifiers`. The identity
 * journal redacts because a directory rejection has a known grammar — it echoes a
 * UPN or a DN, and #2843 finding 22 is the record of that. An arbitrary
 * third-party system has no such grammar to match, so a redactor here would be a
 * pattern list pretending to be a control. The column is encrypted at rest
 * instead, which is a defence that does not depend on guessing the format.
 *
 * ## What this file does NOT do
 *
 * It does not send anything. Creating a row is the record of an attempt; the
 * dispatch that makes the attempt is the next slice. `recordIntent` is the
 * `DRY_RUN` rung's whole behaviour — decide, write down what WOULD change, send
 * nothing — and it is what the ladder's dwell counts as evidence.
 */
import { badRequest } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import { sanitizePlainText } from '@/lib/security/sanitize';

import type { RequestContext } from '../types';

/** Everything a row needs that is known BEFORE the call goes out. */
export interface ExternalWriteAttempt {
    readonly connectionId: string;
    /** Denormalised so the row stays readable after the connection is deleted. */
    readonly connectionName: string;
    readonly endpointUrl: string;
    /** Our qualified `mcp__<connectionId>__<tool>`. */
    readonly toolName: string;
    /** What the SERVER called it — the only name meaningful at the far end. */
    readonly advertisedToolName: string;
    /** The rung this ran under, already coerced by the caller. */
    readonly mode: string;
    /** The post-egress-scan payload — what the far end actually received. */
    readonly argumentsJson: string;
    /**
     * The state this write REPLACES, read from the far end immediately before.
     *
     * REQUIRED, and the column is NOT NULL, because owner decision 2 makes
     * reading prior state a precondition of dispatching and unreadability a
     * refusal rather than a warning. A caller that cannot read it must not reach
     * this function at all — which is why there is no optional overload.
     */
    readonly priorStateJson: string;
    readonly agentId?: string | null;
    readonly runId?: string | null;
}

/** A row that has been written and is awaiting its outcome. */
export interface ExternalWriteHandle {
    readonly journalId: string;
}

/**
 * Record an intent that will NOT be sent — the `DRY_RUN` rung's behaviour.
 *
 * Its own function rather than a flag on `beginWrite`, because the two differ in
 * what they promise. This one is terminal: the row is `RECORDED_ONLY` the moment
 * it exists and nothing will settle it. `beginWrite` opens a row that something
 * is obliged to come back and settle, and a caller that confused them would leave
 * dry-run rows sitting in `PENDING` for ever, where the unsettled sweep would
 * read them as writes that never reported back.
 *
 * These rows are what the ladder's dwell counts as evidence for leaving
 * `DRY_RUN`.
 */
export async function recordIntent(
    ctx: RequestContext,
    attempt: ExternalWriteAttempt,
): Promise<ExternalWriteHandle> {
    if (attempt.mode !== 'DRY_RUN') {
        // A guard rather than a coercion. Recording a terminal RECORDED_ONLY row
        // for a rung that was supposed to DISPATCH would report a change nobody
        // made and settle nothing, and the caller has already decided the rung.
        throw badRequest(`recordIntent is for DRY_RUN; got ${attempt.mode}`);
    }
    const row = await runInTenantContext(ctx, (db) =>
        db.externalWriteJournal.create({
            data: {
                tenantId: ctx.tenantId,
                ...fields(attempt),
                outcome: 'RECORDED_ONLY',
                settledAt: new Date(),
                actorUserId: ctx.userId ?? null,
            },
            select: { id: true },
        }),
    );
    logger.info('external write intent recorded', {
        component: 'external-write-journal',
        tenantId: ctx.tenantId,
        connectionId: attempt.connectionId,
        tool: attempt.toolName,
        mode: attempt.mode,
    });
    return { journalId: row.id };
}

/**
 * Open a row for a write that IS about to be sent.
 *
 * Written BEFORE the call, deliberately. A row created afterwards would be lost
 * exactly when it matters most — a process that dies mid-call leaves no record
 * that anything was attempted, which is the one case an operator needs the
 * journal for.
 */
export async function beginWrite(
    ctx: RequestContext,
    attempt: ExternalWriteAttempt,
): Promise<ExternalWriteHandle> {
    if (attempt.mode === 'DRY_RUN' || attempt.mode === 'DISABLED') {
        // The mode allowlist, stated positively at the seam that sends. The
        // identity ladder's lesson is that a rung must not inherit permission by
        // falling through: if a rung is added later, it is refused here until
        // somebody decides what it means.
        throw badRequest(`beginWrite refuses ${attempt.mode}; nothing is sent at that rung`);
    }
    const row = await runInTenantContext(ctx, (db) =>
        db.externalWriteJournal.create({
            data: {
                tenantId: ctx.tenantId,
                ...fields(attempt),
                outcome: 'PENDING',
                actorUserId: ctx.userId ?? null,
            },
            select: { id: true },
        }),
    );
    return { journalId: row.id };
}

/** What a settled write can have become. `RECORDED_ONLY` is not settleable. */
export type SettledOutcome = 'APPLIED' | 'FAILED' | 'INDETERMINATE';

/**
 * Close a row with what the far end said.
 *
 * `detail` is sanitised HERE, at the one seam that can write it — see the file
 * header for why untrusted third-party text is the stronger case for it, not the
 * weaker one.
 *
 * The three outcomes are not interchangeable and the caller must choose
 * honestly. `FAILED` is a positive claim that the far end changed NOTHING, usable
 * only when it proved that — a 4xx with a body. A lost response is
 * `INDETERMINATE`, because collapsing it into `FAILED` is the lie
 * `IdentityWriteOutcome` documents: an operator filtering on FAILED to decide
 * what needs restoring would never see the captured prior state, and the
 * unsettled sweep would never surface the row either.
 */
export async function settleWrite(
    ctx: RequestContext,
    journalId: string,
    outcome: SettledOutcome,
    detail?: string | null,
): Promise<void> {
    const clean = detail === undefined || detail === null ? null : sanitizePlainText(detail);
    const res = await runInTenantContext(ctx, (db) =>
        db.externalWriteJournal.updateMany({
            // Scoped to a row that is still open, so settling twice cannot
            // rewrite an outcome somebody has already read and acted on.
            where: { id: journalId, tenantId: ctx.tenantId, outcome: 'PENDING' },
            data: { outcome, detail: clean, settledAt: new Date() },
        }),
    );
    if (res.count === 0) {
        // Counted, not assumed. An RLS-filtered or already-settled update
        // reports success with zero rows, so a caller that trusted the call
        // would believe it had recorded an outcome that is not there.
        logger.warn('external write journal: nothing to settle', {
            component: 'external-write-journal',
            tenantId: ctx.tenantId,
            journalId,
            outcome,
        });
        return;
    }
    logger.info('external write settled', {
        component: 'external-write-journal',
        tenantId: ctx.tenantId,
        journalId,
        outcome,
    });
}

/**
 * Read one row back, decrypted.
 *
 * Exists because a journal you cannot read is half a control, and because the
 * encrypted columns can only be decrypted inside a tenant context — the DEK is
 * per-tenant, so a bare client with the extension composed returns null. That is
 * the shape of the mistake worth naming here: `runInTenantContext` is not a
 * formality on this path, it is what makes the plaintext reachable at all.
 *
 * The OWNER-gated surface that renders this is the next slice; this is the seam
 * it will call.
 */
export async function getJournalWrite(ctx: RequestContext, journalId: string) {
    return runInTenantContext(ctx, (db) =>
        db.externalWriteJournal.findFirst({
            where: { id: journalId, tenantId: ctx.tenantId },
        }),
    );
}

/** The columns both creators share, so they cannot drift apart. */
function fields(a: ExternalWriteAttempt) {
    return {
        connectionId: a.connectionId,
        connectionName: a.connectionName,
        endpointUrl: a.endpointUrl,
        toolName: a.toolName,
        advertisedToolName: a.advertisedToolName,
        mode: a.mode,
        argumentsJson: a.argumentsJson,
        priorStateJson: a.priorStateJson,
        agentId: a.agentId ?? null,
        runId: a.runId ?? null,
    };
}
