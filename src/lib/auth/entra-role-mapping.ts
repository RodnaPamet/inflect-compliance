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
    /** The winning role, or null when the user matched no *eligible* mapping. */
    role: Role | null;
    /** Every mapped group the user is actually in (for audit + the gate). */
    matchedGroupIds: string[];
    /**
     * The matched groups dropped from candidacy because their role sits above
     * `assignableRoles`. Empty whenever no ceiling was supplied.
     */
    clampedGroupIds: string[];
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
 * even though it is never a mappable target (see the Zod schema).
 */
const ROLE_SENIORITY: Record<Role, number> = {
    OWNER: 4,
    ADMIN: 3,
    EDITOR: 2,
    READER: 1,
    AUDITOR: 0,
};

/**
 * Resolve the IC role a user earns from their AAD security-group membership.
 *
 * Winner selection, in order: highest `priority`, then most-senior role, then
 * lowest `aadGroupId` (lexicographic) so the result is fully deterministic.
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
    if (matched.length === 0) return { role: null, matchedGroupIds: [], clampedGroupIds: [] };

    // `matchedGroupIds` stays the FULL matched set: the caller's group gate and
    // the audit row both mean "groups this user is actually in", which the
    // ceiling does not change.
    const matchedGroupIds = matched.map((m) => m.aadGroupId);

    const ceiling = options.assignableRoles;
    const eligible = ceiling ? matched.filter((m) => ceiling.includes(m.role)) : matched;
    const clampedGroupIds = ceiling
        ? matched.filter((m) => !ceiling.includes(m.role)).map((m) => m.aadGroupId)
        : [];

    if (eligible.length === 0) return { role: null, matchedGroupIds, clampedGroupIds };

    const winner = [...eligible].sort(
        (a, b) =>
            b.priority - a.priority ||
            ROLE_SENIORITY[b.role] - ROLE_SENIORITY[a.role] ||
            a.aadGroupId.localeCompare(b.aadGroupId),
    )[0];

    return { role: winner.role, matchedGroupIds, clampedGroupIds };
}
