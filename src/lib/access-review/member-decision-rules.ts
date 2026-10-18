/**
 * What a MEMBER campaign may do to a membership, and the names it refuses by
 * (#3727, owner decisions of 2026-10-18).
 *
 * Closing a member campaign writes its REVOKE and MODIFY decisions to live
 * memberships under `access_reviews.close`, which an ADMIN holds. Before #3727
 * that made a campaign a side door around every OWNER-tier rule on the members
 * page: an ADMIN could create a campaign over themselves, MODIFY themselves to
 * OWNER and close it; demote or revoke an OWNER; or hand a member an existing
 * custom role with no `assertGrantWithinOwnAuthority`. So:
 *
 *   1. A campaign never promotes anyone to OWNER (`CAMPAIGN_MODIFY_ROLES`).
 *   2. Demoting or revoking an OWNER membership needs a closer holding
 *      `admin.owner_management`. The last-OWNER guard applies as well.
 *   3. A MODIFY sets a built-in role only, never a custom role.
 *
 * Each is refused at submission where the decision alone shows it (1, 3), and
 * at close for every stored decision — an open campaign decided before the
 * rule is refused, never applied and never dropped.
 *
 * No server imports, so a client component can hold it.
 */

/** The named reasons, carried in `error.details.reason` and the refusal's audit row. */
export const MEMBER_DECISION_REFUSAL = {
    NEVER_PROMOTES_TO_OWNER: 'CAMPAIGN_NEVER_PROMOTES_TO_OWNER',
    MODIFY_SETS_NO_CUSTOM_ROLE: 'CAMPAIGN_MODIFY_SETS_NO_CUSTOM_ROLE',
    OWNER_SUBJECT_NEEDS_OWNER_CLOSER: 'OWNER_SUBJECT_NEEDS_OWNER_CLOSER',
} as const;

export type MemberDecisionRefusal = (typeof MEMBER_DECISION_REFUSAL)[keyof typeof MEMBER_DECISION_REFUSAL];

export const MEMBER_DECISION_REFUSAL_MESSAGE: Readonly<Record<MemberDecisionRefusal, string>> = {
    CAMPAIGN_NEVER_PROMOTES_TO_OWNER:
        'A campaign never promotes anyone to OWNER: an OWNER assigns that role on the members page.',
    CAMPAIGN_MODIFY_SETS_NO_CUSTOM_ROLE:
        'A campaign MODIFY sets a built-in role only, never a custom role: custom roles are assigned on the members page.',
    OWNER_SUBJECT_NEEDS_OWNER_CLOSER:
        'Demoting or revoking an OWNER membership through a campaign is an OWNER’s change: only an OWNER can close this campaign.',
};
