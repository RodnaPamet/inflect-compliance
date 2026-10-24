/**
 * An OIDC sign-in trusts an ID token only when the identity provider signed it.
 *
 * The callback read the token's claims by base64-decoding them and compared
 * the nonce, and that was all: no signature, issuer, audience or expiry
 * check. A token anyone could write — a JSON body naming any `sub` and
 * `email`, signed "fake-signature" — signed in whoever it named. Now
 * `verifyIdToken` (src/lib/security/oidc-client.ts) applies the checks OIDC
 * Core §3.1.3.7 lists, against the keys the IdP publishes at its `jwks_uri`,
 * and the callback refuses whatever it refuses.
 *
 * The tokens here are real: signed with keys generated for this run and
 * served from a key-set endpoint that the fetch double answers. Nothing in
 * `jose` is mocked.
 */
const memberships = new Map<string, { status: string }>();
const handoffRows: unknown[] = [];
jest.mock('@/lib/prisma', () => {
    const prisma = {
        tenant: { findUnique: jest.fn(async () => ({ id: 'tenant-1', slug: 'acme' })) },
        tenantIdentityProvider: {
            findFirst: jest.fn(async () => ({
                id: 'idp-1',
                tenantId: 'tenant-1',
                type: 'OIDC',
                isEnabled: true,
                configJson: {
                    issuer: 'https://idp.example.com',
                    clientId: 'client-123',
                    clientSecret: 'client-secret-value', // pragma: allowlist secret
                },
            })),
        },
        tenantMembership: { findUnique: jest.fn(async () => memberships.get('user-1') ?? null) },
        verificationToken: {
            deleteMany: jest.fn(async () => ({ count: 0 })),
            create: jest.fn(async ({ data }: { data: unknown }) => {
                handoffRows.push(data);
                return data;
            }),
        },
        $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    return { __esModule: true, default: prisma, prisma };
});
const linkExternalIdentity = jest.fn(async () => ({ status: 'linked', userId: 'user-1', isNewLink: false }));
jest.mock('@/app-layer/usecases/sso', () => ({
    linkExternalIdentity: (...a: unknown[]) => linkExternalIdentity(...(a as [])),
}));

import { NextRequest, NextResponse } from 'next/server';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload, type CryptoKey } from 'jose';

import { GET as oidcCallback } from '@/app/api/auth/sso/oidc/callback/route';
import { prepareSsoFlow } from '@/lib/auth/sso-flow';
import { SSO_HANDOFF_COOKIE } from '@/lib/auth/sso-session';
import {
    _clearDiscoveryCache,
    encodeState,
    ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
    IdTokenRefusedError,
    verifyIdToken,
    type IdTokenRefusal,
    type OidcDiscoveryDocument,
} from '@/lib/security/oidc-client';

// ─── The identity provider ───────────────────────────────────────────

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'client-123';
const NONCE = 'nonce-from-this-flow';
const DISCOVERY: OidcDiscoveryDocument = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/keys`,
};

let idpKey: CryptoKey;
let attackerKey: CryptoKey;
let jwks: { keys: JWK[] };
let jwksStatus = 200;
/** What the token endpoint answers with, for the callback tests. */
let issuedIdToken = '';

const realFetch = global.fetch;
const fetchMock = jest.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === `${ISSUER}/.well-known/openid-configuration`) return json(DISCOVERY);
    if (url === DISCOVERY.jwks_uri) return json(jwksStatus === 200 ? jwks : { error: 'down' }, jwksStatus);
    if (url === DISCOVERY.token_endpoint) {
        return json({ id_token: issuedIdToken, access_token: 'at', token_type: 'Bearer' });
    }
    throw new Error(`unexpected fetch ${url}`);
});

beforeAll(async () => {
    process.env.APP_URL = process.env.APP_URL || 'http://localhost:3000';
    ({ privateKey: idpKey } = await generateKeyPair('RS256', { extractable: true }).then(async (pair) => {
        jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'idp-key-1', alg: 'RS256', use: 'sig' }] };
        return pair;
    }));
    ({ privateKey: attackerKey } = await generateKeyPair('RS256'));
    global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
    global.fetch = realFetch;
});

beforeEach(() => {
    _clearDiscoveryCache();
    fetchMock.mockClear();
    linkExternalIdentity.mockClear();
    jwksStatus = 200;
    memberships.set('user-1', { status: 'ACTIVE' });
    handoffRows.length = 0;
});

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A token as the IdP would mint it, with `overrides` applied to the claims. */
async function idToken(
    overrides: Partial<JWTPayload> & Record<string, unknown> = {},
    opts: { key?: CryptoKey; kid?: string; omit?: string[] } = {},
): Promise<string> {
    const claims: Record<string, unknown> = {
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: 'ext-user-1',
        email: 'alice@acme.example',
        nonce: NONCE,
        iat: nowSeconds(),
        exp: nowSeconds() + 300,
        ...overrides,
    };
    for (const name of opts.omit ?? []) delete claims[name];
    return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'idp-key-1' })
        .sign(opts.key ?? idpKey);
}

/** A token with any header and body, and a signature that is just text. */
function unsignedToken(header: Record<string, unknown>, body: Record<string, unknown>, signature = 'fake-signature') {
    const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    return `${seg(header)}.${seg(body)}.${Buffer.from(signature).toString('base64url')}`;
}

const verify = (token: string) => verifyIdToken(token, { discovery: DISCOVERY, clientId: CLIENT_ID, nonce: NONCE });

async function refusalOf(token: string): Promise<IdTokenRefusal> {
    const err = await verify(token).then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IdTokenRefusedError);
    return (err as IdTokenRefusedError).reason;
}

// ─── verifyIdToken ───────────────────────────────────────────────────

describe('verifyIdToken', () => {
    it('accepts a token the IdP signed, and returns only the claims this app reads', async () => {
        const token = await idToken({ name: 'Alice', email_verified: true, is_admin: true, groups: ['x'] });
        await expect(verify(token)).resolves.toStrictEqual({
            sub: 'ext-user-1',
            email: 'alice@acme.example',
            email_verified: true,
            name: 'Alice',
        });
        expect(fetchMock).toHaveBeenCalledWith(DISCOVERY.jwks_uri, expect.anything());
    });

    describe('refuses a token the IdP did not sign', () => {
        it('a token whose signature is just text', async () => {
            const token = unsignedToken(
                { alg: 'RS256', kid: 'idp-key-1' },
                { iss: ISSUER, aud: CLIENT_ID, sub: 'ext-user-1', email: 'alice@acme.example', nonce: NONCE, iat: nowSeconds(), exp: nowSeconds() + 300 },
            );
            expect(await refusalOf(token)).toBe('signature');
        });

        it("a token signed by another key under the IdP's key id", async () => {
            expect(await refusalOf(await idToken({}, { key: attackerKey }))).toBe('signature');
        });

        it('a token naming a key the IdP does not publish', async () => {
            expect(await refusalOf(await idToken({}, { key: attackerKey, kid: 'attacker-key' }))).toBe('signature');
        });

        it('an unsecured token (alg "none")', async () => {
            const token = unsignedToken(
                { alg: 'none' },
                { iss: ISSUER, aud: CLIENT_ID, sub: 'ext-user-1', nonce: NONCE, iat: nowSeconds(), exp: nowSeconds() + 300 },
                '',
            );
            expect(await refusalOf(token)).toBe('signature');
        });

        it('a token MACed with the client secret (HS256)', async () => {
            const token = await new SignJWT({
                iss: ISSUER, aud: CLIENT_ID, sub: 'ext-user-1', nonce: NONCE, iat: nowSeconds(), exp: nowSeconds() + 300,
            })
                .setProtectedHeader({ alg: 'HS256' })
                .sign(new TextEncoder().encode('client-secret-value')); // pragma: allowlist secret
            expect(await refusalOf(token)).toBe('signature');
        });

        it('a token that is not a compact JWS at all', async () => {
            expect(await refusalOf('a.b.c.d')).toBe('malformed');
            expect(await refusalOf('header.payload')).toBe('malformed');
        });
    });

    it('refuses a token from another issuer', async () => {
        expect(await refusalOf(await idToken({ iss: 'https://other-idp.example.com' }))).toBe('issuer');
    });

    it("refuses a token for Microsoft's multi-tenant issuer template", async () => {
        // What a provider configured with Entra's `common` endpoint holds: the
        // document's issuer carries a literal placeholder, and a real token
        // names the directory it came from. Nothing matches, so nothing signs in.
        const common = { ...DISCOVERY, issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0' };
        const token = await idToken({ iss: 'https://login.microsoftonline.com/6f1c0f2e-attacker-tenant/v2.0' });
        await expect(verifyIdToken(token, { discovery: common, clientId: CLIENT_ID, nonce: NONCE }))
            .rejects.toMatchObject({ reason: 'issuer' });
    });

    describe('refuses a token issued to another client', () => {
        it('aud does not name this client', async () => {
            expect(await refusalOf(await idToken({ aud: 'some-other-client' }))).toBe('audience');
        });

        it('several audiences and no azp', async () => {
            expect(await refusalOf(await idToken({ aud: [CLIENT_ID, 'some-other-client'] }))).toBe('audience');
        });

        it('azp names another client', async () => {
            expect(await refusalOf(await idToken({ azp: 'some-other-client' }))).toBe('audience');
        });

        it('but accepts several audiences when azp names this client', async () => {
            await expect(verify(await idToken({ aud: [CLIENT_ID, 'api'], azp: CLIENT_ID }))).resolves.toMatchObject({
                sub: 'ext-user-1',
            });
        });
    });

    describe('expiry', () => {
        it('refuses a token past its expiry', async () => {
            const past = nowSeconds() - ID_TOKEN_CLOCK_TOLERANCE_SECONDS - 30;
            expect(await refusalOf(await idToken({ exp: past, iat: past - 300 }))).toBe('expired');
        });

        it('allows clock skew up to the tolerance', async () => {
            await expect(verify(await idToken({ exp: nowSeconds() - 20 }))).resolves.toMatchObject({ sub: 'ext-user-1' });
        });

        it('refuses a token not yet valid', async () => {
            expect(await refusalOf(await idToken({ nbf: nowSeconds() + 600 }))).toBe('expired');
        });

        it.each(['exp', 'iat'])('refuses a token with no %s', async (claim) => {
            expect(await refusalOf(await idToken({}, { omit: [claim] }))).toBe('claims');
        });
    });

    describe('nonce', () => {
        it('refuses a token minted for another sign-in', async () => {
            expect(await refusalOf(await idToken({ nonce: 'another-flow' }))).toBe('nonce');
        });

        it('refuses a token that carries none', async () => {
            expect(await refusalOf(await idToken({}, { omit: ['nonce'] }))).toBe('nonce');
        });
    });

    describe('claims', () => {
        it('refuses an email claim that is not an address', async () => {
            expect(await refusalOf(await idToken({ email: 'not-an-email' }))).toBe('claims');
        });

        it('refuses an empty subject', async () => {
            expect(await refusalOf(await idToken({ sub: '' }))).toBe('claims');
        });

        it('refuses a token with no subject', async () => {
            expect(await refusalOf(await idToken({}, { omit: ['sub'] }))).toBe('claims');
        });
    });

    it("picks up the IdP's new key after it rotates, re-fetching at most every 30 seconds", async () => {
        await expect(verify(await idToken())).resolves.toMatchObject({ sub: 'ext-user-1' });
        const keySetFetches = () => fetchMock.mock.calls.filter(([u]) => String(u) === DISCOVERY.jwks_uri).length;
        expect(keySetFetches()).toBe(1);

        const rotated = await generateKeyPair('RS256', { extractable: true });
        const previous = jwks;
        jwks = { keys: [{ ...(await exportJWK(rotated.publicKey)), kid: 'idp-key-2', alg: 'RS256', use: 'sig' }] };
        const signedWithNewKey = await idToken({}, { key: rotated.privateKey, kid: 'idp-key-2' });
        try {
            // Straight after a fetch, an unknown key does not trigger another:
            // a stream of tokens naming made-up keys cannot make this server
            // hammer the IdP.
            expect(await refusalOf(signedWithNewKey)).toBe('signature');
            expect(keySetFetches()).toBe(1);

            const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
            try {
                await expect(verify(signedWithNewKey)).resolves.toMatchObject({ sub: 'ext-user-1' });
            } finally {
                clock.mockRestore();
            }
            expect(keySetFetches()).toBe(2);
        } finally {
            jwks = previous;
        }
    });

    it("refuses when the IdP's keys cannot be read", async () => {
        jwksStatus = 500;
        expect(await refusalOf(await idToken())).toBe('keys_unavailable');
    });
});

// ─── The callback ────────────────────────────────────────────────────

/** The callback request a browser makes after this flow went to the IdP. */
function callbackRequest(): NextRequest {
    const flow = prepareSsoFlow(
        'oidc',
        encodeState({ tenantSlug: 'acme', providerId: 'idp-1', codeVerifier: 'verifier', nonce: NONCE }),
    );
    const bound = NextResponse.next();
    flow.bind(bound);
    const cookie = bound.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return new NextRequest(
        `http://localhost:3000/api/auth/sso/oidc/callback?code=auth-code&state=${encodeURIComponent(flow.id)}`,
        { headers: { cookie } },
    );
}

async function signInWith(token: string) {
    issuedIdToken = token;
    const res = await oidcCallback(callbackRequest());
    const location = new URL(res.headers.get('location')!);
    const handoff = res.headers.getSetCookie().find((c) => c.startsWith(`${SSO_HANDOFF_COOKIE}=`));
    return { location, handoff };
}

describe('the OIDC callback', () => {
    it('signs in on a token the IdP signed', async () => {
        const { location, handoff } = await signInWith(await idToken());
        expect(location.pathname).toBe('/login/sso-complete');
        expect(handoff).toBeDefined();
        expect(linkExternalIdentity).toHaveBeenCalledWith('tenant-1', 'idp-1', 'ext-user-1', 'alice@acme.example');
    });

    it('refuses a forged token: no account is linked and no hand-off is issued', async () => {
        const { location, handoff } = await signInWith(
            await idToken({ sub: 'ext-victim', email: 'ceo@acme.example' }, { key: attackerKey }),
        );
        expect(location.pathname).toBe('/login');
        expect(location.searchParams.get('error')).toBe('id_token_invalid');
        expect(handoff).toBeUndefined();
        expect(handoffRows).toHaveLength(0);
        expect(linkExternalIdentity).not.toHaveBeenCalled();
    });

    it('refuses the unsigned shape the old decoder accepted', async () => {
        const { location, handoff } = await signInWith(
            unsignedToken({ alg: 'RS256' }, { sub: 'ext-victim', email: 'ceo@acme.example', nonce: NONCE }),
        );
        expect(location.searchParams.get('error')).toBe('id_token_invalid');
        expect(handoff).toBeUndefined();
        expect(linkExternalIdentity).not.toHaveBeenCalled();
    });

    it('reports a nonce from another sign-in as a nonce mismatch', async () => {
        const { location, handoff } = await signInWith(await idToken({ nonce: 'another-flow' }));
        expect(location.searchParams.get('error')).toBe('nonce_mismatch');
        expect(handoff).toBeUndefined();
    });
});
