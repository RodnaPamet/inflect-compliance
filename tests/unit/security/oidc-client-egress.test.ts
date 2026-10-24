/**
 * Every request the OIDC client makes goes through the SSRF guard.
 *
 * A workspace administrator types the issuer, and the discovery document that
 * issuer serves names the token endpoint and the key set: three URLs chosen
 * outside this deployment. The client fetched all three with the global
 * `fetch` (jose's default, for the key set), so an issuer could point this
 * server at cloud metadata or anything else on its network, including through
 * a public discovery document that names `https://169.254.169.254/…` as its
 * token endpoint. Each now goes through `safeFetch`
 * (src/app-layer/automation/webhook-safety.ts).
 *
 * The guard itself is NOT mocked here; only DNS and the transport are. The
 * transport stub sits on `undici`, which is what `safeFetch` calls, and the
 * global `fetch` throws: a request that reached it went around the guard.
 */
const mockLookup = jest.fn<Promise<{ address: string; family: number }[]>, [string, unknown]>();
jest.mock('node:dns', () => ({
    promises: { lookup: (host: string, opts: unknown) => mockLookup(host, opts) },
}));

const mockTransport = jest.fn<Promise<Response>, [unknown, Record<string, unknown> | undefined]>();
jest.mock('undici', () => ({
    ...jest.requireActual('undici'),
    fetch: (url: unknown, init?: Record<string, unknown>) => mockTransport(url, init),
}));

import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { RedirectNotAllowedError, SsrfBlockedError } from '@/app-layer/automation/webhook-safety';
import {
    _clearDiscoveryCache,
    discoverOidc,
    exchangeCodeForTokens,
    IdTokenRefusedError,
    verifyIdToken,
    type OidcDiscoveryDocument,
} from '@/lib/security/oidc-client';
import type { OidcConfig } from '@/app-layer/schemas/sso-config.schemas';

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'client-123';
const NONCE = 'nonce-from-this-flow';
const DISCOVERY: OidcDiscoveryDocument = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/keys`,
};

const config = (overrides: Partial<OidcConfig> = {}): OidcConfig => ({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: 'secret',
    scopes: ['openid', 'email'],
    ...overrides,
});

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Where each host resolves. A host not listed does not resolve. */
let dns: Record<string, string> = {};

const realFetch = global.fetch;
const globalFetch = jest.fn(async (input: unknown): Promise<Response> => {
    throw new Error(`the global fetch was called for ${String(input)}: a request went around the guard`);
});

let idpKey: CryptoKey;
let jwks: { keys: JWK[] };

beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    idpKey = pair.privateKey;
    jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'idp-key-1', alg: 'RS256', use: 'sig' }] };
    global.fetch = globalFetch as unknown as typeof fetch;
});

afterAll(() => {
    global.fetch = realFetch;
});

beforeEach(() => {
    _clearDiscoveryCache();
    globalFetch.mockClear();
    mockTransport.mockReset();
    mockLookup.mockReset();
    dns = { 'idp.example.com': '93.184.216.34' };
    mockLookup.mockImplementation(async (host) => {
        const address = dns[host];
        if (!address) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
        return [{ address, family: 4 }];
    });
});

/** The URLs the transport was asked for, in order. */
const requested = () => mockTransport.mock.calls.map(([url]) => String(url));

async function idToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: ISSUER, aud: CLIENT_ID, sub: 'ext-user-1', nonce: NONCE, iat: now, exp: now + 300 })
        .setProtectedHeader({ alg: 'RS256', kid: 'idp-key-1' })
        .sign(idpKey);
}

describe('OIDC client egress — the reachable path', () => {
    it('discovers a public identity provider through the guard, pinned to the address it checked', async () => {
        mockTransport.mockResolvedValueOnce(json(DISCOVERY));

        await expect(discoverOidc(config())).resolves.toEqual(DISCOVERY);

        expect(requested()).toEqual([`${ISSUER}/.well-known/openid-configuration`]);
        expect(mockLookup).toHaveBeenCalledWith('idp.example.com', expect.anything());
        const [, init] = mockTransport.mock.calls[0];
        expect(init?.redirect).toBe('manual');
        expect(init?.dispatcher).toBeDefined();
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it('exchanges the code and fetches the signing keys through the guard too', async () => {
        const token = await idToken();
        mockTransport.mockImplementation(async (url) => {
            if (String(url) === DISCOVERY.token_endpoint) {
                return json({ id_token: token, access_token: 'at', token_type: 'Bearer' });
            }
            if (String(url) === DISCOVERY.jwks_uri) return json(jwks);
            throw new Error(`unexpected request ${String(url)}`);
        });

        const tokens = await exchangeCodeForTokens(DISCOVERY, config(), 'code', 'https://app.example/cb', 'verifier');
        await expect(
            verifyIdToken(tokens.id_token, { discovery: DISCOVERY, clientId: CLIENT_ID, nonce: NONCE }),
        ).resolves.toMatchObject({ sub: 'ext-user-1' });

        expect(requested()).toEqual([DISCOVERY.token_endpoint, DISCOVERY.jwks_uri]);
        expect(globalFetch).not.toHaveBeenCalled();
    });
});

describe('OIDC client egress — refusals', () => {
    it.each([
        ['an http issuer', 'http://idp.example.com'],
        ['cloud metadata', 'https://169.254.169.254'],
        ['a private address', 'https://10.0.0.5'],
        ['loopback', 'https://localhost:8443'],
    ])('refuses to discover %s, without sending a request', async (_label, issuer) => {
        await expect(discoverOidc(config({ issuer }))).rejects.toBeInstanceOf(SsrfBlockedError);
        expect(mockTransport).not.toHaveBeenCalled();
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it('refuses an issuer whose public name resolves to a private address (DNS rebinding)', async () => {
        dns['idp.example.com'] = '10.0.0.5';
        await expect(discoverOidc(config())).rejects.toThrow(/private address 10\.0\.0\.5/);
        expect(mockTransport).not.toHaveBeenCalled();
    });

    it('refuses a discovery-URL override that points inside the network', async () => {
        await expect(
            discoverOidc(config({ discoveryUrl: 'https://169.254.169.254/latest/meta-data/' })),
        ).rejects.toBeInstanceOf(SsrfBlockedError);
        expect(mockTransport).not.toHaveBeenCalled();
    });

    it('refuses to follow a discovery redirect, rather than going wherever it points', async () => {
        mockTransport.mockResolvedValueOnce(
            new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } }),
        );
        await expect(discoverOidc(config())).rejects.toBeInstanceOf(RedirectNotAllowedError);
        expect(requested()).toEqual([`${ISSUER}/.well-known/openid-configuration`]);
    });

    it("refuses a public IdP's token endpoint that points at cloud metadata", async () => {
        // The issuer is public and passes; the document it serves is what
        // names the internal target. The code, verifier and client secret
        // would be POSTed there.
        const hostile = { ...DISCOVERY, token_endpoint: 'https://169.254.169.254/latest/meta-data/iam' };
        await expect(
            exchangeCodeForTokens(hostile, config(), 'code', 'https://app.example/cb', 'verifier'),
        ).rejects.toBeInstanceOf(SsrfBlockedError);
        expect(mockTransport).not.toHaveBeenCalled();
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it("refuses a public IdP's key-set URL that points inside the network, as keys_unavailable", async () => {
        const hostile = { ...DISCOVERY, jwks_uri: 'https://10.0.0.5/keys' };
        const err = await verifyIdToken(await idToken(), { discovery: hostile, clientId: CLIENT_ID, nonce: NONCE }).then(
            () => null,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(IdTokenRefusedError);
        expect((err as IdTokenRefusedError).reason).toBe('keys_unavailable');
        expect(mockTransport).not.toHaveBeenCalled();
        expect(globalFetch).not.toHaveBeenCalled();
    });
});
