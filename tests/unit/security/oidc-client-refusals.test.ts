/**
 * Refusal-path tests for `src/lib/security/oidc-client.ts`.
 *
 * The existing `tests/unit/oidc-flow.test.ts` covers the pure helpers
 * (PKCE, state codec, authorization URL), and
 * `oidc-id-token-verification.test.ts` covers the ID token. The two network
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
// The identity provider is a double answering on the global `fetch`. The client
// reaches it through `safeFetch`, whose address checks are proved against this
// same client in oidc-client-egress.test.ts; here it hands the request straight
// to the double.
jest.mock('@/app-layer/automation/webhook-safety', () => ({
    ...jest.requireActual('@/app-layer/automation/webhook-safety'),
    safeFetch: (url: string, init?: RequestInit) => global.fetch(url, init),
}));

import {
    discoverOidc,
    exchangeCodeForTokens,
    _clearDiscoveryCache,
    encodeState,
    decodeState,
    type OidcDiscoveryDocument,
    type OidcStatePayload,
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
        // Inert literal: this config is only ever handed to a mocked
        // fetch, so nothing is authenticated with it.
        clientSecret: 'client-secret-value', // pragma: allowlist secret
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

    it('REFUSES a document with no jwks_uri: the ID token could not be verified', async () => {
        mockFetch.mockResolvedValueOnce(
            jsonResponse({ ...FULL_DISCOVERY, jwks_uri: undefined }),
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

// ─── decodeState — PKCE / replay field guards ────────────────────────
//
// `decodeState` is the callback route's FIRST parse of attacker-supplied
// input: the `state` query parameter comes straight back from the
// browser. Returning a truthy payload here is what lets the callback
// proceed to a token exchange, so each required field is a refusal in
// its own right. The pre-existing `oidc-flow` suite only checks a
// payload missing `tenantSlug`, which short-circuits the guard on its
// first clause and never exercises the PKCE / nonce clauses below.

describe('decodeState — required-field refusals', () => {
    const VALID: OidcStatePayload = {
        tenantSlug: 'acme-corp',
        providerId: 'provider-123',
        codeVerifier: 'verifier-abc',
        nonce: 'nonce-xyz',
    };

    function stateWithout(field: keyof OidcStatePayload): string {
        const partial: Record<string, unknown> = { ...VALID };
        delete partial[field];
        return Buffer.from(JSON.stringify(partial)).toString('base64url');
    }

    it('REFUSES a state carrying no codeVerifier — PKCE would be stripped', () => {
        // Without the verifier the callback cannot prove it started the
        // flow, which is precisely the interception attack PKCE exists to
        // stop. Accepting the state and exchanging the code anyway would
        // silently downgrade the flow to bare authorization-code.
        expect(decodeState(stateWithout('codeVerifier'))).toBeNull();
    });

    it('REFUSES a state carrying no nonce — replay protection would be lost', () => {
        // The nonce is compared against the ID token later; an absent one
        // means `verifyIdToken` has nothing to check against.
        expect(decodeState(stateWithout('nonce'))).toBeNull();
    });

    it('REFUSES a state carrying no providerId', () => {
        expect(decodeState(stateWithout('providerId'))).toBeNull();
    });

    it('REFUSES a state carrying no tenantSlug', () => {
        expect(decodeState(stateWithout('tenantSlug'))).toBeNull();
    });

    it('REFUSES an empty-string codeVerifier, not just an absent one', () => {
        // Empty string is falsy, so the same guard must reject it — an
        // attacker controls this value verbatim.
        const encoded = Buffer.from(
            JSON.stringify({ ...VALID, codeVerifier: '' }),
        ).toString('base64url');
        expect(decodeState(encoded)).toBeNull();
    });

    it('round-trips a complete payload, preserving the optional returnTo', () => {
        const withReturn: OidcStatePayload = { ...VALID, returnTo: '/dashboard' };
        // toStrictEqual so a field silently arriving as `undefined` is a
        // failure rather than an invisible pass.
        expect(decodeState(encodeState(withReturn))).toStrictEqual(withReturn);
    });
});

// ─── discoverOidc — cache EXPIRY ─────────────────────────────────────

describe('discoverOidc — cache expiry', () => {
    // The cache entry stores `expiresAt = Date.now() + 3600_000`. The
    // sibling tests above prove a fresh entry is REUSED; this one proves
    // a stale entry is not. Both halves are needed: without this test,
    // deleting the `expiresAt > Date.now()` clause is invisible, and a
    // tenant that rotates its IdP endpoints would keep being sent to the
    // old authorization endpoint for the life of the process.
    //
    // Fake timers, never a literal date: the assertion is about an
    // INTERVAL elapsing, so nothing here depends on the wall clock and
    // it cannot rot overnight.
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('re-fetches once the cached document has passed its TTL', async () => {
        // A fresh Response per call — a Response body can only be read
        // once, so a shared instance would fail on the re-fetch.
        mockFetch.mockImplementation(async () => jsonResponse(FULL_DISCOVERY));

        await discoverOidc(oidcConfig());
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Still inside the hour — must be served from cache.
        jest.advanceTimersByTime(3_599_000);
        await discoverOidc(oidcConfig());
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Past the hour — must go back to the network.
        jest.advanceTimersByTime(2_000);
        await discoverOidc(oidcConfig());
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });
});
