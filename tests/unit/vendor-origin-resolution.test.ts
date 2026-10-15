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
import {
    resolveVendorOrigin,
    assertAllowedHost,
    OKTA_HOSTS,
    ORANGEHRM_HOSTS,
    type HostAllowlist,
} from '@/app-layer/integrations/allowed-host';

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

describe('the OrangeHRM lab fixture is admitted by name and by name only', () => {
    // ═══ WHAT THESE FOUR ASSERTIONS ARE PROTECTING ═══
    //
    // `ORANGEHRM_HOSTS.exact` names one self-hosted fixture,
    // `orangehrm-lab.34-140-180-255.sslip.io`. Every other entry in that
    // allowlist is a vendor domain, and this one is not — so the natural
    // tidy-up, some months from now, is to "simplify" it into the `suffixes`
    // list beside the two real ones.
    //
    // That tidy-up is a security regression and nothing about the diff looks
    // like one. sslip.io maps `<anything>.34-140-180-255.sslip.io` to a single
    // address, so the suffix admits every vhost on that machine — including
    // `inflect.34-140-180-255.sslip.io`, which is this application. The third
    // assertion is the one that fails on that change, and it is the reason the
    // other three are here to say what the entry is FOR.

    it('admits the exact fixture hostname', () => {
        expect(assertAllowedHost('orangehrm-lab.34-140-180-255.sslip.io', ORANGEHRM_HOSTS))
            .toBe('orangehrm-lab.34-140-180-255.sslip.io');
    });

    it('admits it written as a URL, which is how an operator pastes it', () => {
        expect(assertAllowedHost('https://orangehrm-lab.34-140-180-255.sslip.io/', ORANGEHRM_HOSTS))
            .toBe('orangehrm-lab.34-140-180-255.sslip.io');
    });

    it('REFUSES this deployment’s own hostname on the same address', () => {
        // The assertion that makes `exact` load-bearing. Both names resolve to
        // 34.140.180.255; only one of them is the fixture.
        expect(() => assertAllowedHost('inflect.34-140-180-255.sslip.io', ORANGEHRM_HOSTS))
            .toThrow(/OrangeHRM/);
        expect(() => assertAllowedHost('app.inflect.bg', ORANGEHRM_HOSTS))
            .toThrow(/OrangeHRM/);
    });

    it('refuses the lookalikes a substring check would admit', () => {
        for (const host of [
            'evil-orangehrm-lab.34-140-180-255.sslip.io',
            'orangehrm-lab.34-140-180-255.sslip.io.attacker.net',
            'orangehrm-lab.34-140-180-255.sslip.io@evil.tld',
            'orangehrm-lab.34-140-180-256.sslip.io',
        ]) {
            expect(() => assertAllowedHost(host, ORANGEHRM_HOSTS)).toThrow();
        }
    });
});
