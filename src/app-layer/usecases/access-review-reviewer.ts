/**
 * Who may be named as an access-review campaign's reviewer: an ACTIVE member of
 * the campaign's own tenant, and nobody else.
 *
 * Every path that names a reviewer asks this one function:
 *   - the four creates (`createAccessReview`, `createConnectedAccessReview`,
 *     `createLegacyAccessReview`, `createAgentAccessReview`);
 *   - the one change (`updateAccessReviewSettings`).
 *
 * The agent create and the settings change each had this check inline. The
 * member, connected and legacy creates had none, and took any existing `User`
 * id. The reviewer could then be somebody outside the tenant who cannot open
 * the campaign, and whom the daily reminder would email about it.
 *
 * One predicate and one refusal, so a client meets the same 400 with the same
 * code for the same rule whichever door it used. The predicate is a membership
 * with status `ACTIVE` in `ctx.tenantId`. INVITED, DEACTIVATED and REMOVED
 * members, and users with no row in this tenant, are all refused.
 *
 * Call it inside the tenant context, before anything is written: a refusal
 * must leave no campaign behind.
 *
 * @module app-layer/usecases/access-review-reviewer
 */
import { badRequest } from '@/lib/errors/types';
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '../types';

/** The reason code, first in the refusal's message (as every access-review refusal is). */
export const REVIEWER_NOT_A_MEMBER = 'REVIEWER_NOT_A_MEMBER';

export async function assertReviewerIsActiveMember(
    db: PrismaTx,
    ctx: RequestContext,
    reviewerUserId: string,
): Promise<void> {
    const member = await db.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId: reviewerUserId, status: 'ACTIVE' },
        select: { id: true },
    });
    if (!member) {
        throw badRequest(`${REVIEWER_NOT_A_MEMBER}: the reviewer must be an active member of this workspace.`);
    }
}
