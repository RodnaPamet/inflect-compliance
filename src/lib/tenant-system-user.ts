/**
 * The per-tenant SYSTEM user's identity (#4400).
 *
 * A background job that must write a row with a NOT NULL foreign key to
 * `User` (`Task.createdByUserId` first) writes it as this user, instead of
 * borrowing a real member's id and naming them as the author of something
 * they did not do.
 *
 * Its id IS its marker. The migration `20261029200000_tenant_system_user`
 * ties the row's shape to the `sys_` prefix and refuses that prefix in every
 * table that would let a user sign in or hold standing (Account, identity
 * link, tenant and org membership, password reset, MFA, sessions, API keys,
 * device tokens). So a check here is a second line, never the only one.
 *
 * No imports, so `src/auth.ts` and the edge can use it.
 */

const SYSTEM_USER_ID_PREFIX = 'sys_';
const SYSTEM_USER_HASH_PREFIX = 'system:';

/** The system user's id for a tenant. A cuid never contains `_`, so it cannot collide with a person's. */
export function tenantSystemUserId(tenantId: string): string {
    return `${SYSTEM_USER_ID_PREFIX}${tenantId}`;
}

/**
 * The value stored in `User.emailHash`. Not an HMAC of anything, so no
 * lookup by email (`hashForLookup`) can ever compute it and reach the row.
 */
export function tenantSystemUserEmailHash(tenantId: string): string {
    return `${SYSTEM_USER_HASH_PREFIX}${tenantId}`;
}

/**
 * The stored email. The reserved `.invalid` top-level domain (RFC 2606)
 * cannot be delivered to, and the mailer refuses it outright.
 */
export function tenantSystemUserEmail(tenantId: string): string {
    return `system+${tenantId}@inflect.invalid`;
}

/** The name shown wherever a row's author is rendered. */
export const TENANT_SYSTEM_USER_NAME = 'Inflect automation';

/** Whether a user id is a tenant's system user. */
export function isTenantSystemUserId(userId: string | null | undefined): boolean {
    return typeof userId === 'string' && userId.startsWith(SYSTEM_USER_ID_PREFIX);
}
