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
 * Why a hand-off could not be redeemed (#4924). Each asks something different
 * of the person, so the completion page says which:
 *   - `MISSING`: the browser sent no hand-off (cookies blocked, or finished in
 *     another browser than the one that started);
 *   - `EXPIRED`: it outlived its 60 seconds;
 *   - `USED`: no such hand-off — already redeemed (a second tab, a refresh),
 *     or never issued. A redeemed row is deleted, so the two look alike.
 */
export const SSO_HANDOFF_REFUSALS = ['MISSING', 'EXPIRED', 'USED'] as const;
export type SsoHandoffRefusal = (typeof SSO_HANDOFF_REFUSALS)[number];

const SSO_HANDOFF_REFUSAL_PREFIX = 'sso_handoff_';

/** The error the hand-off provider throws, which NextAuth hands to `signIn`. */
export function ssoHandoffRefusalCode(reason: SsoHandoffRefusal): string {
    return `${SSO_HANDOFF_REFUSAL_PREFIX}${reason}`;
}

/** The refusal named by a `signIn` error, or `null` for any other failure. */
export function parseSsoHandoffRefusal(error: string | null | undefined): SsoHandoffRefusal | null {
    if (!error?.startsWith(SSO_HANDOFF_REFUSAL_PREFIX)) return null;
    const reason = error.slice(SSO_HANDOFF_REFUSAL_PREFIX.length);
    return (SSO_HANDOFF_REFUSALS as readonly string[]).includes(reason)
        ? (reason as SsoHandoffRefusal)
        : null;
}

/** A workspace slug as `/login?sso=` takes it, or `null`. */
export function ssoWorkspaceParam(value: unknown): string | null {
    return typeof value === 'string' && value.length <= 100 && /^[a-z0-9][a-z0-9-]*$/.test(value)
        ? value
        : null;
}

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
