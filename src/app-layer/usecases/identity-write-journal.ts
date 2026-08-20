/**
 * Recording what a directory write replaced, before it replaces it.
 *
 * ═══ THE ORDERING IS THE WHOLE POINT ═══
 *
 * Disabling an account destroys the evidence of what it was. On-prem AD packs
 * the answer into one `userAccountControl` integer whose other bits —
 * password-never-expires, smartcard-required — are gone the moment it is
 * overwritten. So "undo the offboarding" is answerable only if the answer was
 * written down FIRST.
 *
 * `beginWrite` commits the journal row before the provider is called, and
 * returns a handle whose only methods settle it. A caller therefore cannot
 * perform a write without having captured, because the thing it needs in order
 * to report the outcome does not exist until the capture is committed. That is
 * deliberate: a convention saying "remember to capture first" is a convention
 * somebody eventually forgets on the unhappy path.
 *
 * ═══ PENDING IS A REAL ANSWER ═══
 *
 * A crash between the capture and the settle leaves the row PENDING, which
 * honestly means "we may or may not have changed the directory — go and look".
 * Any scheme that recorded the outcome only afterwards would lose exactly that
 * case, and it is the one case a human must investigate. `listUnsettledWrites`
 * exists so those rows are findable rather than merely present.
 *
 * @module usecases/identity-write-journal
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { sanitizePlainText } from '@/lib/security/sanitize';
import type { IdentityWriteMode } from './identity-write-policy';

export type IdentityWriteAction =
    | 'DISABLE_ACCOUNT'
    | 'ENABLE_ACCOUNT'
    | 'CREATE_ACCOUNT'
    | 'ASSIGN_GROUP'
    | 'REMOVE_GROUP';

export interface BeginWriteInput {
    /** The link this write acts through, when there is one. */
    readonly linkId?: string | null;
    readonly provider: string;
    readonly externalUserId: string;
    readonly action: IdentityWriteAction;
    readonly mode: IdentityWriteMode;
    /**
     * The provider-shaped state about to be replaced.
     *
     * REQUIRED, and rejected when empty. An empty capture is indistinguishable
     * from "there was nothing to capture", and the difference is the whole
     * value of the row — a restore reading `{}` cannot tell that it is missing
     * the answer rather than looking at an account that had no prior state.
     */
    readonly priorState: Record<string, unknown>;
}

/** Returned by `beginWrite`. Holding one is proof the capture is committed. */
export interface WriteHandle {
    readonly journalId: string;
    /** The provider accepted the change. */
    applied(detail?: string): Promise<void>;
    /** The provider refused, or the call failed. The directory is unchanged. */
    failed(detail: string): Promise<void>;
    /** A previously applied change has been undone from the captured state. */
    reverted(detail: string): Promise<void>;
    /**
     * The call did not report back — we do not know whether the directory
     * changed.
     *
     * Distinct from `failed`, which positively asserts it did NOT. Rows settled
     * here stay in `listUnsettledWrites` because a human still has to look, and
     * remain visible to `findRestorableState` because the captured prior state
     * may be the only surviving copy.
     */
    indeterminate(detail: string): Promise<void>;
}

/**
 * Capture the prior state and commit it, returning the handle used to settle.
 *
 * Call this BEFORE touching the provider. There is no variant that captures
 * afterwards, on purpose.
 */
export async function beginWrite(ctx: RequestContext, input: BeginWriteInput): Promise<WriteHandle> {
    if (!input.priorState || Object.keys(input.priorState).length === 0) {
        throw badRequest(
            'Refusing to record a directory write with an empty prior state. An empty capture cannot be told ' +
                'apart from "nothing to capture", and a restore reading it has no way to know the answer is ' +
                'missing rather than absent.',
        );
    }
    if (!input.externalUserId.trim()) {
        throw badRequest('Refusing to record a directory write with no target account id');
    }

    const row = await runInTenantContext(ctx, (db) =>
        db.identityWriteJournal.create({
            data: {
                tenantId: ctx.tenantId,
                linkId: input.linkId ?? null,
                provider: input.provider,
                externalUserId: input.externalUserId,
                action: input.action,
                mode: input.mode,
                priorStateJson: input.priorState as object,
                outcome: 'PENDING',
                actorUserId: ctx.userId ?? null,
            },
            select: { id: true },
        }),
    );

    const settle = async (
        outcome: 'APPLIED' | 'FAILED' | 'REVERTED' | 'INDETERMINATE',
        detail?: string,
    ): Promise<void> => {
        // `detail` is not always machine-generated. A provider rejection is,
        // but a REVERTED reason is written by a person, and this row is read
        // back by an operator surface and an auditor export. Sanitised at the
        // WRITE path, per Epic C.5 — render-time escaping alone would leave the
        // stored row dangerous to the PDF export and any SDK consumer reading
        // it verbatim.
        const safeDetail = detail === undefined ? null : sanitizePlainText(detail);
        // Predicated on PENDING so a settle cannot overwrite an outcome another
        // actor already recorded, and a double-settle is a no-op rather than a
        // rewrite of history in an append-only journal.
        const moved = await runInTenantContext(ctx, (db) =>
            db.identityWriteJournal.updateMany({
                where: { id: row.id, tenantId: ctx.tenantId, outcome: 'PENDING' },
                data: { outcome, detail: safeDetail, settledAt: new Date() },
            }),
        );
        if (moved.count === 0) {
            logger.warn('identity write journal already settled', {
                component: 'identity-write-journal',
                tenantId: ctx.tenantId,
                journalId: row.id,
                attemptedOutcome: outcome,
            });
        }
    };

    return {
        journalId: row.id,
        applied: (detail) => settle('APPLIED', detail),
        failed: (detail) => settle('FAILED', detail),
        reverted: (detail) => settle('REVERTED', detail),
        indeterminate: (detail) => settle('INDETERMINATE', detail),
    };
}

/**
 * The most recent APPLIED write against an account — what a restore reads.
 *
 * Scoped by (provider, externalUserId) rather than by link, so it still answers
 * after the link or the employee row is gone. That is the case where somebody
 * is most likely to be asking.
 */
export async function findRestorableState(
    ctx: RequestContext,
    provider: string,
    externalUserId: string,
): Promise<{
    journalId: string;
    priorState: Record<string, unknown>;
    attemptedAt: Date;
    /** APPLIED = the write is known to have landed. INDETERMINATE = it may have. */
    outcome: 'APPLIED' | 'INDETERMINATE';
} | null> {
    return runInTenantContext(ctx, async (db) => {
        const row = await db.identityWriteJournal.findFirst({
            // INDETERMINATE is included deliberately. Its capture may be the
            // ONLY surviving copy of the prior state, and excluding it would
            // make a real, committed capture unreachable for exactly the writes
            // whose result nobody could confirm. The outcome is returned so a
            // restore can warn rather than silently assume.
            where: {
                tenantId: ctx.tenantId,
                provider,
                externalUserId,
                outcome: { in: ['APPLIED', 'INDETERMINATE'] },
            },
            orderBy: { attemptedAt: 'desc' },
            select: { id: true, priorStateJson: true, attemptedAt: true, outcome: true },
        });
        if (!row) return null;
        return {
            journalId: row.id,
            priorState: row.priorStateJson as Record<string, unknown>,
            attemptedAt: row.attemptedAt,
            outcome: row.outcome as 'APPLIED' | 'INDETERMINATE',
        };
    });
}

/** Bound on one page of unsettled rows. */
const MAX_UNSETTLED = 200;

/**
 * Writes that never reported an outcome.
 *
 * These are the rows that need a human: the directory may or may not have been
 * changed. Surfacing them is the difference between a recoverable gap and a
 * silent one.
 */
export async function listUnsettledWrites(ctx: RequestContext, olderThan: Date) {
    return runInTenantContext(ctx, (db) =>
        db.identityWriteJournal.findMany({
            // Both unsettled states: PENDING (we crashed before reporting) and
            // INDETERMINATE (the call never reported back). They mean the same
            // thing to a human — go and look at the directory.
            where: {
                tenantId: ctx.tenantId,
                outcome: { in: ['PENDING', 'INDETERMINATE'] },
                attemptedAt: { lt: olderThan },
            },
            orderBy: { attemptedAt: 'asc' },
            take: MAX_UNSETTLED,
            select: {
                id: true, provider: true, externalUserId: true, action: true,
                mode: true, attemptedAt: true, linkId: true, outcome: true, detail: true,
            },
        }),
    );
}


/**
 * Resolve an earlier unconfirmed write, now that the directory has been read
 * and agrees with it.
 *
 * Only ever promotes INDETERMINATE (or a stranded PENDING) to APPLIED, and only
 * when the caller has just OBSERVED the intended end state. That observation is
 * the evidence the original call never got.
 *
 * Returns the journal id it settled, or null if there was nothing outstanding —
 * so an ordinary already-disabled account stays an ordinary no-op.
 */
export async function settleIndeterminateAsApplied(
    ctx: RequestContext,
    provider: string,
    externalUserId: string,
): Promise<string | null> {
    return runInTenantContext(ctx, async (db) => {
        const row = await db.identityWriteJournal.findFirst({
            where: {
                tenantId: ctx.tenantId,
                provider,
                externalUserId,
                outcome: { in: ['INDETERMINATE', 'PENDING'] },
            },
            orderBy: { attemptedAt: 'desc' },
            select: { id: true },
        });
        if (!row) return null;

        // Predicated on the unsettled states so this cannot rewrite a row some
        // other actor has already resolved.
        const moved = await db.identityWriteJournal.updateMany({
            where: {
                id: row.id,
                tenantId: ctx.tenantId,
                outcome: { in: ['INDETERMINATE', 'PENDING'] },
            },
            data: {
                outcome: 'APPLIED',
                settledAt: new Date(),
                detail: 'Reconciled: a later read observed the account disabled, so the earlier write landed.',
            },
        });
        if (moved.count === 0) return null;

        logger.info('reconciled an unconfirmed identity write', {
            component: 'identity-write-journal',
            tenantId: ctx.tenantId,
            provider,
            journalId: row.id,
        });
        return row.id;
    });
}
