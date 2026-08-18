/**
 * Where a connection is allowed to send its credentials.
 *
 * THE HOLE THIS CLOSES. Several providers take a host from `configJson` and
 * then send a secret to it — OAuth2 client credentials in a Basic header, a
 * live bearer access token, a basic-auth password.
 * `upsertIntegrationConnection` (usecases/integrations.ts) writes configJson
 * VERBATIM as a `Prisma.InputJsonValue`: no zod schema, no validation, no host
 * check, for any provider. The only gate is `admin.manage`.
 *
 * So without this, a tenant admin can point the host at a domain they control
 * and the platform hands over the credential — exfiltration reachable by a role
 * meant to CONFIGURE an integration, not to redirect its secrets.
 *
 * `safeUrl` in bounded-fetch does not cover this: it redacts URLs for logging.
 * Nothing else in the layer validates a config-supplied host.
 *
 * SCOPE. This is the SPECIFIC fix, enforced at the call sites that ship a
 * secret. The general fix — a per-provider zod schema at the
 * `upsertIntegrationConnection` boundary, so configJson is validated for every
 * provider and every field — is separate and larger. Host-shaped fields should
 * route through this when it lands, rather than each provider hand-rolling one.
 *
 * @module integrations/allowed-host
 */

/** One vendor's allowed hosts. */
export interface HostAllowlist {
    /** Vendor name, for error text: "Refusing to send <label> credentials…". */
    readonly label: string;
    /**
     * Allowed parent domains, matched on a LABEL BOUNDARY — each entry starts
     * with a dot for exactly that reason.
     */
    readonly suffixes: readonly string[];
    /** Apex names that have no subdomain label of their own. */
    readonly exact: readonly string[];
}

/**
 * PARSE, DO NOT STRING-MATCH.
 *
 * The inputs that matter read very differently to a regex than to the URL
 * resolver that will actually make the request:
 *
 *   evil-workday.com            a bare `endsWith('workday.com')` accepts it
 *   workday.com.attacker.net    contains the domain; is not under it
 *   acme.workday.com@evil.tld   userinfo — the real host is `evil.tld`, and
 *                               a substring check sees a legitimate domain
 *
 * The first two are the ones everybody remembers. The third is the one nobody
 * does, and it is the one that looks correct in review.
 *
 * Returns the bare hostname — no scheme, no port, no trailing slash — so a
 * caller cannot reintroduce a scheme by accident. THROWS rather than falling
 * back: there is no safe default host for a secret-bearing request, and a
 * silent fallback would send the credential somewhere the operator never named.
 */
export function assertAllowedHost(raw: string, allow: HostAllowlist): string {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) throw new Error(`${allow.label} host is required`);

    let hostname: string;
    try {
        const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
        const url = new URL(withScheme);
        if (url.username || url.password) {
            throw new Error(`${allow.label} host must not carry credentials`);
        }
        hostname = url.hostname.toLowerCase();
    } catch (err) {
        if (err instanceof Error && err.message.includes('must not carry')) throw err;
        throw new Error(`Invalid ${allow.label} host: ${trimmed}`);
    }

    const ok =
        allow.exact.includes(hostname) ||
        allow.suffixes.some((s) => hostname.endsWith(s));
    if (!ok) {
        // Names the rejected host so an operator who fat-fingered their
        // instance URL can see what was refused, without hinting at how to get
        // around it.
        // Phrased without an article before the vendor label — "not a Okta
        // domain" is what the obvious wording produces, and an error message a
        // customer sees while being told their credentials were withheld is
        // the wrong place to look sloppy.
        throw new Error(
            `Refusing to send ${allow.label} credentials to "${hostname}": not a recognised ${allow.label} host. ` +
                `Expected a host under ${allow.suffixes.join(' or ')}.`,
        );
    }
    return hostname;
}

/** Workday tenant hosts, including the SUV (implementation) estate. */
export const WORKDAY_HOSTS: HostAllowlist = {
    label: 'Workday',
    suffixes: ['.workday.com', '.workdaysuv.com'],
    exact: ['workday.com', 'workdaysuv.com'],
};

/**
 * ServiceNow instance hosts.
 *
 * `.service-now.com` is the commercial estate. `.servicenowservices.com` is
 * the US federal / regulated estate (SNC Government Community Cloud) — a
 * separate domain entirely, and omitting it would lock out exactly the
 * customers most likely to be buying a compliance product.
 */
export const SERVICENOW_HOSTS: HostAllowlist = {
    label: 'ServiceNow',
    suffixes: ['.service-now.com', '.servicenowservices.com'],
    exact: ['service-now.com', 'servicenowservices.com'],
};

/**
 * Okta org hosts, including the preview (sandbox) estate.
 *
 * Already the data behind `PROVIDER_BY_HOST_SUFFIX`'s okta entries — repeated
 * here rather than shared with it because the two answer different questions.
 * That table decides a metric LABEL and may reasonably grow entries for hosts
 * we merely observe; this one decides where a credential may be SENT, and must
 * only ever shrink or grow deliberately. Deriving one from the other would make
 * an observability edit a security change.
 */
export const OKTA_HOSTS: HostAllowlist = {
    label: 'Okta',
    suffixes: ['.okta.com', '.oktapreview.com'],
    exact: ['okta.com', 'oktapreview.com'],
};
