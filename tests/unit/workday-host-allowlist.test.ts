/**
 * A Workday connection cannot redirect its own credentials.
 *
 * Both secret-bearing Workday requests take `host` from `configJson`:
 *   token.ts   POSTs the OAuth2 CLIENT CREDENTIALS in a Basic header
 *   roster.ts  sends a LIVE BEARER ACCESS TOKEN
 *
 * `upsertIntegrationConnection` writes configJson VERBATIM as a
 * Prisma.InputJsonValue — no zod schema, no validation, no host check, for any
 * provider. The only gate is `admin.manage`.
 *
 * So without this, a tenant admin could point `host` at a domain they control
 * and the platform would hand over first the client credentials and then a
 * bearer token. That is credential exfiltration reachable by a role meant to
 * configure an integration, not to redirect its secrets.
 *
 * Found by the concurrent session's adversarial review of the token-exchange
 * layer, while the module was still inert (no production importers) — which is
 * why it is closed in the PR that wires it rather than after.
 */
import { assertWorkdayHost } from '@/app-layer/integrations/providers/workday/host';
import { readWorkdayRoster } from '@/app-layer/integrations/providers/workday/roster';
import { exchangeCodeForWorkdayToken } from '@/app-layer/integrations/providers/workday/token';

describe('assertWorkdayHost', () => {
    it('accepts real Workday hosts', () => {
        expect(assertWorkdayHost('wd2-impl-services1.workday.com')).toBe('wd2-impl-services1.workday.com');
        expect(assertWorkdayHost('https://acme.workday.com/')).toBe('acme.workday.com');
        expect(assertWorkdayHost('impl.workdaysuv.com')).toBe('impl.workdaysuv.com');
    });

    it('refuses a lookalike that a naive endsWith would accept', () => {
        // The two shapes a substring check waves through.
        expect(() => assertWorkdayHost('evil-workday.com')).toThrow(/not a recognised Workday host/i);
        expect(() => assertWorkdayHost('workday.com.attacker.net')).toThrow(/not a recognised Workday host/i);
    });

    it('refuses an outright attacker host', () => {
        expect(() => assertWorkdayHost('attacker.example')).toThrow(/not a recognised Workday host/i);
        expect(() => assertWorkdayHost('localhost')).toThrow(/not a recognised Workday host/i);
        expect(() => assertWorkdayHost('169.254.169.254')).toThrow(/not a recognised Workday host/i);
    });

    it('refuses a host smuggling a real domain past a regex via userinfo', () => {
        // `evil.example` is the host the request would actually reach; the
        // Workday-looking part is a username. A regex sees the substring and
        // waves it through — the URL parser does not.
        expect(() => assertWorkdayHost('acme.workday.com@evil.example')).toThrow();
        expect(() => assertWorkdayHost('https://user:pw@acme.workday.com')).toThrow(/must not carry credentials/i);
    });

    it('refuses empty rather than defaulting', () => {
        // There is no safe default host for a secret-bearing request.
        expect(() => assertWorkdayHost('')).toThrow(/required/i);
        expect(() => assertWorkdayHost('   ')).toThrow(/required/i);
    });
});

describe('the secret-bearing call sites refuse an off-domain host', () => {
    const evilFetch = jest.fn();

    beforeEach(() => evilFetch.mockClear());

    it('the token exchange does not POST client credentials off-domain', async () => {
        await expect(
            exchangeCodeForWorkdayToken(
                {
                    client: { host: 'attacker.example', tenant: 't', clientId: 'cid', clientSecret: 'SECRET' },
                    code: 'c',
                    redirectUri: 'r',
                },
                { fetchImpl: evilFetch as unknown as typeof fetch },
            ),
        ).rejects.toThrow(/not a recognised Workday host/i);
        // The assertion that matters: no request was made at all.
        expect(evilFetch).not.toHaveBeenCalled();
    });

    it('the roster read does not send a bearer token off-domain', async () => {
        await expect(
            readWorkdayRoster(
                { host: 'attacker.example', tenant: 't', reportPath: '/r' },
                'LIVE-ACCESS-TOKEN',
                null,
                { fetchImpl: evilFetch as unknown as typeof fetch },
            ),
        ).rejects.toThrow(/not a recognised Workday host/i);
        expect(evilFetch).not.toHaveBeenCalled();
    });
});
