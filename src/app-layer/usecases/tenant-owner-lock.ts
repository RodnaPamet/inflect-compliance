/**
 * The per-tenant lock every change to a tenant's OWNERs queues on (#5388).
 *
 * Two OWNERs demoting, deactivating or removing each other at once used to
 * each count the other as still an ACTIVE OWNER under READ COMMITTED, write
 * different rows, and both commit — leaving the tenant with no ACTIVE OWNER.
 * Both layers of the last-OWNER guard now take this lock before they count:
 * the `tenant_membership_last_owner_guard` trigger (`check_not_last_owner`,
 * migration 20261112160000) and the usecases that run their own count.
 *
 * Take it FIRST in the transaction, before reading the membership or counting
 * owners and before writing any row: a read that runs after it returns sees
 * the committed result of whichever change held it before, and taking it
 * before any row lock keeps the lock order the same as the trigger's (advisory
 * lock, then row), so the two never deadlock. The trigger's re-entry in the
 * same transaction is free — advisory locks stack. `tenant-owner:` is distinct
 * from the audit chain's bare `hashtext(tenantId)` key.
 */
import type { Prisma } from '@prisma/client';

export function tenantOwnerLockKey(tenantId: string): string {
    return `tenant-owner:${tenantId}`;
}

export async function lockTenantOwners(
    db: Pick<Prisma.TransactionClient, '$executeRawUnsafe'>,
    tenantId: string,
): Promise<void> {
    await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, tenantOwnerLockKey(tenantId));
}
