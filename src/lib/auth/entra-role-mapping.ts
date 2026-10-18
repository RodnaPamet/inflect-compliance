/**
 * EI-2 — pure resolution of an IC role from a user's Entra group membership.
 *
 * Split out as a dependency-free function so both EI-2 (admin-UI "what role
 * would this user get?" preview) and EI-3 (sign-in enforcement) share one
 * deterministic ranking, and so it's exhaustively unit-testable.
 */
import type { Role } from '@prisma/client';

export interface GroupRoleMapping {
    aadGroupId: string;
    role: Role;
    priority: number;
}

export interface ResolvedGroupRole {
    /** The winning role, or null when the user matched no *eligible* mapping, or the top tie is ambiguous. */
    role: Role | null;
    /** Every mapped group the user is actually in (for audit + the gate). */
    matchedGroupIds: string[];
    /**
     * The matched groups dropped from candidacy because their role sits above
     * `assignableRoles`, or is one no mapping may yield
     * (`NEVER_GROUP_MAPPED_ROLES`). Empty when no ceiling was supplied and no
     * matched mapping names such a role.
     */
    clampedGroupIds: string[];
    /**
     * The groups of an equal-priority tie that seniority may not break — see
     * `TIE_DECIDABLE_AGAINST`. When non-empty, `role` is null: nothing is
     * decided, so the caller leaves the membership's role as it is. Empty
     * otherwise.
     */
    ambiguousGroupIds: string[];
}

export interface ResolveRoleOptions {
    /**
     * A ceiling on which mappings may WIN. Matched mappings whose role is not
     * in this list are dropped **before** the winner is picked.
     *
     * The "before" is the whole point. Refusing an out-of-ceiling winner at the
     * *call site* is not a clamp — it collapses to "no role at all", silently
     * discarding a legitimate lower mapping the same user matched. A user in
     * both an ADMIN-mapped and an EDITOR-mapped group must still resolve to
     * EDITOR, and a naive `winner.role === 'ADMIN'` guard cannot express that
     * (nor would it catch anything at all when READER — inside the ceiling —
     * happens to win).
     *
     * Omit for the sign-in path, where an admin-configured ADMIN mapping is a
     * deliberate product feature (`ENTRA_MAPPABLE_ROLES`).
     */
    assignableRoles?: readonly Role[];
}

/**
 * Role seniority, used only as a deterministic tie-breaker when two matched
 * mappings share the same `priority`. NOT an authority model — the admin's
 * explicit `priority` is the primary signal. OWNER is ranked for completeness
 * even though it is never a mappable target (see the Zod schema, and
 * `NEVER_GROUP_MAPPED_ROLES` below).
 *
 * AI_ADMIN (#3699) is ranked just above READER, and only READER: it is
 * READER's permission set plus the agent keys, so a tie it wins against READER
 * takes away nothing READER grants. Against every other role the rank is never
 * consulted — `TIE_DECIDABLE_AGAINST` makes such a tie ambiguous first.
 */
const ROLE_SENIORITY: Record<Role, number> = {
    OWNER: 5,
    ADMIN: 4,
    EDITOR: 3,
    AI_ADMIN: 2,
    READER: 1,
    AUDITOR: 0,
};

/**
 * Roles that sit OFF the tenant-wide seniority ladder, each with the roles a
 * priority tie may be broken against — an allowlist, so a role not named is
 * undecidable by default.
 *
 * AI_ADMIN is on a different axis from the ladder. EDITOR and ADMIN write
 * business data it cannot, AUDITOR shares audit packs and exports reports it
 * cannot, and it holds `admin.agent_ownership`, which none of them does — so
 * whichever way seniority broke a tie between it and one of them, the user
 * would silently lose a grant the tenant mapped to them on purpose. Such a tie
 * decides nothing: the resolver yields no role, the membership keeps the one
 * it has, and the caller reports the groups. The admin settles it the way the
 * product already asks them to settle every conflict — with `priority`. A
 * mapping with a higher priority still wins outright, in either direction.
 *
 * READER is the one role it may beat, because AI_ADMIN contains READER.
 */
const TIE_DECIDABLE_AGAINST: Partial<Record<Role, readonly Role[]>> = {
    AI_ADMIN: ['READER'],
};

/**
 * Roles a group mapping can NEVER yield, whatever row is stored and whatever
 * ceiling the caller passes — the read-side half of the schema's exclusion
 * (`ENTRA_MAPPABLE_ROLES`), so a row written around the schema still cannot
 * confer the role at sign-in or through a SCIM Groups push. Dropped mappings
 * are reported in `clampedGroupIds`, like a ceiling's.
 *
 * OWNER: ownership carries tenant lifecycle and owner management and stays
 * manually granted. The list held `AI_ADMIN` in deploy 1 of #3699, when no
 * group could confer that role either; deploy 2 made it mappable (owner
 * decision, 2026-10-18) and the list kept the one role the schema still
 * excludes rather than going empty — the resolver used to promote a stored
 * OWNER row, and it is the same defence. `tests/unit/entra-role-mapping.test.ts`
 * asserts it is exactly the complement of the schema's list.
 */
export const NEVER_GROUP_MAPPED_ROLES: readonly Role[] = ['OWNER'];

/**
 * Resolve the IC role a user earns from their AAD security-group membership.
 *
 * Winner selection, in order: highest `priority`, then most-senior role, then
 * lowest `aadGroupId` (lexicographic) so the result is fully deterministic —
 * except that a top-priority tie seniority may not break (`TIE_DECIDABLE_AGAINST`)
 * yields no role and reports the tied groups in `ambiguousGroupIds`.
 * Returns `{ role: null }` when no mapping matches — the caller decides what
 * that means (no change, or denial under `enforceGroupGate`).
 *
 * Pass `options.assignableRoles` to clamp the candidate pool (SCIM Groups push
 * does; sign-in does not). See `ResolveRoleOptions`.
 */
export function resolveRoleFromGroups(
    aadGroups: readonly string[],
    mappings: readonly GroupRoleMapping[],
    options: ResolveRoleOptions = {},
): ResolvedGroupRole {
    const groupSet = new Set(aadGroups);
    const matched = mappings.filter((m) => groupSet.has(m.aadGroupId));
    if (matched.length === 0) {
        return { role: null, matchedGroupIds: [], clampedGroupIds: [], ambiguousGroupIds: [] };
    }

    // `matchedGroupIds` stays the FULL matched set: the caller's group gate and
    // the audit row both mean "groups this user is actually in", which the
    // ceiling does not change.
    const matchedGroupIds = matched.map((m) => m.aadGroupId);

    const ceiling = options.assignableRoles;
    const mayWin = (role: Role) =>
        !NEVER_GROUP_MAPPED_ROLES.includes(role) && (!ceiling || ceiling.includes(role));
    const eligible = matched.filter((m) => mayWin(m.role));
    const clampedGroupIds = matched.filter((m) => !mayWin(m.role)).map((m) => m.aadGroupId);

    if (eligible.length === 0) {
        return { role: null, matchedGroupIds, clampedGroupIds, ambiguousGroupIds: [] };
    }

    // Only the TOP priority can be ambiguous: a lower tier is outranked by an
    // explicit admin choice, so falling through to it would be guessing.
    const topPriority = Math.max(...eligible.map((m) => m.priority));
    const topTier = eligible.filter((m) => m.priority === topPriority);
    const tierRoles = [...new Set(topTier.map((m) => m.role))];
    const undecidable = tierRoles.some((role) => {
        const decidable = TIE_DECIDABLE_AGAINST[role];
        return decidable !== undefined && tierRoles.some((other) => other !== role && !decidable.includes(other));
    });
    if (undecidable) {
        return {
            role: null,
            matchedGroupIds,
            clampedGroupIds,
            ambiguousGroupIds: topTier.map((m) => m.aadGroupId).sort(),
        };
    }

    const winner = [...topTier].sort(
        (a, b) =>
            ROLE_SENIORITY[b.role] - ROLE_SENIORITY[a.role] ||
            a.aadGroupId.localeCompare(b.aadGroupId),
    )[0];

    return { role: winner.role, matchedGroupIds, clampedGroupIds, ambiguousGroupIds: [] };
}
