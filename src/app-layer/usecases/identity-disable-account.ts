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
import { badRequest } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { resolveWriteTarget } from './identity-write-target';
import { beginWrite } from './identity-write-journal';
import { getIdentityWritePolicy } from './identity-write-policy';
import { checkDisableBlastRadius } from './identity-write-breaker';
import {
    recordIdentityBatchRefused,
    recordIdentityWriteOutcome,
    recordIdentityWritesUnsettled,
} from '@/lib/observability/integration-metrics';
import { settleIndeterminateAsApplied } from './identity-write-journal';

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
    /** Mastered on-prem, or the sync flag was never observed. */
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

export interface DisableResult {
    readonly outcome: DisableOutcome;
    readonly reason?: string;
    readonly journalId?: string;
}

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
     * The account this connection authenticates AS, when it is an account at
     * all — an LDAP bind DN, say. `null` for a credential that is not a user
     * (an Entra app registration is not).
     *
     * Declared by the writer because only the writer knows it, and read by the
     * orchestrator because only the orchestrator decides. See the self-lockout
     * refusal in `disableAccount`.
     */
    readonly selfAccountId?: string | null;
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
    readonly onPremisesSyncEnabled: boolean | null;
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
 */
/** Case- and whitespace-insensitive identity comparison for directory ids. */
function sameAccount(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
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
    if (writer.selfAccountId && sameAccount(input.externalUserId, writer.selfAccountId)) {
        logger.error('leaver disable refused: target is the integration\'s own account', {
            component: 'identity-disable-account',
            tenantId: ctx.tenantId,
            provider: writer.provider,
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
            externalUserId: input.externalUserId,
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
    //       would silently un-do itself. ──
    const target = resolveWriteTarget({
        provider: writer.provider,
        onPremisesSyncEnabled: input.onPremisesSyncEnabled,
    });
    if (!target.allowed) {
        return { outcome: 'REFUSED_TARGET', reason: target.reason };
    }

    // ── 3. Read the current state. First network call, and the capture. ──
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
            externalUserId: input.externalUserId,
            error: detail,
        });
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
        const settled = await settleIndeterminateAsApplied(ctx, writer.provider, input.externalUserId);
        return {
            outcome: 'ALREADY_DISABLED',
            reason: settled
                ? 'The account is already disabled; an earlier unconfirmed write has been reconciled as applied.'
                : 'The account is already disabled in the directory.',
            journalId: settled ?? undefined,
        };
    }

    if (policy.mode === 'DRY_RUN') {
        // Everything above was decided for real. Nothing is written, and no
        // journal row is created: a DRY_RUN did not replace anything, so a
        // capture of what it "replaced" would be a lie a restore could read.
        logger.info('leaver disable (dry run)', {
            component: 'identity-disable-account',
            tenantId: ctx.tenantId,
            provider: writer.provider,
            externalUserId: input.externalUserId,
        });
        return { outcome: 'DRY_RUN', reason: 'Dry-run mode: the disable was decided but not performed.' };
    }

    // ── 4. Capture BEFORE the write, committed. ──
    const handle = await beginWrite(ctx, {
        linkId: input.linkId,
        provider: writer.provider,
        externalUserId: input.externalUserId,
        action: 'DISABLE_ACCOUNT',
        mode: policy.mode,
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
                externalUserId: input.externalUserId,
                journalId: handle.journalId,
                error: detail,
            });
            return { outcome: 'FAILED', reason: detail, journalId: handle.journalId };
        }

        await handle.indeterminate(detail);
        logger.error('leaver disable outcome UNKNOWN — verify in the directory', {
            component: 'identity-disable-account',
            tenantId: ctx.tenantId,
            provider: writer.provider,
            externalUserId: input.externalUserId,
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
): Promise<{ refused?: string; results: DisableResult[] }> {
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

    const results: DisableResult[] = [];
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
        try {
            results.push(await disableAccount(ctx, writer, candidate));
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            logger.error('leaver disable threw unexpectedly; continuing the batch', {
                component: 'identity-disable-account',
                tenantId: ctx.tenantId,
                provider: writer.provider,
                externalUserId: candidate.externalUserId,
                error: detail,
            });
            results.push({ outcome: 'FAILED', reason: detail });
        }
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
                connectedAccount: { select: { externalUserId: true, onPremisesSyncEnabled: true } },
            },
            take: MAX_CANDIDATES,
        });
        return rows.map((r) => ({
            linkId: r.id,
            externalUserId: r.connectedAccount.externalUserId,
            onPremisesSyncEnabled: r.connectedAccount.onPremisesSyncEnabled,
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
