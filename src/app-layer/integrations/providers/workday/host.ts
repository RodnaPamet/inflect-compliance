/**
 * Where a Workday connection is allowed to send credentials.
 *
 * THE HOLE THIS CLOSES. Both the token exchange and the roster read take
 * `host` from `configJson` and send a secret to it — client credentials in a
 * Basic header, and a live bearer access token respectively.
 * `upsertIntegrationConnection` (usecases/integrations.ts) writes configJson
 * VERBATIM as a Prisma.InputJsonValue: no host check, for any provider. The
 * only gate is `admin.manage`.
 *
 * So without this, a tenant admin could point `host` at a domain they control
 * and the platform would POST Workday client credentials to it, then send a
 * bearer token after. That is credential exfiltration reachable by a role that
 * is meant to configure an integration, not to redirect its secrets.
 *
 * `safeUrl` in bounded-fetch does NOT cover this — it redacts URLs for logging.
 *
 * ═══ THIS IS NOW A DELEGATION, AND THAT IS THE POINT ═══
 *
 * This module used to carry its own copy of the domain list. Its own docstring
 * said so, and said the general fix — a per-provider schema over configJson —
 * did not exist yet.
 *
 * It does now: `config-schema.ts` validates `host` as a `vendorOrigin` against
 * `WORKDAY_HOSTS`. That left two lists with the same contents and different
 * consumers — config validation read one, and the two secret-bearing request
 * paths read the other.
 *
 * Identical contents made it look harmless. It was not: the failure is a LATER
 * edit to one list, and it fails in the direction that hides. Add a domain to
 * `WORKDAY_HOSTS` only and config accepts a host that the roster read then
 * refuses at request time — an integration that validates and then does not
 * work. Add it here only and a host reaches a credential-bearing request
 * without ever passing the schema that is supposed to be the gate.
 *
 * One list now. This function survives because nine call sites read better for
 * naming the vendor, and because a bare hostname is the right return for
 * callers that must not reintroduce a scheme.
 *
 * @module integrations/providers/workday/host
 */
import { assertAllowedHost, WORKDAY_HOSTS } from '../../allowed-host';

/**
 * Normalise a config-supplied Workday host and refuse anything off-domain.
 *
 * Returns the bare hostname (no scheme, no trailing slash, no port) so callers
 * cannot accidentally reintroduce a scheme. Throws rather than returning a
 * fallback: there is no safe default host for a secret-bearing request, and a
 * silent fallback would send the credential somewhere the operator did not
 * name.
 *
 * Deliberately NOT `resolveVendorOrigin` — these callers want a hostname to
 * compose themselves, not a full origin.
 */
export function assertWorkdayHost(raw: string): string {
    return assertAllowedHost(raw, WORKDAY_HOSTS);
}
