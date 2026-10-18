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
 * read by `resolveScimRole` alone. It lives here now so both paths read it —
 * do not add a second copy. Path 2's ceiling is path 1's plus exactly
 * `AI_ADMIN` (`SCIM_GROUP_ASSIGNABLE_ROLES`, #3699 deploy 2), and is derived
 * from it, so ADMIN and OWNER stay out of both by construction.
 */
import type { Role } from '@prisma/client';

/**
 * The complete set of roles SCIM may assign, in no significant order.
 *
 * ADMIN and OWNER are deliberately absent: promotion to either requires a
 * deliberate in-product admin action with a real session behind it. So is
 * AI_ADMIN (#3699): an identity provider's `roles[]` attribute never confers it.
 * Since deploy 2 the role does reach SCIM, but only through a GROUP the tenant
 * mapped to it (`SCIM_GROUP_ASSIGNABLE_ROLES`) — an OWNER-made mapping, not a
 * value the token holder names. Never add it here.
 */
export const SCIM_ASSIGNABLE_ROLES = ['READER', 'EDITOR', 'AUDITOR'] as const satisfies readonly Role[];

export type ScimAssignableRole = (typeof SCIM_ASSIGNABLE_ROLES)[number];

/**
 * The ceiling a SCIM Groups push reconciles under: the Users ceiling plus
 * `AI_ADMIN` (#3699 deploy 2, owner decision of 2026-10-18 — "also assignable
 * from an Entra group", on the sign-in path and on this one).
 *
 * It bounds both what the push may resolve a member TO and which memberships it
 * may touch (`syncEntraMembershipRole`), so the push that can move a member
 * into `AI_ADMIN` can move them out again when the group changes; ADMIN and
 * OWNER memberships stay untouchable from SCIM. Two things keep this narrower
 * than it looks: a mapping that yields `AI_ADMIN` is made by an OWNER only, and
 * the Users path's protection (`isScimProtectedRole`) still reads
 * `SCIM_ASSIGNABLE_ROLES`, so an `AI_ADMIN` membership is not reachable through
 * `/Users` at all.
 *
 * What it does NOT stop, and #2200 documents for ADMIN: a holder of the tenant's
 * SCIM bearer token can push a group whose `externalId` is the AI_ADMIN-mapped
 * group's id and so promote any member with an identity link. That is the cost
 * of the group path reaching the role, and the reason ADMIN is not here.
 */
export const SCIM_GROUP_ASSIGNABLE_ROLES = [
    ...SCIM_ASSIGNABLE_ROLES,
    'AI_ADMIN',
] as const satisfies readonly Role[];

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
 * is unprotected in exactly one place. Today that is ADMIN, OWNER and AI_ADMIN —
 * the last by this default, with no edit here when #3699 added it. Deploy 2
 * left it protected here although a Groups push may now write it: the Users
 * path neither assigns nor alters an AI_ADMIN membership.
 *
 * Note this is the *enum* role only. A membership carrying a permissive
 * `customRoleId` on top of an assignable base role is still SCIM-writable;
 * scoping SCIM against custom roles is a separate decision (#2200 item 2).
 */
export function isScimProtectedRole(role: string): boolean {
    return !isScimAssignableRole(role);
}
