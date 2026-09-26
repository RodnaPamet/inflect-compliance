/**
 * Put back what a disable replaced.
 *
 * ═══ WHY THIS DID NOT EXIST ═══
 *
 * `findRestorableState` had no caller in `src/` (#2877 f26), and the reason was
 * not neglect. `DirectoryWriter` deliberately declared no enable verb, because
 * re-enabling accounts in a customer's directory is a capability worth choosing
 * on purpose rather than acquiring as a side effect of closing a finding.
 * #2926 built the half that lets an authorised human SEE what was replaced.
 * This is the half that puts it back, and it is safe to have because it is not
 * an enable: it writes one specific captured value and refuses unless the
 * account is still exactly as this product left it.
 *
 * ═══ NOT GATED ON THE WRITE LADDER, AND THAT IS DELIBERATE ═══
 *
 * The ladder exists so a tenant climbing toward AUTOMATIC does not write to a
 * directory before it means to. A restore is a different act: a named human
 * with `admin.tenant_lifecycle` undoing something this product already did.
 *
 * Gating it on the ladder produces a perverse outcome — a tenant that dialled
 * automation back to DISABLED after a bad pass could no longer undo the writes
 * that pass made, which is precisely the moment a restore is for. And the
 * authorisation it would be standing in for is already present twice over: the
 * permission, and the existence of a captured journal row. You cannot restore
 * an account this product never disabled, because there is nothing to restore
 * FROM.
 *
 * ═══ THE ORIGINAL ROW IS MARKED REVERTED, WHICH IS CORRECTNESS ═══
 *
 * `findRestorableState` selects `APPLIED` and `INDETERMINATE`. A restore that
 * left the original row APPLIED would leave it discoverable, and the next
 * restore would try to undo a disable that has already been undone — refused by
 * the writer's compare-and-swap, but refused as a directory error rather than
 * as "there is nothing to put back". Settling it REVERTED is what makes the
 * second attempt say the true thing.
 *
 * A NEW ROW is written too, because the restore is itself a directory write and
 * has its own actor, its own instant, and its own prior state (the disabled
 * one). Reverting the old row alone would record that something was undone
 * without recording who undid it.
 */
import type { RequestContext } from '../types';
import { beginWrite, getRestorableStateForAccount, settleReverted } from './identity-write-journal';
import { resolveDirectoryWriter } from '../integrations/identity-writer-factory';
import { logger } from '@/lib/observability/logger';
import { redactDirectoryIdentifiers } from '@/lib/security/redact-directory-identifiers';

export type RestoreOutcome =
    /** No such account in this tenant. */
    | { readonly kind: 'NO_ACCOUNT' }
    /** The account exists and this product never disabled it. */
    | { readonly kind: 'NO_CAPTURE'; readonly accountId: string }
    /** The connection cannot be written through — credentials, consent, provider. */
    | { readonly kind: 'REFUSED'; readonly accountId: string; readonly detail: string }
    /**
     * The provider has a writer but no restore verb.
     *
     * Its own outcome rather than a generic refusal: it is a statement about
     * what this product can do for that directory, not about this connection,
     * and an operator reading it should stop looking for a misconfiguration.
     */
    | { readonly kind: 'UNSUPPORTED'; readonly accountId: string; readonly detail: string }
    /** The directory refused, and positively did not change. */
    | { readonly kind: 'FAILED'; readonly accountId: string; readonly detail: string; readonly journalId: string }
    /** The call did not report back. A human still has to look. */
    | { readonly kind: 'INDETERMINATE'; readonly accountId: string; readonly detail: string; readonly journalId: string }
    | {
          readonly kind: 'RESTORED';
          readonly accountId: string;
          /** The row recording THIS write. */
          readonly journalId: string;
          /** The disable this undid, now settled REVERTED. */
          readonly revertedJournalId: string;
      };

/**
 * Restore one account from the state captured before it was disabled.
 *
 * `accountId` is a `ConnectedIdentityAccount.id` — opaque and tenant-scoped,
 * the shape every other surface uses to name these accounts, and the reason
 * the raw directory identifier never travels in a URL.
 */
export async function restoreAccount(ctx: RequestContext, accountId: string): Promise<RestoreOutcome> {
    const lookup = await getRestorableStateForAccount(ctx, accountId);
    if (lookup.kind === 'no-account') return { kind: 'NO_ACCOUNT' };
    if (lookup.kind === 'no-capture') return { kind: 'NO_CAPTURE', accountId };

    const { provider, journalId: capturedFrom, priorState } = lookup;

    // AUTOMATIC to obtain a LIVE writer, not because the tenant's ladder says
    // so — see the module docblock. The snapshot writer refuses every write by
    // design, and handing it a restore would report a refusal that describes
    // this product's dry-run plumbing rather than the customer's directory.
    const resolution = await resolveDirectoryWriter({ ctx, provider, mode: 'AUTOMATIC' });
    if (resolution.kind !== 'live') {
        return {
            kind: 'REFUSED',
            accountId,
            detail:
                resolution.kind === 'none'
                    ? resolution.detail
                    : 'The writer resolved to a snapshot, which cannot write to the directory.',
        };
    }

    const { writer, close } = resolution;
    if (!writer.restore) {
        await close();
        return {
            kind: 'UNSUPPORTED',
            accountId,
            detail: `${provider} accounts can be disabled by this product but not restored by it.`,
        };
    }

    try {
        // CAPTURE FIRST, exactly as the disable path does. The state being
        // replaced here is the DISABLED one, and a restore that failed halfway
        // needs it for the same reason the disable needed the enabled one.
        const handle = await beginWrite(ctx, {
            linkId: null,
            provider,
            externalUserId: lookup.externalUserId,
            action: 'ENABLE_ACCOUNT',
            mode: 'AUTOMATIC',
            priorState: { restoredFromJournalId: capturedFrom, capturedPriorState: priorState },
        });

        try {
            await writer.restore(lookup.externalUserId, { enabled: true, priorState });
        } catch (err) {
            const detail = redactDirectoryIdentifiers(err instanceof Error ? err.message : String(err), null);
            // `definitivelyNotApplied` is the writer's own claim that the
            // directory is unchanged. Without it we do not know, and saying
            // FAILED would assert something nobody verified.
            const notApplied = (err as { definitivelyNotApplied?: boolean })?.definitivelyNotApplied === true;
            if (notApplied) {
                await handle.failed(detail);
                return { kind: 'FAILED', accountId, detail, journalId: handle.journalId };
            }
            await handle.indeterminate(detail);
            return { kind: 'INDETERMINATE', accountId, detail, journalId: handle.journalId };
        }

        await handle.applied('restored from the captured prior state');
        // Only after the write is known to have landed. Reverting the original
        // first would leave a row claiming the disable was undone by a restore
        // that then failed.
        await settleReverted(ctx, capturedFrom, `undone by restore ${handle.journalId}`);

        logger.info('identity account restored', {
            component: 'identity-restore-account',
            tenantId: ctx.tenantId,
            provider,
            // The journal ids, never the directory identifier — this line is
            // neither encrypted nor tenant-scoped.
            journalId: handle.journalId,
            revertedJournalId: capturedFrom,
        });

        return { kind: 'RESTORED', accountId, journalId: handle.journalId, revertedJournalId: capturedFrom };
    } finally {
        await close();
    }
}
