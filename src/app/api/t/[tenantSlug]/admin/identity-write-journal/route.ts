import { listJournalWrites } from '@/app-layer/usecases/identity-write-journal';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type JournalParams = { tenantSlug: string };

/**
 * The identity-write journal, most recent first — the INDEX half of the read
 * surface the DISABLED notification already promises.
 *
 * WHY THIS EXISTS. On 2026-09-12 at 05:00 UTC this product performed its first
 * real directory disable: one account, `IdentityWriteJournal`'s first row ever,
 * APPLIED. The mail that went out told IT that the account's prior state "is
 * held against journal reference <id>" and to "quote that reference to your
 * platform administrator, who can read the captured state and re-apply it".
 *
 * There was nothing to quote it TO. `findRestorableState` had no caller in
 * `src/`, no route read the table, and no page rendered it. An instruction a
 * product cannot honour is worse than none: it sends an operator hunting for a
 * screen that does not exist at the moment they are trying to undo a disable,
 * and surviving that moment is the entire reason the capture happens first.
 *
 * THE READ HALF ONLY. Re-applying a captured state is a WRITE back into a
 * customer's directory — `DirectoryWriter` declares no `enable()` verb, and
 * deliberately so. Letting an authorised human SEE what was replaced is a
 * separate and much smaller decision, and it is the one this route makes.
 *
 * GATED `admin.tenant_lifecycle`, the same OWNER-only key as the write policy
 * these writes ran under, and as the leaver-pass report that links here.
 * Deliberately NOT `admin.manage`: a journal row names a change made to one of
 * a customer's people's accounts, and reading that is authority of the same
 * class as granting it. ADMIN explicitly does not hold this key.
 *
 * The path is a SIBLING of `admin/identity-write-policy` and
 * `admin/identity-leaver-passes` rather than something nested under
 * `admin/integrations`, and that is not cosmetic: route matching in
 * `route-permissions.ts` is first-match-wins and the `admin/integrations` rule
 * resolves to `admin.manage`, so a nested path would leave the permission map
 * documenting a WEAKER gate than the handler enforces.
 *
 * NARROW BY CONSTRUCTION. `listJournalWrites` selects neither `priorStateJson`
 * (the captured state, fetched one row at a time by the sibling route below
 * this directory) nor `detail` (manifest-encrypted free text) nor
 * `externalUserId` (a raw directory identifier this subsystem does not hand
 * out). The reasoning for each lives on the usecase, where it can be read
 * beside the query it governs.
 */
export const GET = withApiErrorHandling(
    requirePermission<JournalParams>('admin.tenant_lifecycle', async (req, _params, ctx) => {
        const url = new URL(req.url);

        // Parsed permissively rather than validated into a 400. This is a
        // surface somebody reaches mid-incident from a link in an email, and a
        // rejected request teaches them nothing about their directory; the
        // usecase clamps the value to its own ceiling regardless, so a garbage
        // limit costs a default page rather than an error page.
        //
        // Non-POSITIVE is treated as unset rather than passed through. `?limit=`
        // parses as 0 (`Number('')` is 0, and it is finite), which the usecase's
        // `Math.max(1, …)` floor would turn into a one-row page — a silent,
        // baffling answer to a request that plainly meant "no opinion".
        const rawLimit = url.searchParams.get('limit');
        const parsedLimit = rawLimit === null ? NaN : Number(rawLimit);
        const limit =
            Number.isFinite(parsedLimit) && parsedLimit >= 1 ? Math.trunc(parsedLimit) : undefined;

        const provider = url.searchParams.get('provider') ?? undefined;

        const writes = await listJournalWrites(ctx, { limit, provider });
        return jsonResponse({ writes });
    }),
);
