/**
 * Whether a connection is a legacy application connection, for the cards on the
 * connection page that apply only to one.
 *
 * Decided from the connection's PROVIDER rather than from whether it happens to
 * carry an endpoint, so an `entra-id` connection shows nothing instead of an
 * error about a missing credential.
 *
 * The provider is the one the page already reads from the executions route's
 * `connection` header (#4870), handed down by the page. This used to be a hook
 * that downloaded the WHOLE connection list (`GET /admin/integrations`,
 * `admin.manage`) on every visit to find one row's provider (#5313): a member
 * admitted to /admin without `admin.manage` wrote an AUTHZ_DENIED row per
 * visit, and because a failed list read counted as "unknown", the mapping card
 * then appeared on Okta and Entra pages too.
 *
 *   undefined  the page has not read the connection yet;
 *   null       the page's read failed, so the provider is not known.
 *
 * Only a provider KNOWN to be `legacy-mcp` makes a card apply: when the page's
 * read failed, the page already says so, and a card asserting the connection
 * is a legacy one would be a guess.
 */

export const LEGACY_PROVIDER = 'legacy-mcp';

export function isLegacyConnection(provider: string | null | undefined): boolean {
    return provider === LEGACY_PROVIDER;
}
