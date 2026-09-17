/**
 * Where an OrangeHRM connection is allowed to send its credentials.
 *
 * Both the token exchange and the roster read take `baseUrl` from `configJson`
 * and send a secret to it — the OAuth2 client credentials in a Basic header,
 * and a live bearer access token respectively.
 * `upsertIntegrationConnection` writes `configJson` through
 * `validateProviderConfig`, and that classification (`vendorOrigin` +
 * `ORANGEHRM_HOSTS`) is the same list this function reads. ONE list, for the
 * reason `providers/workday/host.ts` spells out at length: config validation
 * and the credential-bearing request path reading two copies is a divergence
 * that fails in the direction that hides.
 *
 * Deliberately NOT `resolveVendorOrigin` — callers here want a hostname to
 * compose a path onto, not a full origin, and nothing about this provider needs
 * a port or a non-https scheme in production.
 *
 * @module integrations/providers/orangehrm/host
 */
import { assertAllowedHost, ORANGEHRM_HOSTS } from '../../allowed-host';

/**
 * Normalise a config-supplied OrangeHRM host and refuse anything off-domain.
 *
 * Accepts either a bare hostname or a full URL, because an operator copying
 * their instance address out of a browser bar will paste the latter. Returns
 * the bare hostname so a caller cannot reintroduce a scheme by accident, and
 * throws rather than falling back — there is no safe default host for a
 * request that carries a credential.
 */
export function assertOrangeHrmHost(raw: string): string {
    return assertAllowedHost(raw, ORANGEHRM_HOSTS);
}
