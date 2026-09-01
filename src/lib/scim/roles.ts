/**
 * The SCIM role ceiling — ONE definition, read by every SCIM write path.
 *
 * SCIM is an unauthenticated-by-role surface: a bearer token authorizes every
 * operation for its tenant (see #2200), and `/api/scim` is a middleware public
 * path, so neither the tenant gate nor either rate-limit tier runs on it. The
 * only thing standing between a token holder and a privileged membership is
 * this list.
 *
 * Two independent SCIM paths write `TenantMembership.role`:
 *
 *   1. **Users** — `resolveScimRole` maps an IdP-supplied `roles[].value`
 *      through an allow-list.
 *   2. **Groups** — a pushed `ScimGroup.externalId` is matched against the
 *      tenant's `TenantEntraGroupMapping` rows, and ADMIN *is* a permitted
 *      mapping target (`ENTRA_MAPPABLE_ROLES`) because an admin configures
 *      those mappings by hand for the sign-in path.
 *
 * Path 2 used to bypass the invariant path 1 documents ("SCIM NEVER creates or
 * promotes to ADMIN") because the ceiling lived inside `scim-users.ts` and was
 * read by `resolveScimRole` alone. It lives here now so both paths read the
 * same list — do not add a second copy.
 */
import type { Role } from '@prisma/client';

/**
 * The complete set of roles SCIM may assign, in no significant order.
 *
 * ADMIN and OWNER are deliberately absent: promotion to either requires a
 * deliberate in-product admin action with a real session behind it.
 */
export const SCIM_ASSIGNABLE_ROLES = ['READER', 'EDITOR', 'AUDITOR'] as const satisfies readonly Role[];

export type ScimAssignableRole = (typeof SCIM_ASSIGNABLE_ROLES)[number];

/** What SCIM provisions a brand-new membership with. */
export const SCIM_DEFAULT_ROLE: ScimAssignableRole = 'READER';

export function isScimAssignableRole(role: string): role is ScimAssignableRole {
    return (SCIM_ASSIGNABLE_ROLES as readonly string[]).includes(role);
}

/**
 * True for a membership SCIM must not mutate at all — neither its role nor its
 * status.
 *
 * Defined as the complement of the ceiling rather than as a second list, so a
 * role added to `Role` is protected by default and a role added to the ceiling
 * is unprotected in exactly one place. Today that is ADMIN and OWNER.
 *
 * Note this is the *enum* role only. A membership carrying a permissive
 * `customRoleId` on top of an assignable base role is still SCIM-writable;
 * scoping SCIM against custom roles is a separate decision (#2200 item 2).
 */
export function isScimProtectedRole(role: string): boolean {
    return !isScimAssignableRole(role);
}
