import { getRestorableStateForAccount } from '@/app-layer/usecases/identity-write-journal';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { conflict, notFound } from '@/lib/errors/types';
import { restoreAccount } from '@/app-layer/usecases/identity-restore-account';

type RestorableParams = { tenantSlug: string; accountId: string };

/**
 * GET /api/t/:tenantSlug/admin/identity-write-journal/restorable/:accountId
 *
 * What a disable REPLACED on one account — reached from the account rather than
 * from the reference in the mail.
 *
 * WHY THIS IS NOT THE SIBLING ROUTE. `[journalId]` answers "what does this
 * reference say", and the reference arrives in the DISABLED notification. This
 * route answers "what was replaced on this account", which is the question left
 * when the mail is gone, was sent to somebody who has since left, or names a
 * write nobody can now identify. `findRestorableState` was written for exactly
 * that question and, until this route, had no caller in `src/`: the capture was
 * taken, journalled, and reachable only by a reference an operator might not
 * have.
 *
 * THE ACCOUNT ID, NOT THE DIRECTORY IDENTIFIER. The underlying query is scoped
 * by `(provider, externalUserId)`, but `externalUserId` is a raw directory
 * identifier this subsystem does not hand out, and a URL is the one part of a
 * request that everything it passes through writes to a log. The path takes
 * `ConnectedIdentityAccount.id` — tenant-scoped and opaque, the same way
 * `admin/identity-account-protection/[accountId]` addresses these accounts —
 * and the directory identifier is resolved server-side. It appears in no path,
 * no query string, and no response body.
 *
 * 404 FOR AN UNKNOWN ACCOUNT, 200 FOR AN ACCOUNT WITH NO CAPTURE. These are
 * different answers and collapsing them would be a regression in both
 * directions. An unknown or foreign account id is `notFound`, which keeps the
 * response from becoming an oracle for whether a cuid exists in another
 * tenant — the same reasoning the sibling route sets out. But an account that
 * exists and has simply never been written to is the ORDINARY case on any
 * tenant that has only ever run DRY_RUN, and answering that with "not found"
 * sends an operator hunting for a bug instead of telling them the truth.
 *
 * STILL THE READ HALF ONLY. Re-applying a captured state is a WRITE back into
 * a customer's directory: `DirectoryWriter` declares no enable verb, and
 * deliberately so. Nothing here re-applies anything, and `outcome` is returned
 * precisely so a human can see that an INDETERMINATE capture may describe a
 * write that never landed.
 *
 * GATED `admin.tenant_lifecycle` — inherited from the prefix rule covering
 * `admin/identity-write-journal`, OWNER-only, the same key as the index and the
 * by-reference route beside it. ADMIN explicitly does not hold it.
 */
export const GET = withApiErrorHandling(
    requirePermission<RestorableParams>(
        'admin.tenant_lifecycle',
        async (_req, { params }, ctx) => {
            const { accountId } = params;

            const lookup = await getRestorableStateForAccount(ctx, accountId);

            if (lookup.kind === 'no-account') {
                // TRUNCATED for the same reason the sibling route truncates: this
                // echoes a caller-controlled path segment, and the message is
                // written to the structured log as well as the body, so an
                // unbounded echo hands anyone who can reach the route a
                // log-volume lever. A cuid is ~25 characters.
                throw notFound(`No connected identity account for reference ${accountId.slice(0, 64)}`);
            }

            if (lookup.kind === 'no-capture') {
                return jsonResponse({
                    accountId: lookup.accountId,
                    provider: lookup.provider,
                    restorable: null,
                });
            }

            return jsonResponse({
                accountId: lookup.accountId,
                provider: lookup.provider,
                restorable: {
                    journalId: lookup.journalId,
                    priorState: lookup.priorState,
                    attemptedAt: lookup.attemptedAt,
                    outcome: lookup.outcome,
                },
            });
        },
    ),
);

/**
 * POST /api/t/:tenantSlug/admin/identity-write-journal/restorable/:accountId
 *
 * PUT THE CAPTURED STATE BACK.
 *
 * ═══ WHY A WRITE LIVES BESIDE THE READ ═══
 *
 * The GET above answers "what did a disable replace"; this answers the request
 * the DISABLED notification has been making all along — "quote that reference
 * to your platform administrator, who can read the captured state **and
 * re-apply it**". Until now only the first half was true. A read surface built
 * for an instruction whose second half nothing could honour is the same defect
 * this route was created to fix, one step along.
 *
 * ═══ IT IS NOT AN ENABLE ═══
 *
 * The verb underneath writes one specific captured value and refuses unless
 * the account is still exactly as this product left it — a compare-and-swap on
 * Active Directory, a checked read on Entra, where Graph offers no equivalent
 * and the writer says so. An enable can be pointed at any account; a restore
 * can only undo something this product did and can still prove it did.
 *
 * ═══ STATUSES ═══
 *
 * 404 for an account this tenant cannot see, matching the GET and keeping the
 * response from becoming an oracle for cuids in other tenants. 409 for an
 * account that exists with nothing to undo, and for a directory that refused —
 * both are "the state of the world does not permit this", and neither is the
 * caller having sent something malformed. 200 carries the journal ids, so the
 * operator who asked can point at both rows: the restore, and the disable it
 * reverted.
 *
 * GATED `admin.tenant_lifecycle`, inherited from the prefix rule over
 * `admin/identity-write-journal` — OWNER-only, the same key as the reads beside
 * it. Deliberately NOT a second, weaker gate for the write: reading what was
 * replaced and putting it back are the same authority over the same fact.
 */
export const POST = withApiErrorHandling(
    requirePermission<RestorableParams>(
        'admin.tenant_lifecycle',
        async (_req, { params }, ctx) => {
            const { accountId } = params;
            const result = await restoreAccount(ctx, accountId);

            switch (result.kind) {
                case 'NO_ACCOUNT':
                    // Truncated, like the GET: this echoes a caller-controlled
                    // path segment into a response AND a structured log line.
                    throw notFound(
                        `No connected identity account for reference ${accountId.slice(0, 64)}`,
                    );
                case 'NO_CAPTURE':
                    throw conflict(
                        'This product has no captured prior state for that account, so there is nothing to ' +
                            'put back. Only a disable it performed and journalled can be restored.',
                    );
                case 'UNSUPPORTED':
                case 'REFUSED':
                    throw conflict(result.detail);
                case 'FAILED':
                    // The directory positively did not change, and the journal
                    // row says so. Named rather than folded into REFUSED
                    // because a row exists to point at.
                    throw conflict(`${result.detail} (journal reference ${result.journalId})`);
                case 'INDETERMINATE':
                    // NOT an error status. The call did not report back, so the
                    // directory may have changed — telling the caller it failed
                    // would assert something nobody verified, and this is
                    // exactly the state a human has to look at.
                    return jsonResponse({
                        restored: false,
                        indeterminate: true,
                        journalId: result.journalId,
                        detail: result.detail,
                    });
                case 'RESTORED':
                    return jsonResponse({
                        restored: true,
                        journalId: result.journalId,
                        revertedJournalId: result.revertedJournalId,
                    });
            }
        },
    ),
);
