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
 * Which roles never sit under a custom role is a separate rule with its own
 * list, `BUILT_IN_SCOPE_ROLES`: `AI_ADMIN` since #3699, and `OWNER` since
 * #3720. Its census is `tests/unit/owner-custom-role.test.ts`.
 *
 * Which custom roles only an ADMIN membership may carry is a third rule
 * (owner decisions, 2026-10-30): one granting one of ten admin keys
 * (`ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS`), and one built on ADMIN
 * (`customRoleCarriageRefusal`). Its census is
 * `tests/unit/custom-role-carriage-writers.test.ts`.
 *
 * Client-safe: the only Prisma dependency is an `import type`.
 */
import type { Role } from '@prisma/client';
import { parsePermissionsJson, type PermissionSet } from '@/lib/permissions';

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
 * The roles an access-review MODIFY may set (#3727, owner decision 1 of
 * 2026-10-18): the writers' list minus OWNER. A campaign never promotes anyone
 * to OWNER; an OWNER assigns it on the members page, as for AI_ADMIN. The
 * schema refuses OWNER by name (`CAMPAIGN_NEVER_PROMOTES_TO_OWNER`) rather
 * than by enum, and so does the close for a decision stored before the rule;
 * the decision modal offers only these.
 */
export const CAMPAIGN_MODIFY_ROLES = [
    'ADMIN',
    'EDITOR',
    'AUDITOR',
    'READER',
] as const satisfies readonly AssignableTenantRole[];

export type CampaignModifyRole = (typeof CAMPAIGN_MODIFY_ROLES)[number];

export function isCampaignModifyRole(role: string): role is CampaignModifyRole {
    return (CAMPAIGN_MODIFY_ROLES as readonly string[]).includes(role);
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
 *
 * On the members page the same holder alone DEACTIVATES or REMOVES a
 * membership holding one of these (`deactivateTenantMember`,
 * `removeTenantMember`; AI_ADMIN since #4118). A SCIM deprovision is its own
 * rule (`isScimStatusProtectedRole`).
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
 * The named reason a deactivation or removal of an OWNER-managed membership is
 * refused with when the caller lacks `admin.owner_management`
 * (`ForbiddenError.details`). Ending an OWNER's membership has been an OWNER's
 * act since the role change asked it; an AI_ADMIN's joined it in #4118 (owner
 * decision): an ADMIN, who can neither assign nor remove the role, does not get
 * to switch the membership off or delete it instead.
 */
export const OWNER_MANAGED_MEMBERSHIP_END_REFUSAL = 'ENDING_OWNER_MANAGED_MEMBERSHIP_IS_OWNER_TIER' as const;

/** The refusal for deactivating or removing an owner-managed membership without the key. */
export function ownerManagedMembershipEndMessage(role: string, verb: 'deactivate' | 'remove'): string {
    // OWNER keeps the sentence it has always had.
    if (role === 'OWNER') return `Only OWNERs can ${verb} an OWNER membership.`;
    return `Only an OWNER can ${verb} an ${role} membership.`;
}

/**
 * The named reason revoking another person's sessions is refused with when
 * that person holds an OWNER-managed role and the caller lacks
 * `admin.owner_management` (`ForbiddenError.details`; owner decision,
 * 2026-10-25). Signing one person out is a targeted act, so it follows the
 * deactivation rule above. "Revoke All" is the incident lever and still signs
 * everyone out, Owners included.
 */
export const OWNER_MANAGED_SESSION_REVOKE_REFUSAL = 'REVOKING_OWNER_MANAGED_SESSIONS_IS_OWNER_TIER' as const;

/** The refusal for revoking an owner-managed member's sessions without the key. */
export function ownerManagedSessionRevokeMessage(role: string): string {
    return `Only an OWNER can revoke an ${role}'s sessions.`;
}

/**
 * Roles whose scope is always the reviewed built-in set: a membership holding
 * one never carries a custom role. A custom role REPLACES the built-in role's
 * permissions and coarse tier at resolution (`resolveTenantContext` reads
 * `customRole.baseRole ?? role`), so a membership holding one of these and a
 * custom role would not hold the role at all.
 *
 *   - `AI_ADMIN` — #3699 deploy 2, owner decision 2 (2026-10-18).
 *   - `OWNER` — #3720, owner decision 1 (2026-10-18). On an OWNER the custom
 *     role was a side door: an ADMIN could assign a READER-based one and so
 *     demote every OWNER in effect, with the enum role still reading `OWNER`,
 *     so neither the last-OWNER checks nor `tenant_membership_last_owner_guard`
 *     fired — the demotion `admin.owner_management` exists to reserve.
 *
 * Both orders are refused rather than repaired, for every caller, OWNER
 * included: a custom role is not assigned to such a membership, and a member
 * carrying one is not moved into the role — the custom role is removed first,
 * by a person, as its own audited change. Every writer reads this list: the
 * members-page role change and custom-role assignment, ownership transfer,
 * invite creation and both redemptions, and the Entra group sync. An access
 * review's MODIFY cannot reach the combination at all: it never sets OWNER
 * (`CAMPAIGN_MODIFY_ROLES`) and never sets a custom role (#3727).
 *
 * The database holds the same rule as a CHECK,
 * `TenantMembership_built_in_scope_role_no_custom_role`
 * (`prisma/migrations/20261018180000_built_in_scope_role_no_custom_role`). A
 * role added here needs that CHECK widened in a migration in the same change.
 */
export const BUILT_IN_SCOPE_ROLES = ['OWNER', 'AI_ADMIN'] as const satisfies readonly Role[];

export function mayCarryCustomRole(role: string): boolean {
    return !(BUILT_IN_SCOPE_ROLES as readonly string[]).includes(role);
}

/** The named reason a role/custom-role combination is refused with (`ConflictError.details`). */
export const BUILT_IN_SCOPE_REFUSAL = 'BUILT_IN_SCOPE_ROLE_CARRIES_NO_CUSTOM_ROLE' as const;

/**
 * The refusal, worded for the change that was asked for: assigning a custom
 * role to a membership that holds `role`, promoting a member who carries a
 * custom role into it, or inviting into it a person whose existing (inactive)
 * membership carries one.
 */
export function builtInScopeRoleMessage(
    role: string,
    asked: 'assign-custom-role' | 'promote' | 'invite',
): string {
    const why = `A membership with the ${role} role cannot carry a custom role: its scope is always the built-in one.`;
    if (asked === 'promote') return `${why} Remove this member's custom role first, then change the role.`;
    if (asked === 'invite') {
        return (
            `${why} This person's existing membership carries a custom role. Invite them with another ` +
            'role, remove the custom role once they have joined, then change their role.'
        );
    }
    return `${why} Change the member to another role first if they need a custom role.`;
}

/**
 * Whether CLEARING a custom role from a membership holding `role` is OWNER-tier
 * work — allowed only to a holder of `admin.owner_management` (#3720).
 *
 * True for `OWNER` alone. No writer can put a custom role on an OWNER any more,
 * so a clear there only ever repairs a legacy row; and it restores full OWNER
 * authority, which an ADMIN may not hand out. `AI_ADMIN` keeps what deploy 2 of
 * #3699 shipped — anybody holding `admin.members` may clear one — and no
 * AI_ADMIN row can carry a custom role in the first place (deploy 1 had no
 * writer, deploy 2's writers refuse it, and the CHECK refuses it).
 */
export function clearingCustomRoleIsOwnerTier(role: string): boolean {
    return role === 'OWNER';
}

/** The named reason an ADMIN's clear of an OWNER's custom role is refused with (`ForbiddenError.details`). */
export const OWNER_TIER_CLEAR_REFUSAL = 'CLEARING_OWNER_CUSTOM_ROLE_IS_OWNER_TIER' as const;

/** The refusal for clearing an OWNER membership's custom role without `admin.owner_management`. */
export function ownerTierClearMessage(): string {
    return 'Only an OWNER can remove a custom role from an OWNER membership: it restores full OWNER authority.';
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

// ─── Which custom roles only an ADMIN membership may carry ─────────────────

/**
 * The `admin.*` keys a custom role may grant only on an ADMIN membership, part
 * one: the six consumed ONLY behind the admin API (owner decision, 2026-10-30).
 *
 * The rule is the edge's, not a new one. `checkAdminAccess` admits
 * `/api/t/:slug/admin/**` by the membership's BUILT-IN role — OWNER and ADMIN,
 * AI_ADMIN on the agent paths, AUDITOR on five inventory GETs — and a custom
 * role never enters that check. Each key below is consumed ONLY behind that
 * surface: by a route under it, by a usecase only such a route reaches, or by a
 * page that turns it into a button whose request goes there. So on an EDITOR,
 * READER or AUDITOR membership a custom role granting one of them granted
 * nothing: the pages offered a control and the edge answered every press with
 * a 403. Refusing these six takes away nothing such a membership could use.
 *
 *   - `sso` — no code consults it at all. SSO configuration takes
 *     `admin.manage`; the key is in `PermissionSet` and `admin:write` and
 *     nothing reads it.
 *   - `agent_tool_exposure` — granting and revoking an agent's tools, and
 *     reading its grants: `…/admin/agents/[agentId]/tools` only. An access
 *     review's narrowing deletes a grant through the repository under
 *     `access_reviews.decide`, not this key.
 *   - `agent_policy_card` — reading and writing an agent's policy card:
 *     `…/admin/agents/[agentId]/policy-card` only.
 *   - `agent_ownership` — the two-step agent ownership transfer:
 *     `…/admin/agents/[agentId]/ownership-transfer` only. Its recipient check
 *     (`TRANSFER_RECIPIENT_MEMBERSHIP_ROLES`) already refuses an EDITOR,
 *     READER or AUDITOR membership whatever custom role it carries.
 *   - `agent_skill_review` and `agent_skill_author` — a tenant skill's review
 *     and authoring: `…/admin/agents/skills/tenant/**` only.
 *
 * None of the five agent keys can be carried by a bearer token either
 * (`scopesToPermissions` subtracts them from `*` and no scope maps to them),
 * so a key acting for such a membership, which skips the edge's role gate,
 * cannot reach them. `admin.sso` can be, through `admin:write`, and nothing
 * reads it there either.
 *
 * `tests/guardrails/admin-membership-only-keys-are-dead-elsewhere.test.ts`
 * fails when one of these six gains a consumer outside the admin API.
 */
export const ADMIN_API_ONLY_KEYS = [
    'sso',
    'agent_tool_exposure',
    'agent_policy_card',
    'agent_ownership',
    'agent_skill_review',
    'agent_skill_author',
] as const satisfies readonly (keyof PermissionSet['admin'])[];

/**
 * Part two: four keys refused BY DECISION (owner decision, 2026-10-30). Unlike
 * the six above they are NOT dead outside the admin API. A custom role on an
 * EDITOR, READER or AUDITOR membership reached each of them by a path that goes
 * around the edge's role gate, and that side door is the reason they are
 * refused: the edge says such a membership does no admin work, and a custom
 * role should not buy it back through a credential or a run.
 *
 *   - `scim` — the SCIM token and settings at `…/admin/scim`, through an
 *     agent-bound API key acting for the membership with `admin:write`, `admin:*`
 *     or `*`. The edge lets an `iflk_` bearer through, and the route checks the
 *     key's permissions, which are the membership's intersected with the
 *     scopes.
 *   - `compliance_dsar_manage` — the DSAR register's writes at
 *     `…/admin/dsar-requests`, the same way, through a key with `*`.
 *   - `agent_harness_ingest` — posting a harness scan at
 *     `…/admin/agents/harness-scans` through a key with `admin:harness_ingest`,
 *     `admin:*` or `*`; and reading the register through the
 *     `get_harness_register` tool at `/api/mcp`.
 *   - `agent_external_tools` — every external tool call made for the
 *     membership: a run it starts at `/agent-runs`, which checks the starter's
 *     permissions, a key at `/api/mcp` with `admin:external_tools`, `admin:*` or
 *     `*`, and an agent's A2A send.
 *
 * So for these four the rule DOES take something away. Going forward, a
 * membership that is not ADMIN cannot be given a custom role granting one, and
 * migration `20261030150000_admin_membership_only_keys_off_for_non_admin_custom_roles`
 * switched them off in every stored role that only such memberships carried.
 * The paths above then refuse it as they refuse any member without the key:
 * the key's request answers 403, the run's or the tool call's is refused. The
 * nine other admin keys are consumed outside the admin API too, and keep
 * working as they did.
 */
export const SIDE_DOOR_ADMIN_KEYS = [
    'scim',
    'compliance_dsar_manage',
    'agent_harness_ingest',
    'agent_external_tools',
] as const satisfies readonly (keyof PermissionSet['admin'])[];

/**
 * Every `admin.*` key a custom role may grant only on an ADMIN membership: the
 * six only the admin API reads, and the four refused by decision. Writers, the
 * migration and the pages read this list; only the guardrail reads the parts.
 */
export const ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS = [
    ...ADMIN_API_ONLY_KEYS,
    ...SIDE_DOOR_ADMIN_KEYS,
] as const satisfies readonly (keyof PermissionSet['admin'])[];

export type AdminMembershipOnlyAdminKey = (typeof ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS)[number];

/**
 * The base roles whose coarse tier is the admin tier. A custom role's base IS
 * the role its carrier resolves to everywhere but the edge (`effectiveRole` in
 * `resolveTenantContext`), so a custom role built on one of these makes every
 * `assertCanAdmin` pass for a membership the edge treats as non-admin. No
 * writer builds a custom role on OWNER (`VALID_BASE_ROLES`, and the CHECK
 * `TenantCustomRole_base_role_not_built_in_scope`); it is here so a legacy one
 * is judged by its tier, not by its name.
 */
export const ADMIN_TIER_BASE_ROLES = ['ADMIN', 'OWNER'] as const satisfies readonly Role[];

/** The named reason a custom role granting an `ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS` key is refused with. */
export const CUSTOM_ROLE_ADMIN_KEYS_REFUSAL = 'CUSTOM_ROLE_ADMIN_KEYS_NEED_ADMIN_MEMBERSHIP' as const;

/** The named reason a custom role built on ADMIN is refused with. */
export const CUSTOM_ROLE_ADMIN_BASE_REFUSAL = 'CUSTOM_ROLE_ADMIN_BASE_NEEDS_ADMIN_MEMBERSHIP' as const;

/** The custom role as the rule reads it: its base and its stored blob. */
export interface CustomRoleForCarriage {
    baseRole: Role | string;
    permissionsJson: unknown;
}

/** A membership's built-in role and the custom role it carries (`null` for none). */
export interface CustomRoleCarriage {
    membershipRole: Role | string;
    customRole: CustomRoleForCarriage | null;
}

/** What a carriage breaks of the rule — empty when it breaks nothing. */
export interface CustomRoleCarriageOffence {
    /** The custom role's base, when it is an admin-tier base on a non-ADMIN membership. */
    adminBase: string | null;
    /** The `ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS` it grants on a non-ADMIN membership, in list order. */
    adminKeys: AdminMembershipOnlyAdminKey[];
}

/** The keys of `ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS` that `permissions` grants. */
export function adminMembershipOnlyKeysGranted(
    permissions: Pick<PermissionSet, 'admin'>,
): AdminMembershipOnlyAdminKey[] {
    return ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS.filter((key) => permissions.admin?.[key] === true);
}

/**
 * What `carriage` breaks of the rule. Only an ADMIN membership may carry a
 * custom role built on an admin-tier base or granting an
 * `ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS` key; on any other membership both are
 * offences. The keys are the custom role's EFFECTIVE grant — its blob parsed
 * over its base (`parsePermissionsJson`), exactly as a request resolves it —
 * so a legacy blob missing a key is judged by its base's default for it.
 *
 * OWNER and AI_ADMIN memberships carry no custom role at all
 * (`mayCarryCustomRole`); that rule is asked first and separately, and this one
 * judges them like any other non-ADMIN membership.
 */
export function customRoleCarriageOffence(carriage: CustomRoleCarriage): CustomRoleCarriageOffence {
    const none: CustomRoleCarriageOffence = { adminBase: null, adminKeys: [] };
    const { membershipRole, customRole } = carriage;
    if (!customRole || membershipRole === 'ADMIN') return none;
    const base = String(customRole.baseRole);
    return {
        adminBase: (ADMIN_TIER_BASE_ROLES as readonly string[]).includes(base) ? base : null,
        adminKeys: adminMembershipOnlyKeysGranted(
            parsePermissionsJson(customRole.permissionsJson, customRole.baseRole as Role),
        ),
    };
}

/** A refusal of the rule: its reason and what it names. */
export type CustomRoleCarriageRefusal =
    | { reason: typeof CUSTOM_ROLE_ADMIN_BASE_REFUSAL; baseRole: string }
    | { reason: typeof CUSTOM_ROLE_ADMIN_KEYS_REFUSAL; keys: AdminMembershipOnlyAdminKey[] };

/**
 * THE PREDICATE every writer asks: does moving a membership from `before` to
 * `after` ADD an offence (`customRoleCarriageOffence`)? `null` when it may.
 *
 * Only what is NEW is refused, so existing rows are never trapped. A change
 * that keeps or shrinks a membership's offence — clearing or replacing its
 * custom role, removing keys from the role, lowering its base, renaming it, or
 * moving the member between EDITOR, READER and AUDITOR (the rule treats the
 * three alike) — always passes, and no writer refuses a row for what it
 * already carried. (What a stored role carried was settled once, by the
 * migration that switched the ten keys off where only non-ADMIN memberships
 * carried the role; a role with an ADMIN carrier kept them.) `before` is
 * `null` for a membership that does not exist yet.
 *
 * The base refusal is returned first when both apply: a custom role built on
 * ADMIN grants nine of the ten keys by default, so fixing the base is the
 * change that decides what the keys are.
 */
export function customRoleCarriageRefusal(
    after: CustomRoleCarriage,
    before: CustomRoleCarriage | null,
): CustomRoleCarriageRefusal | null {
    const now = customRoleCarriageOffence(after);
    const was = before ? customRoleCarriageOffence(before) : { adminBase: null, adminKeys: [] };
    if (now.adminBase !== null && was.adminBase === null) {
        return { reason: CUSTOM_ROLE_ADMIN_BASE_REFUSAL, baseRole: now.adminBase };
    }
    const added = now.adminKeys.filter((key) => !was.adminKeys.includes(key));
    if (added.length > 0) return { reason: CUSTOM_ROLE_ADMIN_KEYS_REFUSAL, keys: added };
    return null;
}

/** The `ConflictError.details` of a refusal: the reason, and what it names. */
export function customRoleCarriageDetails(
    refusal: CustomRoleCarriageRefusal,
    extra: { blockingMemberships?: number } = {},
): Record<string, unknown> {
    return refusal.reason === CUSTOM_ROLE_ADMIN_BASE_REFUSAL
        ? { reason: refusal.reason, baseRole: refusal.baseRole, ...extra }
        : { reason: refusal.reason, keys: refusal.keys.map((k) => `admin.${k}`), ...extra };
}

/**
 * The refusal, worded for the change that was asked for: assigning the custom
 * role, changing the member's role while they carry it, inviting them back
 * into a membership that carries it, or saving the custom role while members
 * carry it (`blockingMemberships` of them).
 */
export function customRoleCarriageMessage(
    refusal: CustomRoleCarriageRefusal,
    asked: 'assign-custom-role' | 'change-role' | 'invite' | 'save-custom-role',
    blockingMemberships = 0,
): string {
    const what =
        refusal.reason === CUSTOM_ROLE_ADMIN_BASE_REFUSAL
            ? `A custom role built on ${refusal.baseRole}`
            : `A custom role granting ${refusal.keys.map((k) => `admin.${k}`).join(', ')}`;
    const why = `${what} can only be carried by an ADMIN membership.`;
    switch (asked) {
        case 'change-role':
            return `${why} Remove or change this member's custom role first, then change the role.`;
        case 'invite':
            return (
                `${why} This person's existing membership carries such a custom role. Invite them as ADMIN, ` +
                'or remove the custom role once they have joined.'
            );
        case 'save-custom-role':
            return (
                `${why} ${blockingMemberships} member(s) carrying this role hold another role. ` +
                'Change their role to ADMIN or give them another custom role first.'
            );
        default:
            return `${why} Change the member to ADMIN first, or choose another custom role.`;
    }
}
