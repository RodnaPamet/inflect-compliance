/**
 * A user id written into a tenant's row (an owner, an acceptor) must name an
 * ACTIVE member of that tenant.
 *
 * `User` is a global table and these foreign keys reference it with no tenant,
 * so the database accepts any user id. Reads then join the user and return
 * their name and email to every reader of the row. An id from outside the
 * tenant, or of somebody who has left, would show one tenant a stranger's
 * details and attribute work to a person who cannot do it.
 *
 * `null` and `undefined` mean "no one" (or "unchanged") and are always allowed.
 */
import type { PrismaTx } from '@/lib/db-context';
import { badRequest } from '@/lib/errors/types';

export async function assertActiveTenantMember(
    db: PrismaTx,
    tenantId: string,
    userId: string | null | undefined,
    refusal: { code: string; message: string },
): Promise<void> {
    if (!userId) return;
    const membership = await db.tenantMembership.findFirst({
        where: { tenantId, userId, status: 'ACTIVE' },
        select: { id: true },
    });
    if (!membership) throw badRequest(refusal.code, refusal.message);
}
