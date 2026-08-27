/**
 * Disabling one directory account — the write, and every refusal in front of it.
 *
 * ═══ WHAT THIS ORCHESTRATES ═══
 *
 * Five rails already exist, each answering a different question, and this is
 * the first thing that asks all of them:
 *
 *   ladder        may we write at all, and in which mode?   (identity-write-policy)
 *   write-target  can the write LAND here, or will Azure AD
 *                 Connect revert it?                        (identity-write-target)
 *   link          which account belongs to this worker?     (IdentityAccountLink)
 *   journal       what are we about to destroy?             (identity-write-journal)
 *   breaker       is this batch's size plausible?           (identity-write-breaker)
 *
 * The breaker is the caller's gate rather than this function's: it reasons about
 * a BATCH, and by the time you are inside a per-account call the batch decision
 * has already been made. `disableAccountsForLeaver` below is where both meet.
 *
 * ═══ THE WRITER IS INJECTED, ALWAYS ═══
 *
 * Every path here takes a `DirectoryWriter`. There is no module-level default
 * that reaches a real directory, so a test cannot accidentally acquire one by
 * forgetting to pass a fake — the type system asks for it every time.
 *
 * @module usecases/identity-disable-account
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { redactDirectoryIdentifiers } from '@/lib/security/redact-directory-identifiers';
import { badRequest } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import {
    resolveWriteTarget,
    type WriteTarget,
    type WriteTargetBasis,
} from './identity-write-target';
import { beginWrite } from './identity-write-journal';
import { getIdentityWritePolicy, type IdentityWriteMode } from './identity-write-policy';
import { checkDisableBlastRadius } from './identity-write-breaker';
import {
    recordIdentityBatchRefused,
    recordIdentityWriteOutcome,
    recordIdentityWritesUnsettled,
} from '@/lib/observability/integration-metrics';
import { settleIndeterminateAsApplied } from './identity-write-journal';
import {
    buildLeaverAudienceBook,
    notifyLeaverOutcome,
    type LeaverAudienceBook,
} from '../notifications/leaver';

/**
 * Why a disable did not happen, or how it did.
 *
 * `REFUSED_*` outcomes are decisions, not errors: nothing was attempted and
 * nothing is wrong with the system. They are distinguished from each other
 * because an operator's next action differs for each.
 */
export type DisableOutcome =
    | 'DISABLED'
    /** The mode is DISABLED, or below the rung that permits a real write. */
    | 'REFUSED_MODE'
    /**
     * The write cannot LAND here. Three situations with different responses —
     * mastered on-prem, not yet observed, or a provider that cannot observe —
     * and `DisableResult.basis.rule` is what says which. The counter cannot: an
     * operator reading REFUSED_TARGET alone learns nothing about what to do.
     */
    | 'REFUSED_TARGET'
    /**
     * The account is the one this connection authenticates AS, or is otherwise
     * protected. Refused before anything else, and never overridable.
     */
    | 'REFUSED_PROTECTED'
    /** Already disabled in the directory — nothing to do. */
    | 'ALREADY_DISABLED'
    /** DRY_RUN: everything was decided, nothing was written. */
    | 'DRY_RUN'
    /** The provider rejected the write BEFORE changing anything. */
    | 'FAILED'
    /**
     * The call did not report back. We do not know whether the directory
     * changed, and saying either "done" or "failed" would be a guess with
     * teeth — see DirectoryWriteError.
     */
    | 'INDETERMINATE';

/**
 * WHY the decision went the way it did, from facts already in hand.
 *
 * The seven-day DRY_RUN window exists so an operator can read what the product
 * WOULD have done and decide whether to grant it unattended authority over a
 * customer's directory. `outcome` alone does not support that decision: "would
 * disable" is the same two words whether the directory answered that the
 * account is cloud-only or whether a rail was widened underneath the reader.
 * #2144 widened one — a whole population moved from REFUSED_TARGET to
 * would-disable — and nothing in the report said which rows rested on it.
 *
 * Every field is READ, never re-derived from a fresh lookup. `rule` is the
 * verdict `resolveWriteTarget` already returned; the other two are the account
 * row's own columns, already selected by `findLeaverCandidates` for the rail.
 * There is no query here and there must not be one: a report costing a read per
 * decision is a report somebody turns off.
 *
 * SAFE TO PERSIST VERBATIM, and that is a property to keep rather than a
 * coincidence. `IntegrationExecution.resultJson` is not encrypted at rest and
 * outlives the pass, so every free-text field this module records is scrubbed
 * of directory identifiers on the way in. A basis is an enum, a tri-state
 * boolean and a timestamp — it can name no account. Do not add a field here
 * that can.
 *
 * A `type`, NOT an `interface`, and the difference is load-bearing rather than
 * stylistic. This value is written straight into `IntegrationExecution.resultJson`,
 * whose Prisma parameter is `InputJsonValue` — an assignability check that needs
 * an index signature. TypeScript synthesises one for an object TYPE ALIAS and
 * refuses to for an interface, because an interface stays open to declaration
 * merging and so cannot be proven to hold only JSON. Written as an interface
 * this compiles everywhere except the one line that persists it, and every unit
 * test still passes, because Jest does not typecheck. It was written as an
 * interface first; `tsc` is what caught it.
 */
export type DecisionBasis = {
    /** Which write-target rule decided. */
    readonly rule: WriteTargetBasis;
    /**
     * The stored on-prem sync flag, verbatim.
     *
     * `null` carries BOTH "the directory answered: not synced" and "nobody
     * asked" — `observedAt` is what separates them, which is the whole reason
     * the pair travels together rather than as one collapsed word.
     */
    readonly onPremisesSyncEnabled: boolean | null;
    /** ISO timestamp of the sync that ANSWERED. Absent = none ever did. */
    readonly observedAt?: string;
};

export interface DisableResult {
    readonly outcome: DisableOutcome;
    readonly reason?: string;
    readonly journalId?: string;
    /**
     * Present on every outcome the write-target rail participated in, absent on
     * the refusals decided before it (self-lockout, protected, mode).
     *
     * Optional rather than always-present because those earlier refusals make
     * no write-target determination at all, and stamping one on them would be a
     * claim about a rule that never ran.
     */
    readonly basis?: DecisionBasis;
}

/**
 * A decision with the candidate it was made about.
 *
 * `decideAndDisable` returns a bare `DisableResult` from a dozen places and has
 * no reason to know which link it came from. The batch does, so the pairing is
 * made HERE, where both are in scope — rather than left to positional alignment
 * between two arrays, which is correct until somebody filters one of them.
 *
 * The link id is the only identifier that leaves this module for a durable
 * record: it is tenant-scoped, opaque, and resolvable to a person only through
 * an authorised read.
 */
export type LeaverDisableResult = DisableResult & { readonly linkId: string };

/** The state a provider hands back before a write, and needs to perform one. */
export interface DirectoryAccountState {
    /** False when the account is already disabled. */
    readonly enabled: boolean;
    /**
     * Provider-shaped state to capture. For AD this MUST carry the whole
     * `userAccountControl` integer, not just the disable bit: the other bits
     * are what a restore cannot reconstruct.
     */
    readonly priorState: Record<string, unknown>;
}

/**
 * The provider-side write surface. Deliberately tiny — every decision that can
 * be made without touching the network is made above this line.
 */
export interface DirectoryWriter {
    readonly provider: string;
    /**
     * Every identity this connection authenticates AS, in every form the writer
     * can name WITHOUT a network call. Empty for a credential that is not a user
     * — an Entra app registration is not, and never will be.
     *
     * A LIST, and both halves of that matter.
     *
     * SEVERAL IDENTITIES. A connection may hold a dedicated write bind AND a
     * read bind. Only the write bind authenticates this writer, but disabling
     * the READ bind stops the nightly sync, links go stale, and every later
     * leaver pass refuses NO_FRESH_LINKS — offboarding stops, quietly, for
     * everyone. Both must be off limits.
     *
     * SEVERAL FORMS. It was a single string compared by equality against
     * `externalUserId`, and for Active Directory those are drawn from different
     * namespaces: `externalUserId` is `formatObjectGuid(entry.objectGUID)`, a
     * GUID, while the bind is a DN or a userPrincipalName. A GUID never equals a
     * DN, so the refusal could not fire — in AUTOMATIC and PROPOSE as much as in
     * the dry run. The writer's own `findAccount` dispatches on exactly this
     * distinction (`GUID_PATTERN.test(id)` → search by objectGUID, else treat as
     * a DN); the self-check did not.
     *
     * Declared by the writer because only the writer knows them, and read by the
     * orchestrator because only the orchestrator decides. See the self-lockout
     * refusal in `disableAccount`.
     */
    readonly selfAccountIds?: readonly string[];
    /** Read the current state. Called before the write, for the capture. */
    readState(externalUserId: string): Promise<DirectoryAccountState>;
    /** Perform the disable. Resolves on success, throws on refusal. */
    disable(externalUserId: string, prior: DirectoryAccountState): Promise<void>;
}

/**
 * A provider's refusal, carrying the one thing the orchestrator cannot infer.
 *
 * `definitivelyNotApplied` may be true ONLY when the provider proved it
 * evaluated and rejected the request before mutating anything — an HTTP 400 /
 * 401 / 403 / 404 with a response body, an LDAP result code. It must be false
 * for every lost response: ETIMEDOUT, ECONNRESET, EPIPE, an abort, a 408, any
 * 5xx, and anything unrecognised.
 *
 * The default is false, and that direction is deliberate. A writer has to opt
 * IN to claiming the directory is unchanged, because that claim is what makes
 * a FAILED row safe to trust — and an untrue one hides the write from the
 * restore path and the operator sweep simultaneously.
 */
export class DirectoryWriteError extends Error {
    readonly definitivelyNotApplied: boolean;
    constructor(message: string, opts: { definitivelyNotApplied?: boolean } = {}) {
        super(message);
        this.name = 'DirectoryWriteError';
        this.definitivelyNotApplied = opts.definitivelyNotApplied ?? false;
    }
}

/** True only for an error that PROVED nothing was mutated. */
function provenNotApplied(err: unknown): boolean {
    return err instanceof DirectoryWriteError && err.definitivelyNotApplied;
}

export interface DisableAccountInput {
    readonly linkId: string;
    readonly externalUserId: string;
    /**
     * The account's mail / userPrincipalName, when the directory reported one.
     *
     * Carried for ONE reason: the self-lockout refusal. A bind is configured as
     * a DN or a UPN, while `externalUserId` for Active Directory is an
     * objectGUID — so comparing the two can never match. The UPN is the form the
     * two namespaces actually meet in, and the sync already stores it on the
     * account row one select-field away.
     */
    readonly email?: string | null;
    readonly onPremisesSyncEnabled: boolean | null;
    /**
     * When a sync last ANSWERED the field above. `null` / absent = never.
     *
     * The TIMESTAMP, where the rail takes a boolean, and ONE field rather than
     * both. The rail needs only whether an observation exists and gets exactly
     * that, from a `Boolean(...)` at its single call site below — so an absent
     * key still reads as NOT observed and the rail still fails closed. The
     * REPORT needs when: "would disable — cloud-only, observed on the 3rd" and
     * an unqualified "would disable" are different claims to the operator being
     * asked to grant this thing unattended authority.
     *
     * Carrying the boolean here as well would be two representations of one
     * fact that a later edit can set independently — the shape #2144's own
     * review had to unpick when `onPremSyncObserved` and `onPremStateObserved`
     * turned out to be one concept under two names.
     */
    readonly onPremStateObservedAt?: Date | null;
    /**
     * Break-glass / service account, excluded from automated offboarding.
     *
     * Carried on the INPUT rather than looked up here so the decision is made
     * where the population is assembled and is visible in a dry run, instead of
     * being a hidden query inside the write path.
     */
    readonly isProtected?: boolean;
}

/**
 * Disable one account, refusing wherever a rail says to.
 *
 * The order matters and is cheapest-first: every check that can refuse without
 * a network call runs before the one that needs one. A tenant in DISABLED mode
 * must not generate directory traffic to discover that it is in DISABLED mode.
 *
 * The write-target check is the one deliberate exception, and it is an
 * exception about the RETURN, not about the decision. It is still decided for
 * free, in its own position; only its refusal waits for the account to be read.
 * A refusal that never asks the directory cannot notice the directory being
 * fixed either, and that is what made the mail it produces unclearable — see
 * section 2.
 */
/**
 * A provider message, with the account taken out of it, for a LOG field.
 *
 * Redacting the `externalUserId` KEY is not enough on its own and the gap is
 * the dangerous kind. Four of these sites also log `error: <provider message>`,
 * and the provider messages embed the identifier in their prose — "Entra
 * refused to disable account <guid>", "Refusing to disable CN=…". A key-only
 * fix leaves the id in the field beside the redacted one while making the line
 * LOOK sanitised, which is worse than the open gap, because nobody looks twice
 * at a line that already says [Redacted].
 *
 * The RETURNED `reason` is deliberately NOT scrubbed. It reaches an operator
 * through a surface that is tenant-scoped and access-controlled, and naming the
 * account is the whole use of it there. A log line has neither property.
 */
function scrubbed(detail: string, externalUserId: string): string {
    return redactDirectoryIdentifiers(detail, externalUserId);
}

/** Case- and whitespace-insensitive identity comparison for directory ids. */
function sameAccount(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Is this candidate one of the accounts the connection authenticates as?
 *
 * Every identity the orchestrator holds for the candidate, against every
 * identity the writer names for itself. Both sides are lists because both sides
 * are genuinely plural: a connection may hold a write bind and a read bind, and
 * an account is known by an objectGUID, a DN and a userPrincipalName depending
 * on who is doing the naming.
 *
 * Blank strings are dropped rather than compared. An account with no email and a
 * connection with no configured bind would otherwise match each other on `''`
 * and refuse every candidate in the tenant.
 */
function matchesSelf(input: DisableAccountInput, selfIds: readonly string[] | undefined): boolean {
    if (!selfIds || selfIds.length === 0) return false;
    const candidateIds = [input.externalUserId, input.email].filter(
        (v): v is string => typeof v === 'string' && v.trim() !== '',
    );
    return selfIds.some(
        (self) => self.trim() !== '' && candidateIds.some((candidate) => sameAccount(candidate, self)),
    );
}

export async function disableAccount(
    ctx: RequestContext,
    writer: DirectoryWriter,
    input: DisableAccountInput,
): Promise<DisableResult> {
    const result = await decideAndDisable(ctx, writer, input);
    // ONE choke point for the counter, so a future early return cannot ship
    // without being counted. Every refusal is recorded distinctly — collapsing
    // them would hide the difference between a tenant still climbing the ladder
    // and a roster naming service accounts.
    recordIdentityWriteOutcome({
        provider: writer.provider,
        action: 'disable',
        outcome: result.outcome,
    });
    return result;
}

async function decideAndDisable(
    ctx: RequestContext,
    writer: DirectoryWriter,
    input: DisableAccountInput,
): Promise<DisableResult> {
    // ── 0. SELF-LOCKOUT. Before everything, including the ladder. ──
    //
    // Disabling the account this connection binds with locks the product out of
    // the customer's directory, permanently and by its own hand. Nothing
    // afterwards can recover it: the next sync cannot authenticate, so the
    // journal's restore path cannot reach the account to put it back, and the
    // fix is a human with separate credentials.
    //
    // It is a plausible input rather than a paranoid one. A service account
    // appears in an HR feed as an employee more often than one would like —
    // shared mailboxes, contractor conversions, and accounts created for a
    // person who has since left but whose credential was repurposed. The link
    // model matches on email, and a service account with a human-looking
    // address matches exactly as well as a human does.
    //
    // First in the chain, ahead of even the mode check, because this refusal
    // does not depend on configuration. A tenant in AUTOMATIC has not consented
    // to this, and a tenant in DRY_RUN should still see it reported.
    //
    // Compared across every identity form BOTH sides can offer, because the two
    // are keyed differently: a bind is configured as a DN or a UPN, while an AD
    // account's `externalUserId` is an objectGUID. Matching only id-against-id
    // is how this guard came to be wired and unable to fire.
    if (matchesSelf(input, writer.selfAccountIds)) {
        logger.error('leaver disable refused: target is the integration\'s own account', {
            component: 'identity-disable-account',
            tenantId: ctx.tenantId,
            provider: writer.provider,
            // The opaque link id, never the directory identifier: this line is
            // neither encrypted nor tenant-scoped, and an operator reading a dry
            // run still needs to know WHICH candidate tripped the refusal.
            linkId: input.linkId,
        });
        return {
            outcome: 'REFUSED_PROTECTED',
            reason:
                'Refusing to disable the account this integration authenticates as. Doing so would lock the ' +
                'product out of this directory by its own hand — the next sync could not authenticate, so ' +
                'nothing here could reach the account to put it back.',
        };
    }

    // ── 0b. Any other protected account. ──
    if (input.isProtected) {
        logger.warn('leaver disable refused: protected account', {
            component: 'identity-disable-account',
            tenantId: ctx.tenantId,
            provider: writer.provider,
            linkId: input.linkId,
        });
        return {
            outcome: 'REFUSED_PROTECTED',
            reason:
                'Refusing to disable an account marked protected. Break-glass and service accounts are ' +
                'excluded from automated offboarding by policy, not by accident.',
        };
    }

    // ── 1. The ladder. Free, and refuses the most common case. ──
    const policy = (await getIdentityWritePolicy(ctx)).leaver;
    if (policy.mode === 'DISABLED') {
        return { outcome: 'REFUSED_MODE', reason: 'Leaver writes are switched off for this tenant.' };
    }
    if (policy.mode === 'PROPOSE') {
        // PROPOSE means a human approves each one. This function performs
        // writes; it is not the approval queue, so it declines rather than
        // quietly behaving as if AUTOMATIC.
        return {
            outcome: 'REFUSED_MODE',
            reason: 'Leaver writes are in PROPOSE mode: each disable needs explicit approval, which this path does not perform.',
        };
    }

    // ── 2. The target. Also free, and the one that prevents a write that
    //       would silently un-do itself. DECIDED here, RETURNED after the
    //       read. ──
    //
    // WHY THE VERDICT IS HELD
    //
    // `resolveWriteTarget` answers from the stored account row alone, and for
    // the hybrid case its answer never changes: `onPremisesSyncEnabled` is true
    // because the object is mastered on-premises, and it is still true after an
    // administrator does exactly what the refusal asks and disables the account
    // in Active Directory. Returning here therefore produced a NEEDS_ACTION
    // mail that could not be SATISFIED — and because the outbox dedupes
    // pre-journal refusals per day by link id, it was one mail per leaver per
    // day, forever, in the inbox it shares with INDETERMINATE.
    //
    // That is the defect, and it is not a volume one. An alert with no clearing
    // condition is an alert people learn to filter, and it takes the alerts
    // that DO need action down with it.
    //
    // The clearing condition is the account itself. Once it reads disabled
    // there is nothing left to ask anybody for — whoever disabled it, and
    // wherever they did. That fact is one step below, in the read the next
    // section already performs for every other outcome, so the verdict waits
    // for it. For an account that is still live the refusal is unchanged, which
    // is the point: what stops is the nagging, not the reporting.
    //
    // A cloud-side disable that Azure AD Connect is about to revert reads
    // disabled only until the next cycle, after which this refuses again. The
    // alert is quieted by a fact and resumes if the fact does, which is the
    // behaviour to want from it.
    const target = resolveWriteTarget({
        provider: writer.provider,
        onPremisesSyncEnabled: input.onPremisesSyncEnabled,
        // `Boolean(...)`, NOT `!= null`. The strict form reads `undefined` as
        // OBSERVED — and `undefined` is what an unselected column or a row shape
        // predating it produces, so the mistake fails OPEN on a rail whose whole
        // job is to fail closed. The guard now sits against the rail it protects
        // rather than a module away at the query, which is the only place it can
        // be read while deciding whether it is still right.
        // The RAW timestamp, not a boolean the caller derived. The rail owns
        // the age bound — see isObservationFresh — so two producers cannot
        // disagree about whether an account may be disabled, which is exactly
        // what a per-caller `Boolean(...)` invites.
        onPremStateObservedAt: input.onPremStateObservedAt,
    });

    // ═══ THE ONE PLACE A BASIS IS ATTACHED ═══
    //
    // Everything from here down is decided WITH the target, and every one of
    // those outcomes has to be able to say which rule produced it. Merging once,
    // over the whole tail, is why: eight returns live below, and a ninth added
    // later inherits the basis instead of having to remember it. The obligation
    // is discharged by the call graph, not by memory.
    //
    // The refusals ABOVE this line — self-lockout, protected, mode — deliberately
    // carry none. No write-target determination was made for them, and a basis
    // on such a row would describe a rule that never ran.
    return {
        ...(await decideWithTarget(ctx, writer, input, policy.mode, target)),
        basis: {
            rule: target.basis,
            onPremisesSyncEnabled: input.onPremisesSyncEnabled,
            ...(input.onPremStateObservedAt
                ? { observedAt: input.onPremStateObservedAt.toISOString() }
                : {}),
        },
    };
}

/**
 * The tail of the decision: everything the write-target verdict participates in.
 *
 * Split from `decideAndDisable` so the basis has ONE merge point rather than
 * eight — see the comment at the call. The two halves also read as what they
 * are: refusals that need no verdict, then the decisions the verdict shapes.
 *
 * `target` is passed in rather than recomputed. `resolveWriteTarget` is pure and
 * cheap, so a second call would be correct — and it would still be a second
 * evaluation of a safety rail, which is the thing this subsystem refuses to have
 * anywhere else.
 */
async function decideWithTarget(
    ctx: RequestContext,
    writer: DirectoryWriter,
    input: DisableAccountInput,
    mode: IdentityWriteMode,
    target: WriteTarget,
): Promise<DisableResult> {
    // ── 3. Read the current state. First network call, the capture, and now
    //       also the evidence a held target refusal is answered by. ──
    //
    // Reached by a target-refused candidate too, which costs it one read it did
    // not previously make. In DRY_RUN — the rung every tenant is clamped at —
    // that is not a socket at all: `resolveDirectoryWriter` hands the pass the
    // snapshot reader, so it is one indexed row from the last confirmed-complete
    // enumeration. Above DRY_RUN it is a real read against an account we are
    // about to decline to write to, and it buys the refusal its only way to
    // stop. That is worth a read per leaver per day; a permanent alert is not.
    //
    // Inside its own try: this is a NETWORK call, and it was previously
    // unguarded, so a transient read failure propagated out of disableAccount
    // as a throw. That mattered less for one account than for the batch — see
    // disableAccountsForLeaver, where an unguarded throw ended the entire pass.
    //
    // A read failure is INDETERMINATE-shaped in the same sense as a lost write
    // response: we do not know the account's state. But nothing was attempted,
    // so there is no journal row to settle and no ambiguity about the
    // directory — it is untouched. FAILED is the honest outcome here, and it is
    // safe precisely because no write was issued.
    let state: DirectoryAccountState;
    try {
        state = await writer.readState(input.externalUserId);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error('leaver disable could not read account state', {
            component: 'identity-disable-account',
            tenantId: ctx.tenantId,
            provider: writer.provider,
            linkId: input.linkId,
            error: scrubbed(detail, input.externalUserId),
        });
        // A held target refusal outranks a read failure. FAILED is a statement
        // about a write, and no write was ever going to be attempted for this
        // account — reporting it would swap "somebody must disable this where
        // it is mastered" for "the provider rejected the write", a different
        // instruction naming a different cause for the same live account. The
        // refusal is also the decision we are still certain of: it was made
        // from the account row, which the failed read did not contradict.
        if (!target.allowed) return { outcome: 'REFUSED_TARGET', reason: target.reason };
        return { outcome: 'FAILED', reason: `Could not read the account before writing: ${detail}` };
    }

    if (!state.enabled) {
        // Already disabled. Writing again would journal a "prior state" of
        // disabled, which is the state a later restore would then restore TO —
        // turning a no-op into a permanent loss of the real prior state.
        //
        // But this is ALSO the path that closes the loop on a write whose
        // result was never confirmed. If the previous attempt timed out and
        // actually landed, this read is the evidence: the account is disabled,
        // and the only write anyone made to it was ours. Settling that row here
        // turns the retry — which previously returned before journalling and
        // sealed the ambiguity forever — into the mechanism that resolves it,
        // and restores its captured prior state to the restore path.
        // ...but ONLY from evidence a live read produced. Settling asserts "our
        // earlier write landed", inferred from the account being disabled NOW.
        // That inference is sound against the directory and unsound against a
        // stored observation: an account an admin re-enabled this morning still
        // reads disabled in last night's enumeration, so a snapshot-backed pass
        // would settle the row APPLIED and report ALREADY_DISABLED for an
        // account that is live — mis-resolving the one ambiguity the journal
        // exists to hold open, and telling an operator comparing a dry run
        // against reality that nothing needed doing for exactly the person who
        // did. The reader marks its own evidence; the decision is not the mode's
        // to make, because a future caller could read stale data in any mode.
        //
        // A candidate whose write target was REFUSED reaches here too now, and
        // the settle is still right for it. A row exists only where a write was
        // once attempted, which means the target check passed back then and the
        // sync flag has flipped since — so the inference being drawn is the same
        // one, from the same live evidence, and leaving the row unsettled would
        // strand its captured prior state exactly as before.
        const staleEvidence =
            (state.priorState as { staleEvidence?: unknown } | null)?.staleEvidence === true;
        const settled = staleEvidence
            ? null
            : await settleIndeterminateAsApplied(ctx, writer.provider, input.externalUserId);
        return {
            outcome: 'ALREADY_DISABLED',
            reason: settled
                ? 'The account is already disabled; an earlier unconfirmed write has been reconciled as applied.'
                : 'The account is already disabled in the directory.',
            journalId: settled ?? undefined,
        };
    }

    // ── 3b. The target refusal from section 2, now that the account has
    //        actually been asked. ──
    //
    // Enabled, so the refusal still has something to ask for and the mail is
    // still worth sending. Reached only THROUGH the read above, and that is the
    // whole of the fix: the same candidate, once disabled where it is mastered,
    // leaves by the branch above instead and says nothing.
    //
    // Ahead of DRY_RUN, exactly as before. A dry run whose job is to show what
    // the pass WOULD do must still show this decision.
    if (!target.allowed) {
        return { outcome: 'REFUSED_TARGET', reason: target.reason };
    }

    if (mode === 'DRY_RUN') {
        // Everything above was decided for real. Nothing is written, and no
        // journal row is created: a DRY_RUN did not replace anything, so a
        // capture of what it "replaced" would be a lie a restore could read.
        logger.info('leaver disable (dry run)', {
            component: 'identity-disable-account',
            tenantId: ctx.tenantId,
            provider: writer.provider,
            linkId: input.linkId,
        });
        return { outcome: 'DRY_RUN', reason: 'Dry-run mode: the disable was decided but not performed.' };
    }

    // ── 4. Capture BEFORE the write, committed. ──
    const handle = await beginWrite(ctx, {
        linkId: input.linkId,
        provider: writer.provider,
        externalUserId: input.externalUserId,
        action: 'DISABLE_ACCOUNT',
        mode,
        priorState: state.priorState,
    });

    // ── 5. The write. ──
    try {
        await writer.disable(input.externalUserId, state);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);

        // FAILED is a POSITIVE claim that the directory is unchanged, so it is
        // only written when the provider proved that. A lost response — a
        // timeout, a reset, a 5xx from something in front of the provider — is
        // epistemically identical to crashing here, and crashing correctly
        // leaves the row unsettled for a human to resolve.
        //
        // Collapsing the two would be worse than either: a FAILED row whose
        // write actually landed is invisible to findRestorableState (which
        // reads APPLIED) AND to listUnsettledWrites (which reads PENDING and
        // INDETERMINATE), so the captured prior state becomes unreachable and
        // nobody is told to look.
        if (provenNotApplied(err)) {
            await handle.failed(detail);
            logger.error('leaver disable refused by provider', {
                component: 'identity-disable-account',
                tenantId: ctx.tenantId,
                provider: writer.provider,
                linkId: input.linkId,
                journalId: handle.journalId,
                error: scrubbed(detail, input.externalUserId),
            });
            return { outcome: 'FAILED', reason: detail, journalId: handle.journalId };
        }

        await handle.indeterminate(detail);
        logger.error('leaver disable outcome UNKNOWN — verify in the directory', {
            component: 'identity-disable-account',
            tenantId: ctx.tenantId,
            provider: writer.provider,
            linkId: input.linkId,
            journalId: handle.journalId,
            error: detail,
        });
        return { outcome: 'INDETERMINATE', reason: detail, journalId: handle.journalId };
    }

    await handle.applied();
    return { outcome: 'DISABLED', journalId: handle.journalId };
}

export interface LeaverBatchInput {
    /** Links whose worker the HR feed says has left. */
    readonly candidates: readonly DisableAccountInput[];
    /** Accounts known in the directory, from a CONFIRMED-COMPLETE enumeration. */
    readonly population: number;
}

/**
 * Disable a batch, with the blast-radius breaker in front of the whole run.
 *
 * The breaker is checked ONCE, before anything, and refuses the entire batch
 * rather than trimming it — see identity-write-breaker for why. A partly
 * applied batch would perform some of a probably-wrong action and hide the
 * anomaly behind a number that looks deliberate.
 */
export async function disableAccountsForLeaver(
    ctx: RequestContext,
    writer: DirectoryWriter,
    input: LeaverBatchInput,
): Promise<{ refused?: string; results: LeaverDisableResult[] }> {
    const verdict = checkDisableBlastRadius({
        proposed: input.candidates.length,
        population: input.population,
    });
    if (!verdict.allowed) {
        // Its own counter, not an outcome label: a tripped breaker is ONE
        // decision about a batch, and folding it into the per-account counter
        // would make a single bad roster look like a hundred problems.
        recordIdentityBatchRefused({
            provider: writer.provider,
            proposed: input.candidates.length,
            population: input.population,
        });
        logger.warn('leaver batch refused by blast-radius breaker', {
            component: 'identity-disable-account',
            tenantId: ctx.tenantId,
            provider: writer.provider,
            proposed: input.candidates.length,
            population: input.population,
        });
        return { refused: verdict.reason, results: [] };
    }

    // Resolved ONCE, before the loop, for the whole batch: the compliance
    // mailbox (or the OWNER/ADMIN fallback), the tenant slug, and every
    // candidate's manager. Per-account resolution would be an N+1 over the org
    // chart on the one code path already spending a customer's directory rate
    // limit, and it would put reads inside this loop.
    //
    // Outside the per-candidate try on purpose. If the audience cannot be
    // resolved at all the batch still runs — offboarding must not be blocked by
    // a notification lookup — so a failure here yields an empty book and
    // `notifyLeaverOutcome` logs each undeliverable message individually.
    const audience: LeaverAudienceBook = await buildLeaverAudienceBook(
        ctx,
        input.candidates.map((c) => c.linkId),
    ).catch((err: unknown) => {
        logger.error('leaver notification audience could not be resolved; continuing without it', {
            component: 'identity-disable-account',
            tenantId: ctx.tenantId,
            provider: writer.provider,
            error: err instanceof Error ? err.message : String(err),
        });
        return { tenantSlug: null, it: [], byLink: new Map<string, never>() };
    });

    const results: LeaverDisableResult[] = [];
    // Accumulated across the batch rather than reported per candidate — see the
    // single warn after the loop for why.
    let notificationsLost = 0;
    for (const candidate of input.candidates) {
        // Sequential on purpose. These are writes to a customer's directory
        // under a rate-limited API, and a failure part-way through a serial
        // pass leaves a comprehensible half-done state; the same failure under
        // concurrency leaves an arbitrary one.
        //
        // Contained per item. disableAccount is written to return rather than
        // throw, but "written to" is not "guaranteed to" — a bug in a provider
        // writer, or anything thrown before the inner try is reached, would
        // otherwise abandon every REMAINING candidate silently. Half a leaver
        // batch, with no record of which half, is the shape of outage this is
        // least able to explain afterwards.
        let result: DisableResult;
        try {
            result = await disableAccount(ctx, writer, candidate);
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            logger.error('leaver disable threw unexpectedly; continuing the batch', {
                component: 'identity-disable-account',
                tenantId: ctx.tenantId,
                provider: writer.provider,
                externalUserId: candidate.externalUserId,
                error: detail,
            });
            // INDETERMINATE, not FAILED. FAILED is a POSITIVE claim that the
            // directory is unchanged (see the outcome's own doc above), and it
            // is only honest when the provider PROVED it — which is what
            // `provenNotApplied` decides inside `disableAccount`. A throw that
            // escapes to here proved nothing: the most likely one is
            // `handle.applied()` failing on a database blip AFTER the write
            // landed, and labelling that FAILED tells an operator the account
            // is still live and to go disable it by hand, about an account that
            // is already off.
            //
            // "We do not know" already has an outcome, and it is the one whose
            // whole job is to say so: the journal row stays PENDING for
            // `listUnsettledWrites` to surface, and the notification says the
            // write could not be confirmed rather than asserting a non-fact.
            result = { outcome: 'INDETERMINATE', reason: detail };
        }
        results.push({ ...result, linkId: candidate.linkId });

        // Tell the people who need to know — which is NOT everyone, on NOT
        // every outcome. `notifyLeaverOutcome` owns that decision and is
        // contracted never to throw; the try is here anyway because this file's
        // whole posture is that "written not to throw" is not "guaranteed not
        // to", and a notification must never be the reason a leaver batch
        // stops half-done.
        //
        // Enqueued rather than sent: the outbox already claims a row before
        // sending it, so a broken SMTP relay delays a message instead of
        // failing an offboarding.
        try {
            const notified = await notifyLeaverOutcome(ctx, audience, {
                linkId: candidate.linkId,
                provider: writer.provider,
                outcome: result.outcome,
                reason: result.reason,
                journalId: result.journalId,
                // Not for rendering — the notification layer uses it to strip
                // the id back out of the provider's error text.
                externalUserId: candidate.externalUserId,
            });
            notificationsLost += notified.failed;
        } catch (err) {
            // A throw tells us nothing about how many recipients it reached, and
            // `notifyLeaverOutcome` is contracted never to get here. Count the
            // candidate once so the batch line cannot read cleaner than the run
            // actually was.
            notificationsLost += 1;
            logger.error('leaver notification threw unexpectedly; continuing the batch', {
                component: 'identity-disable-account',
                tenantId: ctx.tenantId,
                provider: writer.provider,
                outcome: result.outcome,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // One line for the batch, not one per candidate. "3 of 50 leavers were never
    // announced" is the fact an operator acts on; three warnings scattered
    // through a fifty-candidate run is the same fact in a form nobody totals up.
    // WARN, not ERROR: the directory writes themselves succeeded, and their
    // outcomes are already counted — what was lost is the telling.
    if (notificationsLost > 0) {
        logger.warn('leaver notifications were lost during the batch', {
            component: 'identity-disable-account',
            tenantId: ctx.tenantId,
            provider: writer.provider,
            lost: notificationsLost,
            candidates: results.length,
        });
    }

    return { results };
}

/** Bound on candidates read in one pass. */
const MAX_CANDIDATES = 1_000;

/**
 * The links belonging to workers the HR feed reports as gone.
 *
 * Requires the link to have been re-verified since `staleBefore`. A pairing
 * last confirmed months ago is evidence about a directory that has since
 * changed, and acting on it is the failure the link model exists to avoid.
 */
export async function findLeaverCandidates(
    ctx: RequestContext,
    provider: string,
    employeeIds: readonly string[],
    staleBefore: Date,
): Promise<DisableAccountInput[]> {
    if (employeeIds.length === 0) return [];
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.identityAccountLink.findMany({
            where: {
                tenantId: ctx.tenantId,
                employeeId: { in: [...employeeIds] },
                lastVerifiedAt: { gte: staleBefore },
                // A link a sync has DISPROVED is excluded outright. Freshness
                // alone was never a witness that a pairing is still true — only
                // a bound on how long ago it last was — and the reconciler
                // already knows which ones it disproved.
                contradictedAt: null,
                connectedAccount: { provider },
            },
            select: {
                id: true,
                connectedAccount: {
                    select: {
                        externalUserId: true,
                        email: true,
                        isProtected: true,
                        onPremisesSyncEnabled: true,
                        onPremStateObservedAt: true,
                    },
                },
            },
            take: MAX_CANDIDATES,
        });
        return rows.map((r) => ({
            linkId: r.id,
            externalUserId: r.connectedAccount.externalUserId,
            email: r.connectedAccount.email,
            // The producer the break-glass refusal never had. Read HERE, where
            // the population is assembled, rather than queried inside the write
            // path — so a dry run reports the refusal without the write path
            // needing a hidden lookup to explain it.
            isProtected: r.connectedAccount.isProtected,
            onPremisesSyncEnabled: r.connectedAccount.onPremisesSyncEnabled,
            // A timestamp on the row IS the observation, and it is carried WHOLE
            // rather than collapsed to a boolean here.
            //
            // The rail still consumes only "did anything answer" — the
            // `Boolean(...)` that guarantees an absent value fails CLOSED moved
            // to `decideAndDisable`, immediately against the rail it protects.
            // What the timestamp buys is the report: an operator reading seven
            // days of dry runs has to tell an account nothing has looked at yet
            // from one observed last night, and a boolean cannot say that.
            onPremStateObservedAt: r.connectedAccount.onPremStateObservedAt,
        }));
    });
}

/**
 * Raised when a provider refuses for lack of consented permission.
 *
 * Extends DirectoryWriteError with `definitivelyNotApplied: true`, and that is
 * load-bearing rather than tidy typing. A permission refusal is evaluated by
 * the provider BEFORE anything is mutated, so it is one of the few failures
 * that genuinely proves the directory is unchanged.
 *
 * It extended plain Error in the first version, which meant `provenNotApplied`
 * — an `instanceof DirectoryWriteError` check — returned false for it, and a
 * PROVEN refusal settled as INDETERMINATE. Harmless in isolation, and exactly
 * the kind of harmless that fills an operator's must-investigate queue with
 * rows that need no investigation, until the queue is ignored.
 *
 * Both provider writers hit this independently while implementing against the
 * contract, and both worked around it rather than reporting a clean fit —
 * which is the signal that the contract was wrong, not their usage.
 */
export class InsufficientDirectoryPermission extends DirectoryWriteError {
    constructor(provider: string, needed: string) {
        super(
            `${provider} refused the write for lack of permission. The connection was consented for READ ` +
                `only; disabling an account additionally requires ${needed}. An administrator must re-consent ` +
                `the application with that permission before offboarding can write to this directory.`,
            { definitivelyNotApplied: true },
        );
        this.name = 'InsufficientDirectoryPermission';
    }
}

/** Guard for callers assembling a batch by hand. */
export function assertDisableInput(input: DisableAccountInput): void {
    if (!input.externalUserId.trim()) throw badRequest('A disable needs a target account id');
    if (!input.linkId.trim()) throw badRequest('A disable needs the link it acts through');
}
