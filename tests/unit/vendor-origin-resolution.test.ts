/**
 * `resolveVendorOrigin` — the scheme-and-port half of the vendor host boundary.
 *
 * ═══ WHAT THIS FUNCTION IS FOR ═══
 *
 * `assertAllowedHost` answers "may we send credentials here?" and returns a
 * HOSTNAME. Every caller then wrote `https://${host}`, and that concatenation
 * was quietly doing two more security-relevant jobs: forcing TLS, and
 * discarding any port the config supplied. Neither was written down anywhere a
 * test could reach, so neither could regress visibly.
 *
 * The default path below is byte-identical to that concatenation. The flags
 * exist for one caller — a stress harness on 127.0.0.1:<random> that drives the
 * real request stack — and `tests/guardrails/vendor-origin-no-test-flags.test.ts`
 * keeps them out of `src/`.
 */
import { resolveVendorOrigin, OKTA_HOSTS, type HostAllowlist } from '@/app-layer/integrations/allowed-host';

/** What a test harness would inject. Never legal in src/ — see the guardrail. */
const LOCAL: HostAllowlist = {
    label: 'Okta',
    exact: ['127.0.0.1'],
    suffixes: [],
    allowInsecure: true,
    allowPort: true,
};

describe('the default is exactly what the string concatenation did', () => {
    it('forces https and drops the port', () => {
        expect(resolveVendorOrigin('https://acme.okta.com', OKTA_HOSTS)).toBe('https://acme.okta.com');
    });

    it('UPGRADES http to https — a config-supplied scheme cannot downgrade it', () => {
        // The whole point: `http://acme.okta.com` would send the API token in
        // clear text.
        expect(resolveVendorOrigin('http://acme.okta.com', OKTA_HOSTS)).toBe('https://acme.okta.com');
    });

    it('DISCARDS a port even on an allowed host', () => {
        // Not cosmetic. A port is how an attacker who controls a subdomain
        // redirects the credential-bearing request to a listener of their own.
        expect(resolveVendorOrigin('https://acme.okta.com:8443', OKTA_HOSTS)).toBe('https://acme.okta.com');
    });

    it('still refuses a host that is not on the list', () => {
        expect(() => resolveVendorOrigin('https://evil.tld', OKTA_HOSTS)).toThrow(/not a recognised Okta host/);
    });
});

describe('the flags widen the OUTPUT, never the ADMISSION', () => {
    it('a permissive-flagged allowlist still rejects a host it does not name', () => {
        // This is the invariant that makes the flags safe to exist. They are
        // consulted only AFTER assertAllowedHost has admitted the host, so no
        // combination of them can let a credential reach an unlisted origin.
        expect(() => resolveVendorOrigin('http://evil.tld:9999', LOCAL)).toThrow(/not a recognised Okta host/);
    });

    it('preserves scheme and port for the harness case', () => {
        // The exact string the stress suite needs, and the reason a
        // hostAllowlist-only seam was not enough: assertAllowedHost returns
        // `url.hostname`, so the port was being dropped.
        expect(resolveVendorOrigin('http://127.0.0.1:41234', LOCAL)).toBe('http://127.0.0.1:41234');
    });

    it('allowPort alone keeps the port but still forces https', () => {
        const portOnly: HostAllowlist = { ...LOCAL, allowInsecure: false };
        expect(resolveVendorOrigin('http://127.0.0.1:41234', portOnly)).toBe('https://127.0.0.1:41234');
    });

    it('allowInsecure alone keeps http but still drops the port', () => {
        const insecureOnly: HostAllowlist = { ...LOCAL, allowPort: false };
        expect(resolveVendorOrigin('http://127.0.0.1:41234', insecureOnly)).toBe('http://127.0.0.1');
    });

    it('does not invent a port when the input has none', () => {
        expect(resolveVendorOrigin('http://127.0.0.1', LOCAL)).toBe('http://127.0.0.1');
    });

    it('a bare host with no scheme resolves https, flags or not', () => {
        expect(resolveVendorOrigin('127.0.0.1', LOCAL)).toBe('https://127.0.0.1');
    });
});

describe('the credential-bearing edge cases assertAllowedHost already guards', () => {
    it('userinfo is refused rather than silently reinterpreted', () => {
        // `acme.okta.com@evil.tld` parses to host evil.tld.
        expect(() => resolveVendorOrigin('https://acme.okta.com@evil.tld', OKTA_HOSTS)).toThrow(
            /must not carry credentials|not a recognised/,
        );
    });

    it('an empty org URL is a required-field error, not a parse error', () => {
        expect(() => resolveVendorOrigin('', OKTA_HOSTS)).toThrow(/required/);
    });
});
