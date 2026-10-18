/**
 * The built-in tenant roles, and which of them a writer may write (#3699).
 *
 * `Role` gained a sixth value, `AI_ADMIN`, in TWO deploys. Deploy 1 (this one)
 * adds the value and teaches every READER of `TenantMembership.role` to handle
 * it; deploy 2 lets an OWNER assign it on the members page. Between the two, no
 * code path may write it: during a rolling deploy an old container's Prisma
 * client does not know the value, and a row carrying it would fail every read
 * that container makes of that membership. So the property this module holds is
 * that the roles a writer accepts and the roles a reader handles are different
 * sets, named separately, and the difference is one value.
 *
 * Every membership-role writer reads `ASSIGNABLE_TENANT_ROLES` (or a narrower
 * list of its own, like SCIM's ceiling) instead of spelling the roles out, and
 * `tests/unit/ai-admin-role-writers.test.ts` holds the census of what names
 * the value. Deploy 2 adds `AI_ADMIN` here for the members-page path only; SCIM,
 * Entra group mappings and SSO JIT keep their own narrower lists and never
 * produce it.
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
 * The roles a membership-role WRITER may write in deploy 1 of #3699 — every
 * role except `AI_ADMIN`. The role-change usecase, invites (creation and
 * redemption), the members and invites routes' schemas and an access review's
 * MODIFY decision read it.
 *
 * Deploy 2 widens this to include `AI_ADMIN`, and that widening is the whole
 * of deploy 2's assignment change. It must NOT be derived from `Role`: a new
 * enum value is then unassignable by default, which is the order a rolling
 * deploy needs.
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
 * The refusal every writer gives for a role it may not write. One sentence, so
 * the API says the same thing whichever writer was asked.
 */
export function unassignableRoleMessage(role: string): string {
    if (!(TENANT_ROLES as readonly string[]).includes(role)) return `Invalid role: ${role}`;
    return (
        `The ${role} role cannot be assigned yet. It exists so that every part of ` +
        'the product can read it before anything writes it; assignment arrives in a ' +
        'later release.'
    );
}
