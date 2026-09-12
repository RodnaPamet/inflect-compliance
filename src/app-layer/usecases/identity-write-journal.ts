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
import { recordIdentityWritesUnsettled } from '@/lib/observability/integration-metrics';
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
 * ═══ THE READ HALF ═══
 *
 * Everything above this line WRITES the journal. What follows lets a human read
 * one back, and it exists because the product was already telling them to.
 *
 * The DISABLED notification this subsystem sends says, in as many words: "held
 * against journal reference <id> … quote that reference to your platform
 * administrator, who can read the captured state and re-apply it". Neither half
 * of that sentence was true. `findRestorableState` had no caller anywhere in
 * `src/`, there was no route and no page, and the id in the mail resolved to
 * nothing an operator could open. An instruction that cannot be followed is
 * worse than no instruction: it sends somebody looking for a screen that does
 * not exist at the exact moment they are trying to undo a disable, and the whole
 * point of capturing first is that that moment is survivable.
 *
 * This is the READ half only. Re-applying the captured state is a WRITE back
 * into a customer's directory — `DirectoryWriter` declares no `enable()` verb,
 * deliberately — and that is a separate decision from letting an authorised
 * human SEE what was replaced.
 *
 * ─── Why two shapes and not one ───
 *
 * `listJournalWrites` is an INDEX: enough to find the row, and nothing more.
 * `getJournalWrite` is the ANSWER: the captured state itself.
 *
 * That split is not tidiness. The index is a page of up to a hundred rows about
 * named people's access changes, and nobody scanning it needs the prior state of
 * all hundred; fetching it anyway would put a hundred directory captures on the
 * wire to answer "which row was it?". The captured state is reached by asking
 * for ONE row, by id — which is the shape the mail already hands out.
 */

/** Bound on one page of the journal index. */
const MAX_JOURNAL_PAGE = 100;

/** Every outcome a journalled write can settle at. Mirrors the Prisma enum. */
export type IdentityWriteOutcome =
    | 'PENDING'
    | 'APPLIED'
    | 'FAILED'
    | 'INDETERMINATE'
    | 'REVERTED';

/**
 * One row as it appears in the index.
 *
 * `externalUserId` is NOT here, and that is the same refusal `listUnsettledWrites`
 * makes further down this file: this subsystem does not hand the raw directory
 * identifier out of the module, because every surface that has ever received one
 * eventually persisted it somewhere unencrypted. `linkId` is the handle that
 * does the same job safely — opaque, tenant-scoped, and resolvable to a person
 * only through an authorised read of the roster.
 *
 * `detail` is NOT here either. See `getJournalWrite`, which is where it lives
 * and where the reasoning for that belongs.
 */
export interface JournalIndexEntry {
    readonly journalId: string;
    readonly linkId: string | null;
    readonly provider: string;
    readonly action: IdentityWriteAction;
    readonly mode: IdentityWriteMode;
    readonly outcome: IdentityWriteOutcome;
    readonly attemptedAt: Date;
    readonly settledAt: Date | null;
    /** Null for a scheduled pass with no human behind it. */
    readonly actorUserId: string | null;
}

/** The index entry plus the two fields that make it an answer. */
export interface JournalWriteDetail extends JournalIndexEntry {
    /**
     * The provider-shaped state the write replaced. THE POINT OF THE WHOLE
     * SUBSYSTEM: it is what a restore reads, and for an on-prem account it is
     * the only surviving copy of a `userAccountControl` integer whose other bits
     * — password-never-expires, smartcard-required — were destroyed the instant
     * the disable landed.
     */
    readonly priorState: Record<string, unknown>;
    /** Why a FAILED write failed, or why a REVERTED one was undone. */
    readonly detail: string | null;
}

/** The columns both readers select. The two detail-only columns are added at
 *  the one call site that takes them, so the narrow shape is the default and
 *  the wide one is the exception a reader can see. */
const JOURNAL_INDEX_SELECT = {
    id: true,
    linkId: true,
    provider: true,
    action: true,
    mode: true,
    outcome: true,
    attemptedAt: true,
    settledAt: true,
    actorUserId: true,
} as const;

/**
 * Shape a Prisma row into the index entry.
 *
 * One function rather than two inline object literals, so the index and the
 * by-id read cannot drift into two different accounts of the same row — the
 * failure that would show up as a field present on one surface and quietly
 * missing on the other.
 */
function toIndexEntry(row: {
    id: string;
    linkId: string | null;
    provider: string;
    action: string;
    mode: string;
    outcome: string;
    attemptedAt: Date;
    settledAt: Date | null;
    actorUserId: string | null;
}): JournalIndexEntry {
    return {
        journalId: row.id,
        linkId: row.linkId,
        provider: row.provider,
        action: row.action as IdentityWriteAction,
        mode: row.mode as IdentityWriteMode,
        outcome: row.outcome as IdentityWriteOutcome,
        attemptedAt: row.attemptedAt,
        settledAt: row.settledAt,
        actorUserId: row.actorUserId,
    };
}

/**
 * One journal row by its id — what the reference in the DISABLED mail resolves
 * to.
 *
 * Returns null rather than throwing for a row that is not there, so the caller
 * answers "no such reference in this tenant" without leaking, through the shape
 * of the failure, whether the id exists in somebody else's. The read runs inside
 * `runInTenantContext`, so RLS is what actually enforces that; the null is about
 * not undoing it at the edge.
 *
 * ═══ WHY `detail` IS RETURNED HERE, AND NOWHERE ELSE ═══
 *
 * `IdentityWriteJournal.detail` is on the Epic B encryption manifest. That entry
 * is right about what the column holds — free text about a NAMED person's access
 * change, and provider rejections routinely echo the UPN back — so the question
 * is a real one and the answer is not automatic.
 *
 * It is returned, for three reasons.
 *
 * THE MANIFEST GOVERNS REST, NOT AUDIENCE. Its job is that a stolen database
 * file, a leaked backup or a replica read yields no plaintext; it makes no claim
 * about who may read the value through an authorised, tenant-scoped request. The
 * codebase already settles this the same way one entry over:
 * `ConnectedIdentityAccount.protectionReason` sits on the manifest immediately
 * below this one, holds the same shape of free text about the same people, and
 * is selected by the identity-accounts roster read and rendered on that page —
 * at `admin.manage`. This route is gated a full tier above that, at OWNER.
 *
 * WITHHOLDING IT WOULD DEFEAT THE LOOKUP. The operator arriving here has been
 * told to read the captured state and decide whether to re-apply it. For an
 * APPLIED row the prior state is the whole answer — but for a FAILED or
 * INDETERMINATE row, `detail` IS the answer: it is the provider's own account of
 * what happened, and without it an INDETERMINATE row says "we do not know
 * whether your directory changed" and offers not one clue toward finding out.
 * That is precisely the row a human was summoned for.
 *
 * AND THE ALTERNATIVE IS WORSE THAN IT LOOKS. An operator denied the reason
 * in-product does not stop needing it — they open the provider's own admin
 * centre and read the same message there, with none of this tenant's permission
 * model in front of it and no audit row behind it. Withholding a field does not
 * un-reveal the fact; it relocates the read somewhere we cannot see.
 *
 * The narrower reads keep the narrower shape. `listUnsettledWrites` and
 * `listJournalWrites` both leave `detail` unselected: a nightly sweep and an
 * index would decrypt it once per row for a value no caller reads, which costs a
 * decrypt per row per night and would warn per row for ever on a key problem.
 * One row, fetched deliberately, by an OWNER who was handed the id, is a
 * different transaction from a hundred rows nobody asked about.
 */
export async function getJournalWrite(
    ctx: RequestContext,
    journalId: string,
): Promise<JournalWriteDetail | null> {
    const id = journalId.trim();
    // An empty id is not a lookup, and `findFirst` with `id: ''` would happily
    // return the tenant's newest row on some future edit that drops the
    // predicate. Refusing here means the miss is explicit rather than lucky.
    if (!id) return null;

    const row = await runInTenantContext(ctx, (db) =>
        db.identityWriteJournal.findFirst({
            // `tenantId` is stated as well as relied upon. RLS is the enforcing
            // layer; this predicate is the one that still holds if the same
            // query is ever run from a context where it is not.
            where: { id, tenantId: ctx.tenantId },
            select: { ...JOURNAL_INDEX_SELECT, priorStateJson: true, detail: true },
        }),
    );
    if (!row) return null;

    return {
        ...toIndexEntry(row),
        priorState: row.priorStateJson as Record<string, unknown>,
        detail: row.detail,
    };
}

/**
 * A page of the journal, most recent first — the index an operator browses when
 * the reference is not to hand.
 *
 * Bounded at `MAX_JOURNAL_PAGE` and CLAMPED to it, so a caller passing
 * `?limit=100000` receives a hundred rows rather than the tenant's entire write
 * history: the ceiling belongs to the function, not to the request. Ordered
 * `attemptedAt` desc, which the `(tenantId, attemptedAt)` index on the model
 * serves directly.
 *
 * `provider` is an optional filter rather than a required argument: a tenant may
 * write to more than one directory, and the answer to "what have we done to this
 * person" spans all of them.
 */
export async function listJournalWrites(
    ctx: RequestContext,
    options: { limit?: number; provider?: string } = {},
): Promise<JournalIndexEntry[]> {
    const take = Math.min(Math.max(1, options.limit ?? MAX_JOURNAL_PAGE), MAX_JOURNAL_PAGE);
    const rows = await runInTenantContext(ctx, (db) =>
        db.identityWriteJournal.findMany({
            where: {
                tenantId: ctx.tenantId,
                ...(options.provider ? { provider: options.provider } : {}),
            },
            orderBy: { attemptedAt: 'desc' },
            take,
            // NARROW, for the reasons written out on `JournalIndexEntry` and on
            // `getJournalWrite`: no `externalUserId` (a directory identifier
            // this subsystem does not hand out), no `detail` (manifest-encrypted
            // free text nobody reads from an index), no `priorStateJson` (the
            // answer, fetched one row at a time on purpose).
            select: JOURNAL_INDEX_SELECT,
        }),
    );
    return rows.map(toIndexEntry);
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
export async function listUnsettledWrites(
    ctx: RequestContext,
    olderThan: Date,
    provider?: string,
) {
    const rows = await runInTenantContext(ctx, (db) =>
        db.identityWriteJournal.findMany({
            // Both unsettled states: PENDING (we crashed before reporting) and
            // INDETERMINATE (the call never reported back). They mean the same
            // thing to a human — go and look at the directory.
            where: {
                tenantId: ctx.tenantId,
                // Optional, and the caller passes it. The leaver dispatcher fans
                // out one job per (tenant, provider) over WRITABLE_IDENTITY_PROVIDERS,
                // and this counter's only label is `tenant_id` — so an unscoped
                // read would add the tenant's whole backlog once per provider,
                // under one series, and the number would silently double.
                ...(provider ? { provider } : {}),
                outcome: { in: ['PENDING', 'INDETERMINATE'] },
                attemptedAt: { lt: olderThan },
            },
            orderBy: { attemptedAt: 'asc' },
            take: MAX_UNSETTLED,
            // NARROW ON PURPOSE. Two columns are deliberately absent:
            //
            //   `detail` is on the Epic-B encryption manifest, and that entry
            //   says why — free text about a NAMED person's access change, and
            //   provider errors routinely echo the UPN. Selecting it decrypts
            //   once per stranded row per night for a value no caller reads,
            //   and a decrypt failure would warn per row for ever.
            //
            //   `externalUserId` is a directory identifier, which this
            //   subsystem refuses to put in a durable record — and the caller
            //   persists what it learns into `IntegrationExecution.resultJson`,
            //   which is NOT encrypted at rest. One `...row` spread by a future
            //   caller would be enough. Leaving the column unselected makes
            //   that structural rather than a matter of caller discipline.
            //
            // `linkId` is the safe handle: opaque, tenant-scoped, and enough to
            // find the row by hand.
            select: {
                id: true, provider: true, action: true,
                mode: true, attemptedAt: true, linkId: true, outcome: true,
            },
        }),
    );

    // Counted HERE rather than by a separate sweep, so the number cannot drift
    // from what an operator is actually shown. This function existed with no
    // caller at all, which left the capture-before-write rail invisible in
    // production — and a rail nobody can see is one nobody acts on.
    //
    // Emitted even when zero: a counter that only appears during an incident is
    // indistinguishable from a counter that stopped being emitted.
    recordIdentityWritesUnsettled({ tenantId: ctx.tenantId, count: rows.length });
    return rows;
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
