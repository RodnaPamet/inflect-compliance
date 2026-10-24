/**
 * Single sign-on sessions: the names the hand-off shares between the SSO
 * callbacks, NextAuth and the browser, and the rule that scopes the session it
 * produces.
 *
 * Pure and dependency-free, so the client completion page and the edge can
 * import it. The server half — issuing and redeeming a hand-off — is
 * `src/lib/auth/sso-handoff.ts`.
 *
 * ## Why an SSO session is scoped to one workspace
 *
 * A tenant's identity provider is configured by that tenant's admin, so it can
 * assert any email address it likes. `linkExternalIdentity` links the asserted
 * address to an existing account when the account is a member of the tenant —
 * and an account can belong to several tenants. An unscoped session would let
 * tenant B's identity provider sign a person in to tenant A as well.
 *
 * So an IdP vouches for a person in its own tenant and nowhere else: the
 * session's claims carry only that tenant's membership and no organization
 * memberships, and every DB-backed gate refuses any other tenant or
 * organization for it. To reach another workspace the person signs in the way
 * that workspace trusts.
 */

/** The NextAuth Credentials provider that turns a hand-off into a session. */
export const SSO_HANDOFF_PROVIDER_ID = 'sso-handoff';

/** HttpOnly cookie carrying the raw hand-off from the SSO callback to NextAuth. */
export const SSO_HANDOFF_COOKIE = 'inflect_sso_handoff';

/**
 * Sent only to the NextAuth callback that redeems it, so no other route ever
 * receives the hand-off.
 */
export const SSO_HANDOFF_COOKIE_PATH = `/api/auth/callback/${SSO_HANDOFF_PROVIDER_ID}`;

/** The page the SSO callbacks send the browser to, to finish signing in. */
export const SSO_COMPLETE_PATH = '/login/sso-complete';

/**
 * True when a session opened by single sign-on is used on a tenant other than
 * the one whose identity provider opened it.
 *
 * `null` / `undefined` is a session that did not come from SSO. Any string —
 * even an empty one — is a scope, so a malformed value refuses every tenant
 * rather than none.
 */
export function isOutsideSsoScope(
    ssoTenantId: string | null | undefined,
    tenantId: string,
): boolean {
    return ssoTenantId != null && ssoTenantId !== tenantId;
}

/** The refusal every gate gives an SSO session outside its workspace. */
export const SSO_SCOPE_REFUSAL =
    "This session was opened by another workspace's single sign-on. Sign in again to use this workspace.";
