/**
 * Per-provider validation of tenant-admin `configJson`, at the write boundary.
 *
 * ## Why this exists
 *
 * `configJson` was stored verbatim. No zod schema, no host allowlist, no type
 * check — a tenant admin submitted a JSON object and providers later read
 * arbitrary fields out of it and sent them to the network. That produced a
 * repeatable class of defect: Workday's `host` reached a token POST carrying
 * client credentials in a Basic header AND a roster read carrying a live Bearer
 * token; Okta's `orgUrl` reached four credentialed calls; Active Directory's
 * `url` was an LDAPS bind target sitting next to a config-controlled switch that
 * disabled certificate verification.
 *
 * Each was fixed at its call site. This is the boundary that stops the next one
 * being written in the first place.
 *
 * ## Allow-shaped, not deny-shaped
 *
 * Every declared field must carry a rule saying what it IS. A deny-list is the
 * wrong instrument here: ServiceNow's `sysparm_query` accepts `javascript:` and
 * `gs.`, evaluated server-side with the integration user's rights, and refusing
 * those two prefixes holds exactly until someone finds the third. Declaring
 * "this field is a ServiceNow encoded query" is a statement that stays true.
 *
 * ## Write-time only — and that is a real limit, not an oversight
 *
 * Everything here is a property of the STRING: its shape, its scheme, whether
 * its host is in a vendor allowlist. Where a name currently POINTS is a property
 * of the moment, not of the config, so it cannot be settled here. Active
 * Directory's `allowSelfSignedTls` is the worked example: validating at write
 * time that the host resolves into RFC1918 is true when written and says nothing
 * when the socket opens, and an AD deployment has exactly the DNS control needed
 * to make it stop being true. That check lives at the connect site
 * (`providers/active-directory/index.ts`), and must stay there.
 */
import { badRequest } from '@/lib/errors/types';
import {
    assertAllowedHost,
    OKTA_HOSTS,
    SERVICENOW_HOSTS,
    WORKDAY_HOSTS,
    type HostAllowlist,
} from './allowed-host';

export type ConfigFieldRule =
    /** No reach: an identifier, a threshold, a display toggle. */
    | { kind: 'inert' }
    /** A host that must belong to a known vendor. */
    | { kind: 'vendorOrigin'; allow: HostAllowlist }
    /**
     * A host that is CUSTOMER infrastructure, so no vendor allowlist can apply.
     * Only the scheme is settleable at write time.
     */
    | { kind: 'internalOrigin'; scheme: string }
    /** A filter that must remain a filter. */
    | { kind: 'boundedQuery'; check: (value: string) => string | null };

/**
 * ServiceNow encoded queries are evaluated SERVER-SIDE with the integration
 * user's rights — usually broader than the admin typing them into our UI. So a
 * config field is a script-execution primitive against the customer's own
 * instance, and no amount of host validation touches that class.
 */
function serviceNowQuery(value: string): string | null {
    const lowered = value.toLowerCase();
    if (lowered.includes('javascript:') || lowered.includes('gs.')) {
        return 'must not contain server-side script (javascript: or gs.)';
    }
    return null;
}

/**
 * Every field a provider DECLARES must appear here.
 *
 * `tests/guards/config-field-classification.test.ts` cross-walks this against
 * each registered provider's `configSchema.configFields`, so a new field cannot
 * be added without someone deciding what it is. That cross-walk is the point:
 * a hand-maintained list that nothing checks is the failure mode this replaces.
 */
export const CONFIG_FIELD_RULES: Record<string, Record<string, ConfigFieldRule>> = {
    'active-directory': {
        url: { kind: 'internalOrigin', scheme: 'ldaps:' },
        baseDN: { kind: 'inert' },
        adminGroups: { kind: 'inert' },
        // Deliberately inert HERE. The flag is dangerous, but the condition that
        // makes it safe (the host resolving into private space) is a
        // connect-time fact; see the module docblock.
        allowSelfSignedTls: { kind: 'inert' },
        bindDN: { kind: 'inert' },
        bindPassword: { kind: 'inert' },
        dormantDays: { kind: 'inert' },
        maxAdmins: { kind: 'inert' },
    },
    okta: {
        orgUrl: { kind: 'vendorOrigin', allow: OKTA_HOSTS },
        apiToken: { kind: 'inert' },
        dormantDays: { kind: 'inert' },
        enrichPerUser: { kind: 'inert' },
        maxAdmins: { kind: 'inert' },
    },
    workday: {
        host: { kind: 'vendorOrigin', allow: WORKDAY_HOSTS },
        tenant: { kind: 'inert' },
        clientId: { kind: 'inert' },
        clientSecret: { kind: 'inert' },
        reportPath: { kind: 'inert' },
    },
    servicenow: {
        instance: { kind: 'vendorOrigin', allow: SERVICENOW_HOSTS },
        table: { kind: 'inert' },
        username: { kind: 'inert' },
        password: { kind: 'inert' },
        windowDays: { kind: 'inert' },
        sysparm_query: { kind: 'boundedQuery', check: serviceNowQuery },
    },
    'entra-id': {
        tenantId: { kind: 'inert' },
        clientId: { kind: 'inert' },
        clientSecret: { kind: 'inert' },
        // Inert as a STRING — it reaches no host and carries no query. It is
        // nonetheless the most consequential field on this connection: the
        // Entra writer refuses to construct unless it is exactly `true`, so
        // this is what keeps a tenant that consented Graph write permissions
        // for some other purpose from being silently upgraded into one whose
        // leaver runs can disable any account in the directory.
        writesEnabled: { kind: 'inert' },
        enrichMfa: { kind: 'inert' },
        enrichFederation: { kind: 'inert' },
        dormantDays: { kind: 'inert' },
        maxAdmins: { kind: 'inert' },
    },
    'google-workspace': {
        domain: { kind: 'inert' },
        adminEmail: { kind: 'inert' },
        serviceAccountJson: { kind: 'inert' },
        enrichSso: { kind: 'inert' },
        dormantDays: { kind: 'inert' },
        maxAdmins: { kind: 'inert' },
    },
    hris: {
        // BambooHR interpolates this into {subdomain}.bamboohr.com, so a value
        // carrying a dot or slash escapes the intended host.
        subdomain: { kind: 'boundedQuery', check: (v) => (/^[a-z0-9-]+$/i.test(v) ? null : 'must be a bare subdomain (letters, digits, hyphens)') },
        apiKey: { kind: 'inert' },
    },
    sharepoint: {
        // SharePoint has no configSchema descriptor — it is not a registry
        // provider — so these come from SharePointConfigJson rather than from
        // declared configFields. All Microsoft-side identifiers; the host is
        // never taken from config (graph.microsoft.com is a constant).
        aadTenantId: { kind: 'inert' },
        allowedSiteIds: { kind: 'inert' },
        accessToken: { kind: 'inert' },
        defaultDriveId: { kind: 'inert' },
        // Written by the delta-import path, not by an admin: opaque
        // continuation tokens returned by Graph. Declared because the write is
        // a merge over the whole object, so an undeclared key here would make
        // that path fail validation.
        deltaTokens: { kind: 'inert' },
    },
    github: {
        owner: { kind: 'inert' },
        repo: { kind: 'inert' },
        branch: { kind: 'inert' },
        token: { kind: 'inert' },
        webhookSecret: { kind: 'inert' },
    },
};

/**
 * Validate a provider's configJson, or throw 400.
 *
 * An UNKNOWN provider is allowed through unchanged rather than rejected: the
 * registry is populated from provider descriptors, and failing closed on a
 * provider that has not been classified yet would break connection creation for
 * it. The classification guard is what makes that safe — it fails CI when a
 * registered provider is missing, so "unknown" cannot quietly become "unchecked"
 * for anything that actually ships.
 */
export function validateProviderConfig(
    providerId: string,
    configJson: unknown,
): Record<string, unknown> {
    if (configJson == null) return {};
    if (typeof configJson !== 'object' || Array.isArray(configJson)) {
        throw badRequest('Invalid configJson: must be a plain object');
    }
    const config = configJson as Record<string, unknown>;
    const rules = CONFIG_FIELD_RULES[providerId];
    if (!rules) return config;

    for (const [key, raw] of Object.entries(config)) {
        const rule = rules[key];
        if (!rule) {
            throw badRequest(`Unknown configuration field for ${providerId}: ${key}`);
        }
        if (raw == null || raw === '') continue;

        if (rule.kind === 'vendorOrigin') {
            try {
                assertAllowedHost(String(raw), rule.allow);
            } catch (err) {
                throw badRequest(err instanceof Error ? err.message : `Invalid ${key}`);
            }
        } else if (rule.kind === 'internalOrigin') {
            const value = String(raw).trim();
            let parsed: URL;
            try {
                parsed = new URL(value);
            } catch {
                throw badRequest(`Invalid ${key}: not a URL`);
            }
            if (parsed.protocol !== rule.scheme) {
                throw badRequest(`Invalid ${key}: must use ${rule.scheme}//`);
            }
            if (parsed.username || parsed.password) {
                throw badRequest(`Invalid ${key}: must not carry credentials`);
            }
        } else if (rule.kind === 'boundedQuery') {
            const problem = rule.check(String(raw));
            if (problem) throw badRequest(`Invalid ${key}: ${problem}`);
        }
    }
    return config;
}
