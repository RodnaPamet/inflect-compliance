/**
 * The built-in tenant roles, and which of them each writer may write (#3699).
 *
 * `Role` gained a sixth value, `AI_ADMIN`, in TWO deploys. Deploy 1 added the
 * value and taught every READER of `TenantMembership.role` to handle it, and
 * nothing could write it: during a rolling deploy an old container's Prisma
 * client does not know the value, and a row carrying it fails every read that
 * container makes of that membership. Deploy 2 (this one) gives the value
 * exactly two writers, by the owner's decision of 2026-10-18:
 *
 *   1. the members-page role change — an OWNER moves an EXISTING member into
 *      or out of it (`MEMBER_ROLE_CHANGE_ROLES`, `OWNER_MANAGED_ROLES`);
 *   2. an Entra group mapping — at sign-in and on a SCIM Groups push
 *      (`ENTRA_MAPPABLE_ROLES`, `SCIM_GROUP_ASSIGNABLE_ROLES`).
 *
 * Every other membership-role writer still reads `ASSIGNABLE_TENANT_ROLES`,
 * which deploy 2 deliberately did NOT widen: invites, the direct member add,
 * an access review's MODIFY, the custom-role base, SCIM's role attribute and
 * SSO JIT keep refusing it. `tests/unit/ai-admin-role-writers.test.ts` holds
 * the census.
 *
 * Client-safe: the only Prisma dependency is an `import type`.
 */
import type { Role } from '@prisma/client';

/**
 * Every built-in tenant role, in the `Role` enum's declaration order (which is
 * also its Postgres ordinal order — `AI_ADMIN` is last on purpose, see
 * `prisma/schema/enums.prisma`). For a READER of a role: a label table, a
 * filter, a matrix. Never for a writer.
 */
export const TENANT_ROLES = [
    'OWNER',
    'ADMIN',
    'EDITOR',
    'READER',
    'AUDITOR',
    'AI_ADMIN',
] as const satisfies readonly Role[];

/**
 * Compile-time proof that `TENANT_ROLES` names every `Role`. A seventh value
 * added to the enum and not here is a type error on this line, not a label that
 * silently renders the raw enum string.
 */
type MissingFromTenantRoles = Exclude<Role, (typeof TENANT_ROLES)[number]>;
const TENANT_ROLES_ARE_EXHAUSTIVE: [MissingFromTenantRoles] extends [never] ? true : never = true;
void TENANT_ROLES_ARE_EXHAUSTIVE;

/**
 * The roles a membership-role WRITER may write — every role except `AI_ADMIN`.
 * Invites (creation and redemption), the direct member add, the invites
 * route's schema, an access review's MODIFY decision and its close read it.
 *
 * Deploy 2 of #3699 did NOT add `AI_ADMIN` here. Nobody is invited straight
 * into the role and no campaign promotes anybody to it; the members-page role
 * change reads `MEMBER_ROLE_CHANGE_ROLES` instead. It must NOT be derived from
 * `Role`: a new enum value is then unassignable by default, which is the order
 * a rolling deploy needs.
 */
export const ASSIGNABLE_TENANT_ROLES = [
    'OWNER',
    'ADMIN',
    'EDITOR',
    'AUDITOR',
    'READER',
] as const satisfies readonly Role[];

export type AssignableTenantRole = (typeof ASSIGNABLE_TENANT_ROLES)[number];

export function isAssignableTenantRole(role: string): role is AssignableTenantRole {
    return (ASSIGNABLE_TENANT_ROLES as readonly string[]).includes(role);
}

/**
 * The roles the members-page role change may set on an EXISTING member
 * (`PATCH /api/t/:slug/admin/members/:membershipId`, `updateTenantMemberRole`):
 * the writers' list plus `AI_ADMIN` (#3699 deploy 2). Its own constant so every
 * other consumer of `ASSIGNABLE_TENANT_ROLES` stays exactly as it was — the
 * only path to the role in the product is invite as a lower role, then promote.
 */
export const MEMBER_ROLE_CHANGE_ROLES = [
    ...ASSIGNABLE_TENANT_ROLES,
    'AI_ADMIN',
] as const satisfies readonly Role[];

export type MemberRoleChangeRole = (typeof MEMBER_ROLE_CHANGE_ROLES)[number];

export function isMemberRoleChangeRole(role: string): role is MemberRoleChangeRole {
    return (MEMBER_ROLE_CHANGE_ROLES as readonly string[]).includes(role);
}

/**
 * The roles only a holder of `admin.owner_management` — an OWNER — may move a
 * member INTO or OUT OF, wherever the product writes them: the members-page
 * role change and an Entra group mapping that yields one. OWNER's own checks
 * predate this list and keep their wording; `AI_ADMIN` joined it in deploy 2 of
 * #3699 (owner decision: an ADMIN can neither assign nor remove it).
 */
export const OWNER_MANAGED_ROLES = ['OWNER', 'AI_ADMIN'] as const satisfies readonly Role[];

export function isOwnerManagedRole(role: string): boolean {
    return (OWNER_MANAGED_ROLES as readonly string[]).includes(role);
}

/** The refusal for moving a member into or out of an owner-managed role without the key. */
export function ownerManagedRoleMessage(role: string): string {
    return `Only an OWNER can assign or remove the ${role} role.`;
}

/**
 * Roles whose scope is always the reviewed built-in set: a membership holding
 * one never carries a custom role (#3699 deploy 2, owner decision 2). A custom
 * role REPLACES the built-in role's permissions and coarse tier at resolution
 * (`resolveTenantContext` reads `customRole.baseRole ?? role`), so an
 * `AI_ADMIN` carrying one would not be an `AI_ADMIN` at all. Both orders are
 * refused rather than repaired: a custom role is not assigned to such a
 * membership, and a member carrying one is not moved into the role — the
 * custom role is removed first, by a person, as its own audited change.
 */
export const BUILT_IN_SCOPE_ROLES = ['AI_ADMIN'] as const satisfies readonly Role[];

export function mayCarryCustomRole(role: string): boolean {
    return !(BUILT_IN_SCOPE_ROLES as readonly string[]).includes(role);
}

/** The named reason a role/custom-role combination is refused with (`ConflictError.details`). */
export const BUILT_IN_SCOPE_REFUSAL = 'BUILT_IN_SCOPE_ROLE_CARRIES_NO_CUSTOM_ROLE' as const;

/**
 * The refusal, worded for the change that was asked for: assigning a custom
 * role to a membership that holds `role`, or promoting a member who carries a
 * custom role into it.
 */
export function builtInScopeRoleMessage(role: string, asked: 'assign-custom-role' | 'promote'): string {
    const why = `A membership with the ${role} role cannot carry a custom role: its scope is always the built-in one.`;
    return asked === 'promote'
        ? `${why} Remove this member's custom role first, then change the role.`
        : `${why} Change the member to another role first if they need a custom role.`;
}

/**
 * The refusal every writer of `ASSIGNABLE_TENANT_ROLES` gives for a role it may
 * not write. One sentence, so the API says the same thing whichever writer was
 * asked — and says where the role IS assigned.
 */
export function unassignableRoleMessage(role: string): string {
    if (!(TENANT_ROLES as readonly string[]).includes(role)) return `Invalid role: ${role}`;
    return (
        `The ${role} role cannot be assigned here. An OWNER assigns it to an existing ` +
        'member on the members page, or an Entra group mapping does; invite the person ' +
        'with another role first.'
    );
}
