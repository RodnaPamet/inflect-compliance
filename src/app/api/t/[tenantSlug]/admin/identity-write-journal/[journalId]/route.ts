import { getJournalWrite } from '@/app-layer/usecases/identity-write-journal';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { notFound } from '@/lib/errors/types';

type JournalEntryParams = { tenantSlug: string; journalId: string };

/**
 * ONE journal row by its reference — what the DISABLED notification's "journal
 * reference <id>" actually resolves to, and the only place in the product that
 * returns the captured prior state.
 *
 * WHAT AN OPERATOR IS HOLDING WHEN THEY ARRIVE HERE. An email, sent the moment
 * an account was disabled, carrying a cuid and the sentence "quote that
 * reference to your platform administrator, who can read the captured state and
 * re-apply it". Until this route, the second half of that sentence described a
 * capability the product did not have. The row existed — this subsystem is built
 * so it cannot NOT exist — but nothing could read it back.
 *
 * WHAT IT RETURNS, AND WHY THAT IS THE POINT. `priorState` is the provider-shaped
 * state the write replaced: `accountEnabled` for Entra, the whole
 * `userAccountControl` integer for on-prem AD. That integer is the reason the
 * capture-before-write rail exists at all — its other bits
 * (password-never-expires, smartcard-required) are destroyed the instant a
 * disable lands, so this row is frequently the ONLY surviving copy of what the
 * account was. A read surface that withheld it would leave the journal
 * write-only, which is the state that made the mail's instruction unfollowable.
 *
 * `detail` is returned too, and that is a decision rather than an oversight: the
 * column is on the Epic B encryption manifest. The full argument is written out
 * on `getJournalWrite` in the usecase, where it sits beside the `select` it
 * governs — in short, the manifest governs REST rather than AUDIENCE, its
 * nearest neighbour (`ConnectedIdentityAccount.protectionReason`) is already
 * read back by an `admin.manage` surface while this one is OWNER, and on a
 * FAILED or INDETERMINATE row `detail` IS the answer the operator came for.
 *
 * `externalUserId` is NOT returned. This subsystem does not hand the raw
 * directory identifier out of the module; `linkId` is the handle that does the
 * same job and resolves to a person only through an authorised read of the
 * roster at `admin/integrations/identity-accounts`.
 *
 * 404 RATHER THAN 403 FOR AN UNKNOWN REFERENCE. The lookup is tenant-scoped by
 * RLS and by an explicit `tenantId` predicate, so a reference belonging to
 * another tenant is simply not there. Answering "not found" for both a
 * mistyped id and a foreign one is what keeps the response from becoming an
 * oracle for whether a given cuid exists somewhere else in the fleet.
 *
 * GATED `admin.tenant_lifecycle` — OWNER-only, the same key as the index beside
 * it, as the write policy the write ran under, and as the leaver-pass report
 * that now carries this id on each decision. ADMIN explicitly does not hold it.
 */
export const GET = withApiErrorHandling(
    // Destructured as `{ params }`, then awaited: under the Next 15+ runtime the
    // route export receives `params` as a Promise, and the wrapper forwards
    // routeArgs rather than the resolved object.
    requirePermission<JournalEntryParams>(
        'admin.tenant_lifecycle',
        async (_req, { params }, ctx) => {
            const { journalId } = await params;

            const write = await getJournalWrite(ctx, journalId);
            if (!write) {
                // The message names the reference deliberately. An operator who
                // has just pasted a cuid out of an email needs to see WHICH
                // reference came back empty — most often because they quoted the
                // id from a different tenant's mail, or truncated it.
                throw notFound(`No identity write journal entry for reference ${journalId}`);
            }

            return jsonResponse({ write });
        },
    ),
);
