/**
 * Only a custom role based on ADMIN may hold `personnel.manage` (#4536, owner
 * decision 2026-10-30).
 *
 * The built-in defaults give `personnel.manage` to OWNER and ADMIN only, and
 * since #4503 the roster READ (`personnel.view`) is theirs alone too. A custom
 * role could still store `manage: true` on a READER, EDITOR or AUDITOR base,
 * and #4520 switched `view` off on those bases, so such a role could create
 * roster records it could not list. The owner chose to refuse it: the Roles
 * page stops offering it on other bases, `createCustomRole` / `updateCustomRole`
 * refuse it, and a migration switches off the stored grants.
 *
 * Client-safe: no server imports, so the Roles page applies the same rule.
 */

/** The refusal reason, in `error.details.reason`. */
export const PERSONNEL_MANAGE_NEEDS_ADMIN_BASE = 'PERSONNEL_MANAGE_NEEDS_ADMIN_BASE' as const;

/** Whether a custom role on this base role may hold `personnel.manage`. */
export function mayHoldPersonnelManage(baseRole: string): boolean {
    return baseRole === 'ADMIN';
}

/** Whether a stored or submitted permission blob states `personnel.manage: true`. */
export function statesPersonnelManage(permissionsJson: unknown): boolean {
    const personnel = (permissionsJson as { personnel?: { manage?: unknown } } | null)?.personnel;
    return personnel?.manage === true;
}

/** True when a parsed API error body is this refusal. */
export function isPersonnelManageRefusal(body: unknown): boolean {
    return (body as { error?: { details?: { reason?: unknown } } } | null)?.error?.details?.reason
        === PERSONNEL_MANAGE_NEEDS_ADMIN_BASE;
}
