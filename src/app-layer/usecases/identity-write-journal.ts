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
        outcome: 'APPLIED' | 'FAILED' | 'REVERTED',
        detail?: string,
    ): Promise<void> => {
        // Predicated on PENDING so a settle cannot overwrite an outcome another
        // actor already recorded, and a double-settle is a no-op rather than a
        // rewrite of history in an append-only journal.
        const moved = await runInTenantContext(ctx, (db) =>
            db.identityWriteJournal.updateMany({
                where: { id: row.id, tenantId: ctx.tenantId, outcome: 'PENDING' },
                data: { outcome, detail: detail ?? null, settledAt: new Date() },
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
): Promise<{ journalId: string; priorState: Record<string, unknown>; attemptedAt: Date } | null> {
    return runInTenantContext(ctx, async (db) => {
        const row = await db.identityWriteJournal.findFirst({
            where: { tenantId: ctx.tenantId, provider, externalUserId, outcome: 'APPLIED' },
            orderBy: { attemptedAt: 'desc' },
            select: { id: true, priorStateJson: true, attemptedAt: true },
        });
        if (!row) return null;
        return {
            journalId: row.id,
            priorState: row.priorStateJson as Record<string, unknown>,
            attemptedAt: row.attemptedAt,
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
            where: { tenantId: ctx.tenantId, outcome: 'PENDING', attemptedAt: { lt: olderThan } },
            orderBy: { attemptedAt: 'asc' },
            take: MAX_UNSETTLED,
            select: {
                id: true, provider: true, externalUserId: true, action: true,
                mode: true, attemptedAt: true, linkId: true,
            },
        }),
    );
}
