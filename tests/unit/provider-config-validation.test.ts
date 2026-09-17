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
        expect(() => validateProviderConfig('hris', { subdomain: 'acme.evil.com' })).toThrow();
        expect(() => validateProviderConfig('hris', { subdomain: 'acme' })).not.toThrow();
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
        expect(originFieldsFor('okta')).not.toContain('apiToken');
    });
});
