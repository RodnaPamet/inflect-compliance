/**
 * The fields of a workspace's SSO provider that decide whom it trusts.
 *
 * A sign-in through the provider becomes a session for whichever member the
 * identity provider names, matched by email on the first sign-in. So whoever
 * can point the provider at an identity provider they run can sign in as any
 * member, Owners included. These are the fields that do the pointing: the
 * identity provider itself (issuer, client ID, discovery document; entity ID,
 * sign-in URL, signing certificate), the email domains it may speak for, and
 * whether it may create accounts. Changing any of them is Owner-tier
 * (`upsertTenantSsoConfig`), and drops every identity link to the provider.
 *
 * Everything else on the form (the name, scopes, NameID format, the client
 * secret, the enable and enforce switches) changes how sign-in works, not
 * whom it believes.
 */

/** A provider's trust fields, as stored or as a save would store them. */
export interface SsoTrustState {
    type: string;
    emailDomains: readonly string[];
    config: Record<string, unknown>;
    allowJitProvisioning: boolean;
    jitDefaultRole: string;
}

/** Per protocol, the config keys that name the identity provider or its keys. */
export const SSO_TRUST_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
    OIDC: ['issuer', 'clientId', 'discoveryUrl'],
    SAML: ['entityId', 'ssoUrl', 'certificate'],
};

/**
 * A config value as compared. A certificate is compared by its base64 body,
 * so pasting the same certificate with or without its PEM armour, or with
 * different line breaks, is not a change.
 */
function comparable(key: string, value: unknown): string {
    if (typeof value !== 'string') return '';
    if (key === 'certificate') return value.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
    return value.trim();
}

function domainSet(domains: readonly string[]): string {
    return [...new Set(domains.map((d) => d.trim().toLowerCase()))].sort().join(',');
}

/** The trust fields that differ between `before` and `after`, by name. */
export function changedSsoTrustFields(before: SsoTrustState, after: SsoTrustState): string[] {
    const changed: string[] = [];
    if (before.type !== after.type) changed.push('type');
    if (domainSet(before.emailDomains) !== domainSet(after.emailDomains)) changed.push('emailDomains');
    const keys = new Set([...(SSO_TRUST_CONFIG_KEYS[before.type] ?? []), ...(SSO_TRUST_CONFIG_KEYS[after.type] ?? [])]);
    for (const key of keys) {
        if (comparable(key, before.config[key]) !== comparable(key, after.config[key])) changed.push(key);
    }
    if (before.allowJitProvisioning !== after.allowJitProvisioning) changed.push('allowJitProvisioning');
    if (before.jitDefaultRole !== after.jitDefaultRole) changed.push('jitDefaultRole');
    return changed;
}

/** The `ForbiddenError` reason when someone below Owner tries one. */
export const SSO_TRUST_OWNER_TIER_REFUSAL = 'SSO_TRUST_IS_OWNER_TIER' as const;

export const SSO_TRUST_OWNER_TIER_MESSAGE =
    'Only an Owner can set up single sign-on or change whom it trusts: the identity provider, ' +
    'its certificate or client ID, the email domains it covers, and whether it creates accounts.';
