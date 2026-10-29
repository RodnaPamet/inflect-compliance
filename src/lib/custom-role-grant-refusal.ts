/**
 * The refusal a custom-role write gets when the role would grant a permission
 * its author does not hold (#4467).
 *
 * "You cannot grant what you do not hold" is `assertGrantWithinOwnAuthority` in
 * `usecases/custom-roles.ts`, asked on create, update and assign. Its message
 * names the permissions as engineering keys (`admin.tenant_lifecycle`), which
 * the custom roles page used to show the user verbatim. The refusal now also
 * carries this reason and the keys in `error.details`, so the page can name
 * the permissions by their grid labels in the user's language.
 *
 * Client-safe: no server imports, so the roles page can read the reason.
 */
export const CUSTOM_ROLE_GRANT_EXCEEDS_HOLDER = 'CUSTOM_ROLE_GRANT_EXCEEDS_HOLDER' as const;

/**
 * The permission keys (`domain.action`) a parsed API error body names, when it
 * is this refusal; `null` for any other body.
 */
export function grantExceedingKeys(body: unknown): string[] | null {
    const details = (
        body as { error?: { details?: { reason?: unknown; exceeded?: unknown } } } | null
    )?.error?.details;
    if (details?.reason !== CUSTOM_ROLE_GRANT_EXCEEDS_HOLDER) return null;
    return Array.isArray(details.exceeded)
        ? details.exceeded.filter((k): k is string => typeof k === 'string')
        : [];
}
