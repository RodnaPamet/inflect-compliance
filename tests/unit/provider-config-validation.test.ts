/**
 * Tenant-admin config is validated before it is stored.
 *
 * Each assertion below corresponds to a defect that actually shipped and was
 * fixed at its call site. This is the boundary that stops the next one being
 * written at all — the call-site fixes stay, because a value already in the
 * database predates this check.
 */
import {
    validateProviderConfig,
    originFieldsFor,
    redirectsStoredCredential,
} from '@/app-layer/integrations/config-schema';

describe('vendor-hosted origins must belong to the vendor', () => {
    it('accepts a real Okta org', () => {
        expect(() =>
            validateProviderConfig('okta', { orgUrl: 'https://acme.okta.com' }),
        ).not.toThrow();
    });

    it.each([
        ['a lookalike domain', 'https://evil-okta.com'],
        ['a suffix-extended domain', 'https://okta.com.attacker.net'],
        ['userinfo hiding the real host', 'https://acme.okta.com@evil.example'],
    ])('rejects %s', (_label, orgUrl) => {
        // The third is the one a suffix check misses: everything before the @ is
        // userinfo, so a substring test sees a legitimate domain while the
        // request goes to evil.example. Parsing is what separates them.
        expect(() => validateProviderConfig('okta', { orgUrl })).toThrow();
    });
});

describe('customer-internal origins get scheme enforcement, not an allowlist', () => {
it('accepts a creation OU, so an operator can actually set one — #2714', async () => {
        // The provisioner has always REFUSED a create without an OU, and the
        // field was declared on its options — but not on the provider, so
        // `validateProviderConfig` rejected it as an unknown key and there was
        // no way to supply one. The refusal read as a configuration problem
        // the operator could fix; it was a configuration they could not reach.
        //
        // What makes an arbitrary DN safe here is a CONNECT-TIME fact this
        // validator cannot check: the provisioner refuses any OU outside the
        // connection's own base DN.
        expect(() =>
            validateProviderConfig('active-directory', {
                createOU: 'OU=Employees,DC=corp,DC=example,DC=test',
            }),
        ).not.toThrow();
    });

        it('accepts an ldaps:// domain controller on any host', () => {
        // No vendor suffix can apply — an AD host is customer infrastructure.
        expect(() =>
            validateProviderConfig('active-directory', { url: 'ldaps://dc.corp.example.com:636' }),
        ).not.toThrow();
    });

    it('rejects plaintext ldap://, which would put the bind password on the wire', () => {
        expect(() =>
            validateProviderConfig('active-directory', { url: 'ldap://dc.corp.example.com:389' }),
        ).toThrow(/ldaps/);
    });

    it('rejects credentials embedded in the URL', () => {
        expect(() =>
            validateProviderConfig('active-directory', { url: 'ldaps://user:pw@dc.corp.example.com' }),
        ).toThrow(/credentials/);
    });

    it('does NOT try to settle allowSelfSignedTls here', () => {
        // Deliberate. Whether the host is internal is a property of where the
        // name points at CONNECT time, which the write boundary cannot know —
        // and an AD deployment has the DNS control to change it afterwards. That
        // check lives in providers/active-directory/index.ts and must stay there.
        expect(() =>
            validateProviderConfig('active-directory', {
                url: 'ldaps://dc.corp.example.com',
                allowSelfSignedTls: true,
            }),
        ).not.toThrow();
    });
});

describe('bounded queries stay queries', () => {
    it('rejects a ServiceNow query carrying server-side script', () => {
        // sysparm_query is evaluated with the integration user's rights, usually
        // broader than the admin who typed it.
        expect(() =>
            validateProviderConfig('servicenow', { sysparm_query: 'active=true^javascript:gs.getUser()' }),
        ).toThrow(/script/);
    });

    it('accepts an ordinary encoded query', () => {
        expect(() =>
            validateProviderConfig('servicenow', { sysparm_query: 'active=true^state=3' }),
        ).not.toThrow();
    });

    it('rejects a BambooHR subdomain that would escape the interpolated host', () => {
        // The value is interpolated into {subdomain}.bamboohr.com, so a dot or a
        // slash changes which host is contacted.
        //
        // THE PROVIDER ID IS 'bamboohr'. This read `'hris'` until #2837 — the
        // same wrong key the rules table itself used — so the test and the
        // defect agreed with each other and both stayed green. Production calls
        // `validateProviderConfig` with the provider id, found no rules for
        // `bamboohr`, and returned the config unvalidated. The guard this test
        // is named for had never run on the path that matters.
        expect(() => validateProviderConfig('bamboohr', { subdomain: 'acme.evil.com' })).toThrow();
        expect(() => validateProviderConfig('bamboohr', { subdomain: 'acme' })).not.toThrow();
    });
});

describe('undeclared fields are refused', () => {
    it('rejects a key the provider never declared', () => {
        // Allow-shaped: a field nobody classified has no established meaning, so
        // storing it is how an unreviewed value reaches a provider later.
        expect(() =>
            validateProviderConfig('okta', { orgUrl: 'https://acme.okta.com', proxyUrl: 'http://evil' }),
        ).toThrow(/Unknown configuration field/);
    });

    it('passes an unclassified provider through unchanged', () => {
        // Failing closed here would break connection creation for any provider
        // not yet in the registry. The classification guard is what stops that
        // becoming a silent hole for anything that actually ships.
        expect(validateProviderConfig('not-a-provider', { anything: 1 })).toEqual({ anything: 1 });
    });

    it('rejects a non-object', () => {
        expect(() => validateProviderConfig('okta', 'nope')).toThrow(/plain object/);
        expect(() => validateProviderConfig('okta', [1, 2])).toThrow(/plain object/);
    });

    it('treats null/absent config as empty rather than failing', () => {
        expect(validateProviderConfig('okta', null)).toEqual({});
        expect(validateProviderConfig('okta', undefined)).toEqual({});
    });
});

describe('a stored credential cannot be redirected to another host by a config edit', () => {
    /**
     * The allowlist answers "is this the vendor?", never "is this YOUR tenant
     * of the vendor?". A free personal ServiceNow developer instance satisfies
     * it, so the allowlist alone never stopped an `admin.manage` holder from
     * moving the host and keeping the credential.
     */
    it('flags a ServiceNow instance change — the reported attack', () => {
        expect(
            redirectsStoredCredential(
                'servicenow',
                { instance: 'acme.service-now.com' },
                { instance: 'attacker.service-now.com' },
            ),
        ).toBe('instance');
    });

    it('flags the same move on every other credential-bearing provider', () => {
        // Not a ServiceNow bug. Each of these sends a client secret, an API
        // token or a bind password to whatever the field names.
        expect(redirectsStoredCredential('okta', { orgUrl: 'https://a.okta.com' }, { orgUrl: 'https://b.okta.com' }))
            .toBe('orgUrl');
        expect(redirectsStoredCredential('workday', { host: 'a.workday.com' }, { host: 'b.workday.com' }))
            .toBe('host');
        expect(
            redirectsStoredCredential(
                'orangehrm',
                { baseUrl: 'a.orangehrmlive.com' },
                { baseUrl: 'b.orangehrmlive.com' },
            ),
        ).toBe('baseUrl');
        expect(redirectsStoredCredential('active-directory', { url: 'ldaps://a.corp' }, { url: 'ldaps://b.corp' }))
            .toBe('url');
    });

    it('does NOT flag an ordinary edit that leaves the host alone', () => {
        // The positive control. Without it, a function that returned a field
        // name unconditionally would satisfy every assertion above.
        expect(
            redirectsStoredCredential(
                'servicenow',
                { instance: 'acme.service-now.com', windowDays: 90 },
                { instance: 'acme.service-now.com', windowDays: 30 },
            ),
        ).toBeNull();
    });

    it('treats an ABSENT origin field as unchanged, not as a redirect', () => {
        // A partial update that omits the host is not moving it. Reading
        // absence as a change would refuse routine edits and train operators to
        // re-enter credentials for no reason — which is its own hazard.
        expect(redirectsStoredCredential('servicenow', { instance: 'acme.service-now.com' }, { windowDays: 30 }))
            .toBeNull();
    });

    it('ignores case and surrounding whitespace, which are not a different host', () => {
        expect(
            redirectsStoredCredential(
                'servicenow',
                { instance: 'acme.service-now.com' },
                { instance: '  ACME.service-now.com ' },
            ),
        ).toBeNull();
    });

    it('derives the origin fields from the rules rather than a hand-written list', () => {
        // A future provider gets this protection by declaring vendorOrigin,
        // with no second list to remember.
        expect(originFieldsFor('servicenow')).toEqual(['instance']);
        expect(originFieldsFor('active-directory')).toEqual(['url']);
        // An inert field is not an origin — otherwise every edit would refuse.
        // Asserted as an EXACT list rather than `not.toContain('apiToken')`,
        // which is how it was written: #2837 deleted okta's `apiToken` rule, so
        // that spelling became a statement about a key the table no longer has
        // — true for the wrong reason, and satisfied by an empty result.
        expect(originFieldsFor('okta')).toEqual(['orgUrl']);
    });
});

/**
 * #2837 — a credential a provider declares in `secretFields` is REFUSED as
 * config, rather than quietly admitted into the unencrypted bag.
 *
 * Ten such keys carried a `CONFIG_FIELD_RULES` entry. They had no reader:
 * every provider takes its credential from the secret bag or from the merged
 * `{ ...configJson, ...decryptedSecrets }`, where the secret wins — so the
 * rules were an accept-list with no consumer, and their only effect was to let
 * a `PUT` put a bind password in a plain Json column that the admin GET serves.
 *
 * One per provider, because the ten were removed provider by provider and a
 * single example would keep passing with nine rules restored.
 */
describe('a secret-declared credential is not accepted as config', () => {
    it.each([
        ['active-directory', 'bindDN', 'CN=svc,DC=corp,DC=example,DC=com'],
        ['active-directory', 'bindPassword', 'REDACTED-NOT-A-REAL-VALUE'],
        ['entra-id', 'clientSecret', 'REDACTED-NOT-A-REAL-VALUE'],
        ['github', 'token', 'REDACTED-NOT-A-REAL-VALUE'],
        ['github', 'webhookSecret', 'REDACTED-NOT-A-REAL-VALUE'],
        ['google-workspace', 'serviceAccountJson', '{"type":"service_account"}'],
        ['okta', 'apiToken', 'REDACTED-NOT-A-REAL-VALUE'],
        ['orangehrm', 'clientSecret', 'REDACTED-NOT-A-REAL-VALUE'],
        ['servicenow', 'password', 'REDACTED-NOT-A-REAL-VALUE'],
        ['workday', 'clientSecret', 'REDACTED-NOT-A-REAL-VALUE'],
    ])('%s.%s is refused', (provider, key, value) => {
        expect(() => validateProviderConfig(provider, { [key]: value })).toThrow(
            new RegExp(`Unknown configuration field for ${provider}: ${key}`),
        );
    });

    it('the CONFIG half of each of those providers still saves — the positive control', () => {
        // Without this, every assertion above would also pass if
        // `validateProviderConfig` had started rejecting the provider id
        // itself, or every key, rather than these ten keys.
        expect(() => validateProviderConfig('active-directory', { baseDN: 'DC=corp,DC=example,DC=com' })).not.toThrow();
        expect(() => validateProviderConfig('entra-id', { clientId: 'abc' })).not.toThrow();
        expect(() => validateProviderConfig('github', { owner: 'acme', repo: 'api', branch: 'main' })).not.toThrow();
        expect(() => validateProviderConfig('google-workspace', { domain: 'acme.com' })).not.toThrow();
        expect(() => validateProviderConfig('okta', { orgUrl: 'https://acme.okta.com' })).not.toThrow();
        expect(() => validateProviderConfig('orangehrm', { clientId: 'cid' })).not.toThrow();
        expect(() => validateProviderConfig('servicenow', { username: 'svc' })).not.toThrow();
        expect(() => validateProviderConfig('workday', { clientId: 'cid' })).not.toThrow();
    });
});
