/**
 * Who may change an evidence record's control links (#4326, owner decision).
 *
 * Kept apart from `evidence.ts` so the routes and integrations that ask it
 * before calling into the library (the ZIP import, the SharePoint import) need
 * not load the whole evidence usecase.
 */
import type { RequestContext } from '../types';
import { canLinkEvidence } from '../policies/control.policies';
import { forbidden, ForbiddenError } from '@/lib/errors/types';

/** The reason code on the 403 that refuses a change to an evidence record's control links. */
export const CONTROL_LINKS_REFUSAL = 'CONTROL_LINKS_NOT_PERMITTED';

/**
 * Adding or removing a control link needs the coarse write tier AND
 * `controls.edit`: `assertCanLinkEvidence`'s rule, which the control side and
 * the details panel's link and unlink routes already take (#4326, owner
 * decision). The create, edit, upload and ZIP-import paths apply it only when
 * the request changes links. A record created with no control, or saved with
 * its links as they were, needs `evidence.edit` / `evidence.upload` alone.
 *
 * The refusal is audited through `assertPermission`, the decision
 * `requirePermission` makes, shared for callers that are not a route: it
 * writes one hash-chained `AUTHZ_DENIED` row naming `controls.edit` when that
 * key is what is missing. Its generic 403 is replaced by one carrying
 * `CONTROL_LINKS_REFUSAL`. A refusal for the coarse tier alone (a custom role
 * on a read-tier base that holds `controls.edit`) writes no row, as no coarse
 * `assertCan*` refusal does.
 *
 * `surface` names the request on that row: the real method and path where the
 * caller holds the request, otherwise the route the calling usecase serves.
 */
export async function assertMayChangeEvidenceControlLinks(
    ctx: RequestContext,
    surface: { method: string; path: string },
): Promise<void> {
    if (canLinkEvidence(ctx)) return;
    // Loaded only on a refusal, so the evidence usecase's module graph stays
    // as it was: `@/lib/audit`, which this reaches, builds the Prisma client
    // when it is imported.
    const { assertPermission } = await import('@/lib/security/assert-permission');
    try {
        await assertPermission(ctx, 'controls.edit', surface);
    } catch (err) {
        // The refusal is expected. Anything else (the denial could be neither
        // appended to the chain nor queued) is not a refusal, and goes up as
        // itself rather than as a 403 that was never recorded.
        if (!(err instanceof ForbiddenError)) throw err;
    }
    throw forbidden('You do not have permission to link evidence to controls.', {
        reason: CONTROL_LINKS_REFUSAL,
    });
}
