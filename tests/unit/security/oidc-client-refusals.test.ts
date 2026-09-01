/**
 * Refusal-path tests for `src/lib/security/oidc-client.ts`.
 *
 * The existing `tests/unit/oidc-flow.test.ts` covers the pure helpers
 * (PKCE, state codec, claim extraction, nonce compare). The two network
 * functions — `discoverOidc` and `exchangeCodeForTokens` — are the ones
 * reached from `/api/auth/sso/oidc/{start,callback}` and they were
 * entirely untested, including every one of their refusals: a
 * non-200 discovery, a discovery document missing the endpoints we are
 * about to trust, a token endpoint returning an error body, and a token
 * response with no `id_token` (which would otherwise fall through to a
 * claim extraction against `undefined`).
 *
 * The discovery cache is process-global, so every test clears it first
 * via the module's `_clearDiscoveryCache` test hook — otherwise a cached
 * document from an earlier test silently satisfies a later one and the
 * refusal never runs.
 */
import {
    discoverOidc,
    exchangeCodeForTokens,
    extractIdTokenClaims,
    _clearDiscoveryCache,
    validateIdTokenNonce,
    type OidcDiscoveryDocument,
} from '@/lib/security/oidc-client';
import type { OidcConfig } from '@/app-layer/schemas/sso-config.schemas';

// ─── Typed fetch double ──────────────────────────────────────────────
//
// Annotated explicitly rather than inferred from a bare `jest.fn()` so
// the compiler checks every `mockResolvedValueOnce` against the real
// `fetch` contract.
type FetchArgs = Parameters<typeof fetch>;
const mockFetch = jest.fn<Promise<Response>, FetchArgs>();
const realFetch = global.fetch;

beforeAll(() => {
    global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
    global.fetch = realFetch;
});

beforeEach(() => {
    mockFetch.mockReset();
    _clearDiscoveryCache();
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

/**
 * A failed response whose body cannot be read — models a truncated or
 * aborted error body from the IdP. `Response` cannot be constructed in
 * this state, hence the deliberate structural double.
 */
function unreadableErrorResponse(status: number): Response {
    return {
        ok: false,
        status,
        statusText: 'Bad Gateway',
        text: async (): Promise<string> => {
            throw new Error('body stream aborted');
        },
        json: async (): Promise<unknown> => {
            throw new Error('body stream aborted');
        },
    } as unknown as Response;
}

const FULL_DISCOVERY: OidcDiscoveryDocument = {
    issuer: 'https://idp.example.com',
    authorization_endpoint: 'https://idp.example.com/authorize',
    token_endpoint: 'https://idp.example.com/token',
    jwks_uri: 'https://idp.example.com/.well-known/jwks.json',
};

function oidcConfig(overrides: Partial<OidcConfig> = {}): OidcConfig {
    return {
        issuer: 'https://idp.example.com',
        clientId: 'client-123',
        clientSecret: 'client-secret-value',
        scopes: ['openid', 'email', 'profile'],
        ...overrides,
    };
}

function requestedUrl(callIndex = 0): string {
    return String(mockFetch.mock.calls[callIndex][0]);
}

// ─── discoverOidc — refusals ─────────────────────────────────────────

describe('discoverOidc — refusals', () => {
    it('REFUSES a non-200 discovery response, naming the status', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response('nope', { status: 404, statusText: 'Not Found' }),
        );
        await expect(discoverOidc(oidcConfig())).rejects.toThrow(
            'OIDC discovery failed: 404 Not Found',
        );
    });

    it('REFUSES a 500 from the IdP rather than proceeding without endpoints', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response('', { status: 500, statusText: 'Internal Server Error' }),
        );
        await expect(discoverOidc(oidcConfig())).rejects.toThrow(
            /OIDC discovery failed: 500/,
        );
    });

    it('REFUSES a document with no issuer', async () => {
        mockFetch.mockResolvedValueOnce(
            jsonResponse({ ...FULL_DISCOVERY, issuer: undefined }),
        );
        await expect(discoverOidc(oidcConfig())).rejects.toThrow(
            'OIDC discovery document missing required fields',
        );
    });

    it('REFUSES a document with no authorization_endpoint', async () => {
        mockFetch.mockResolvedValueOnce(
            jsonResponse({ ...FULL_DISCOVERY, authorization_endpoint: undefined }),
        );
        await expect(discoverOidc(oidcConfig())).rejects.toThrow(
            'OIDC discovery document missing required fields',
        );
    });

    it('REFUSES a document with no token_endpoint', async () => {
        mockFetch.mockResolvedValueOnce(
            jsonResponse({ ...FULL_DISCOVERY, token_endpoint: undefined }),
        );
        await expect(discoverOidc(oidcConfig())).rejects.toThrow(
            'OIDC discovery document missing required fields',
        );
    });

    it('does NOT cache a rejected document — the next call re-fetches', async () => {
        mockFetch.mockResolvedValueOnce(
            jsonResponse({ ...FULL_DISCOVERY, token_endpoint: undefined }),
        );
        await expect(discoverOidc(oidcConfig())).rejects.toThrow();

        mockFetch.mockResolvedValueOnce(jsonResponse(FULL_DISCOVERY));
        await expect(discoverOidc(oidcConfig())).resolves.toEqual(FULL_DISCOVERY);
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });
});

// ─── discoverOidc — URL derivation + caching ─────────────────────────

describe('discoverOidc — URL derivation', () => {
    it('derives the well-known URL from the issuer', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse(FULL_DISCOVERY));
        await discoverOidc(oidcConfig({ issuer: 'https://idp.example.com' }));
        expect(requestedUrl()).toBe(
            'https://idp.example.com/.well-known/openid-configuration',
        );
    });

    it('strips exactly one trailing slash from the issuer (no double slash)', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse(FULL_DISCOVERY));
        await discoverOidc(oidcConfig({ issuer: 'https://idp.example.com/' }));
        expect(requestedUrl()).toBe(
            'https://idp.example.com/.well-known/openid-configuration',
        );
    });

    it('prefers an explicit discoveryUrl override over the derived one', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse(FULL_DISCOVERY));
        await discoverOidc(
            oidcConfig({ discoveryUrl: 'https://idp.example.com/custom/config' }),
        );
        expect(requestedUrl()).toBe('https://idp.example.com/custom/config');
    });

    it('caches per discovery URL — a second call makes no network request', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse(FULL_DISCOVERY));
        const first = await discoverOidc(oidcConfig());
        const second = await discoverOidc(oidcConfig());

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(second).toBe(first);
    });

    it('keys the cache by URL — a different issuer does NOT reuse the entry', async () => {
        const other: OidcDiscoveryDocument = {
            ...FULL_DISCOVERY,
            issuer: 'https://other.example.com',
            token_endpoint: 'https://other.example.com/token',
        };
        mockFetch.mockResolvedValueOnce(jsonResponse(FULL_DISCOVERY));
        mockFetch.mockResolvedValueOnce(jsonResponse(other));

        const a = await discoverOidc(oidcConfig({ issuer: 'https://idp.example.com' }));
        const b = await discoverOidc(oidcConfig({ issuer: 'https://other.example.com' }));

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(a.token_endpoint).toBe('https://idp.example.com/token');
        expect(b.token_endpoint).toBe('https://other.example.com/token');
    });

    it('_clearDiscoveryCache forces the next call back onto the network', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse(FULL_DISCOVERY));
        await discoverOidc(oidcConfig());
        _clearDiscoveryCache();
        mockFetch.mockResolvedValueOnce(jsonResponse(FULL_DISCOVERY));
        await discoverOidc(oidcConfig());
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });
});

// ─── exchangeCodeForTokens — refusals ────────────────────────────────

describe('exchangeCodeForTokens — refusals', () => {
    it('REFUSES a non-200 token response, carrying the status and IdP error body', async () => {
        mockFetch.mockResolvedValueOnce(
            new Response('{"error":"invalid_grant"}', { status: 400 }),
        );
        await expect(
            exchangeCodeForTokens(
                FULL_DISCOVERY,
                oidcConfig(),
                'auth-code',
                'https://app.example.com/cb',
                'verifier',
            ),
        ).rejects.toThrow('OIDC token exchange failed: 400 {"error":"invalid_grant"}');
    });

    it('reports "unknown" rather than crashing when the error body cannot be read', async () => {
        mockFetch.mockResolvedValueOnce(unreadableErrorResponse(502));
        await expect(
            exchangeCodeForTokens(
                FULL_DISCOVERY,
                oidcConfig(),
                'auth-code',
                'https://app.example.com/cb',
                'verifier',
            ),
        ).rejects.toThrow('OIDC token exchange failed: 502 unknown');
    });

    it('REFUSES a 200 token response with no id_token', async () => {
        // A bare access_token authenticates nothing — without an id_token
        // there are no verified subject claims to sign anyone in with.
        mockFetch.mockResolvedValueOnce(
            jsonResponse({ access_token: 'at', token_type: 'Bearer' }),
        );
        await expect(
            exchangeCodeForTokens(
                FULL_DISCOVERY,
                oidcConfig(),
                'auth-code',
                'https://app.example.com/cb',
                'verifier',
            ),
        ).rejects.toThrow('OIDC token response missing id_token');
    });

    it('REFUSES an empty-string id_token as if it were absent', async () => {
        mockFetch.mockResolvedValueOnce(
            jsonResponse({ id_token: '', access_token: 'at', token_type: 'Bearer' }),
        );
        await expect(
            exchangeCodeForTokens(
                FULL_DISCOVERY,
                oidcConfig(),
                'auth-code',
                'https://app.example.com/cb',
                'verifier',
            ),
        ).rejects.toThrow('OIDC token response missing id_token');
    });
});

// ─── exchangeCodeForTokens — request shape ───────────────────────────

describe('exchangeCodeForTokens — request shape', () => {
    it('POSTs the PKCE verifier and client credentials as form-encoded body', async () => {
        mockFetch.mockResolvedValueOnce(
            jsonResponse({
                id_token: 'header.payload.sig',
                access_token: 'at',
                token_type: 'Bearer',
                expires_in: 3600,
            }),
        );

        const tokens = await exchangeCodeForTokens(
            FULL_DISCOVERY,
            oidcConfig(),
            'auth-code-xyz',
            'https://app.example.com/cb',
            'the-code-verifier',
        );

        expect(tokens.id_token).toBe('header.payload.sig');
        expect(tokens.expires_in).toBe(3600);

        expect(requestedUrl()).toBe('https://idp.example.com/token');
        const init = mockFetch.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('POST');
        expect(
            (init.headers as Record<string, string>)['Content-Type'],
        ).toBe('application/x-www-form-urlencoded');

        const body = new URLSearchParams(String(init.body));
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code')).toBe('auth-code-xyz');
        // The PKCE verifier is what stops a stolen authorization code from
        // being redeemed by anyone but the client that started the flow.
        expect(body.get('code_verifier')).toBe('the-code-verifier');
        expect(body.get('client_id')).toBe('client-123');
        expect(body.get('client_secret')).toBe('client-secret-value');
        // redirect_uri must match the one used at /authorize or the IdP
        // rejects the exchange.
        expect(body.get('redirect_uri')).toBe('https://app.example.com/cb');
    });
});

// ─── extractIdTokenClaims — malformed payloads ───────────────────────

describe('extractIdTokenClaims — malformed payloads', () => {
    function tokenWithRawPayload(payloadSegment: string): string {
        const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
        return `${header}.${payloadSegment}.${Buffer.from('sig').toString('base64url')}`;
    }

    it('REFUSES a token whose payload segment is not JSON', async () => {
        const token = tokenWithRawPayload(
            Buffer.from('definitely-not-json').toString('base64url'),
        );
        expect(() => extractIdTokenClaims(token)).toThrow();
    });

    it('REFUSES a token whose email claim is not a valid address', () => {
        const payload = Buffer.from(
            JSON.stringify({ sub: 'u1', email: 'not-an-email' }),
        ).toString('base64url');
        // The Zod refusal matters: an unparsable address flowing into user
        // provisioning would create an account keyed on garbage.
        expect(() => extractIdTokenClaims(tokenWithRawPayload(payload))).toThrow();
    });

    it('REFUSES a token whose sub claim is an empty string', () => {
        const payload = Buffer.from(JSON.stringify({ sub: '' })).toString('base64url');
        expect(() => extractIdTokenClaims(tokenWithRawPayload(payload))).toThrow();
    });

    it('REFUSES a two-segment token with the specific format error', () => {
        expect(() => extractIdTokenClaims('header.payload')).toThrow(
            'Invalid ID token format',
        );
    });

    it('REFUSES a four-segment token (JWE-shaped) with the format error', () => {
        expect(() => extractIdTokenClaims('a.b.c.d')).toThrow('Invalid ID token format');
    });

    it('drops unknown claims rather than passing them through', () => {
        const payload = Buffer.from(
            JSON.stringify({ sub: 'u1', is_admin: true, groups: ['x'] }),
        ).toString('base64url');
        const claims = extractIdTokenClaims(tokenWithRawPayload(payload));
        // An IdP-supplied `is_admin` must never reach the caller as a
        // claim it might trust.
        expect(claims).toStrictEqual({ sub: 'u1' });
    });
});

// ─── validateIdTokenNonce — malformed payloads ───────────────────────

describe('validateIdTokenNonce — malformed payloads', () => {
    function tokenWith(payloadSegment: string): string {
        const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
        return `${header}.${payloadSegment}.${Buffer.from('sig').toString('base64url')}`;
    }

    it('REFUSES (false) a token whose payload is not JSON, rather than throwing', () => {
        // The callback route calls this before anything else; a throw here
        // would surface as a 500 instead of a clean auth refusal.
        const token = tokenWith(Buffer.from('}{not json').toString('base64url'));
        expect(validateIdTokenNonce(token, 'expected')).toBe(false);
    });

    it('REFUSES a token that carries no nonce claim at all', () => {
        // Replay protection is the whole point — an absent nonce is not a
        // match, and must not compare equal to an absent expectation.
        const token = tokenWith(
            Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url'),
        );
        expect(validateIdTokenNonce(token, 'expected')).toBe(false);
    });

    it('accepts only an exact nonce match', () => {
        const token = tokenWith(
            Buffer.from(JSON.stringify({ sub: 'u1', nonce: 'abc' })).toString('base64url'),
        );
        expect(validateIdTokenNonce(token, 'abc')).toBe(true);
        expect(validateIdTokenNonce(token, 'abc ')).toBe(false);
        expect(validateIdTokenNonce(token, 'ABC')).toBe(false);
    });
});
