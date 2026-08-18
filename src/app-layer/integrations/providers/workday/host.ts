/**
 * Where a Workday connection is allowed to send credentials.
 *
 * THE HOLE THIS CLOSES. Both the token exchange and the roster read take
 * `host` from `configJson` and send a secret to it — client credentials in a
 * Basic header, and a live bearer access token respectively.
 * `upsertIntegrationConnection` (usecases/integrations.ts) writes configJson
 * VERBATIM as a Prisma.InputJsonValue: no zod schema, no validation, no host
 * check, for any provider. The only gate is `admin.manage`.
 *
 * So without this, a tenant admin could point `host` at a domain they control
 * and the platform would POST Workday client credentials to it, then send a
 * bearer token after. That is credential exfiltration reachable by a role that
 * is meant to configure an integration, not to redirect its secrets.
 *
 * `safeUrl` in bounded-fetch does NOT cover this — it redacts URLs for logging.
 * Nothing else in the layer validates a config-supplied host today, which is
 * why this lives beside the provider that needs it rather than pretending to
 * be a general fix. The general fix is a per-provider zod schema on configJson;
 * this is the specific one, and it is enforced at the two call sites that ship
 * a secret.
 *
 * @module integrations/providers/workday/host
 */

/**
 * Domains Workday actually serves tenants from.
 *
 * Suffix-matched on a LABEL boundary, so `evil-workday.com` and
 * `workday.com.attacker.net` are both refused — the two shapes a naive
 * `endsWith` would wave through.
 */
const ALLOWED_SUFFIXES = ['.workday.com', '.workdaysuv.com'] as const;

/** Exact hosts, for the apex names that have no subdomain label. */
const ALLOWED_EXACT = ['workday.com', 'workdaysuv.com'] as const;

/**
 * Normalise a config-supplied Workday host and refuse anything off-domain.
 *
 * Returns the bare hostname (no scheme, no trailing slash, no port) so callers
 * cannot accidentally reintroduce a scheme. Throws rather than returning a
 * fallback: there is no safe default host for a secret-bearing request, and a
 * silent fallback would send the credential somewhere the operator did not
 * name.
 */
export function assertWorkdayHost(raw: string): string {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) throw new Error('Workday host is required');

    // Parse rather than string-munge: a bare `evil.com#@wd.workday.com` or a
    // userinfo segment (`user@evil.com`) reads very differently to a regex
    // than it does to the URL resolver that will actually make the request.
    let hostname: string;
    try {
        const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
        const url = new URL(withScheme);
        if (url.username || url.password) {
            throw new Error('Workday host must not carry credentials');
        }
        hostname = url.hostname.toLowerCase();
    } catch (err) {
        if (err instanceof Error && err.message.includes('must not carry')) throw err;
        throw new Error(`Invalid Workday host: ${trimmed}`);
    }

    const ok =
        ALLOWED_EXACT.includes(hostname as (typeof ALLOWED_EXACT)[number]) ||
        ALLOWED_SUFFIXES.some((s) => hostname.endsWith(s));
    if (!ok) {
        // Names the host so an operator who fat-fingered their tenant URL can
        // see what was rejected, without hinting at how to get around it.
        throw new Error(
            `Refusing to send Workday credentials to "${hostname}": not a Workday domain. ` +
                `Expected a host under ${ALLOWED_SUFFIXES.join(' or ')}.`,
        );
    }
    return hostname;
}
