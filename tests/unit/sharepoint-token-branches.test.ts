/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/**
 * SP-1 — SharePoint token lifecycle: the DEFAULT arms.
 *
 * `sharepoint-token.test.ts` drives every dependency by injection (env, fetch,
 * clock, refresh) — which is what makes the token math testable, but it also
 * means the fallback half of each `??` / ternary never runs. Those defaults are
 * what production actually uses: the env-derived Entra app registration, the
 * resilient fetch (deadline + 429 handling + 401→IntegrationAuthError), the
 * shared `isTokenExpired` skew, and `refreshMicrosoftToken`.
 *
 * A regression in any of them is invisible to the injected-deps tests.
 */
const mockResilientFetch = jest.fn();
const mockRefreshMicrosoftToken = jest.fn();

jest.mock('@/app-layer/integrations/http-resilience', () => ({
    __esModule: true,
    ...jest.requireActual('@/app-layer/integrations/http-resilience'),
    resilientFetch: (...a: unknown[]) => mockResilientFetch(...a),
}));
jest.mock('@/lib/auth/refresh', () => ({
    __esModule: true,
    // isTokenExpired stays REAL — the point of the "no clock injected" tests is
    // that the module honours the shared 60s skew, not a re-declared copy of it.
    ...jest.requireActual('@/lib/auth/refresh'),
    refreshMicrosoftToken: (...a: unknown[]) => mockRefreshMicrosoftToken(...a),
}));

import {
    buildSharePointAuthorizeUrl,
    exchangeCodeForSharePointToken,
    resolveSharePointAccessToken,
    type SharePointSecret,
} from '@/app-layer/integrations/providers/sharepoint/token';

const jsonRes = (body: unknown, ok = true, status = 200): Response =>
    ({ ok, status, json: async () => body }) as unknown as Response;

/** Matches tests/mocks/env.ts, which backs `@/env` in the node project. */
const ENV_CLIENT_ID = 'test-ms-id';
const ENV_CLIENT_SECRET = 'test-ms-secret';
const ENV_TENANT_ID = 'test-tenant';

beforeEach(() => jest.clearAllMocks());

describe('the Entra app registration comes from env when not overridden', () => {
    it('builds the authorize URL against the env tenant + client id', () => {
        const url = buildSharePointAuthorizeUrl({ redirectUri: 'https://ic/cb', state: 's' });
        expect(url).toContain(`login.microsoftonline.com/${ENV_TENANT_ID}/oauth2/v2.0/authorize`);
        expect(url).toContain(`client_id=${ENV_CLIENT_ID}`);
    });

    it('takes each field independently — a partial override keeps the env rest', () => {
        const url = buildSharePointAuthorizeUrl({
            redirectUri: 'https://ic/cb',
            state: 's',
            env: { tenantId: 'override-tenant' },
        });
        expect(url).toContain('login.microsoftonline.com/override-tenant/');
        expect(url).toContain(`client_id=${ENV_CLIENT_ID}`);
    });

    it('sends the env client secret on the code exchange', async () => {
        const f = jest.fn().mockResolvedValue(jsonRes({ access_token: 'AT', refresh_token: 'RT', expires_in: 60 }));
        await exchangeCodeForSharePointToken({ code: 'c', redirectUri: 'https://ic/cb' }, { fetchImpl: f as any });
        const body = f.mock.calls[0][1].body as URLSearchParams;
        expect(body.get('client_id')).toBe(ENV_CLIENT_ID);
        expect(body.get('client_secret')).toBe(ENV_CLIENT_SECRET);
        expect(f.mock.calls[0][0]).toContain(`/${ENV_TENANT_ID}/oauth2/v2.0/token`);
    });
});

describe('the code exchange defaults to the resilient fetch', () => {
    it('posts through resilientFetch when no fetchImpl is injected', async () => {
        // Not an implementation detail: resilientFetch is what applies the
        // egress deadline, honours Retry-After, and turns a 401 into an
        // IntegrationAuthError. A bare `fetch` here would drop all three.
        mockResilientFetch.mockResolvedValue(
            jsonRes({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
        );
        const secret = await exchangeCodeForSharePointToken({ code: 'c', redirectUri: 'https://ic/cb' });
        expect(mockResilientFetch).toHaveBeenCalledTimes(1);
        expect(secret.accessToken).toBe('AT');
    });

    it('dates the expiry from the response TTL', async () => {
        const before = Math.floor(Date.now() / 1000);
        mockResilientFetch.mockResolvedValue(
            jsonRes({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
        );
        const secret = await exchangeCodeForSharePointToken({ code: 'c', redirectUri: 'r' });
        expect(secret.expiresAt).toBeGreaterThanOrEqual(before + 3600);
        expect(secret.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 3600);
    });
});

describe('resolveSharePointAccessToken with no injected clock or refresher', () => {
    const secret = (expiresAt: number): SharePointSecret => ({ accessToken: 'AT', refreshToken: 'RT', expiresAt });

    it('reuses a token that is outside the skew window', async () => {
        const res = await resolveSharePointAccessToken(secret(Math.floor(Date.now() / 1000) + 3600));
        expect(res).toEqual({ accessToken: 'AT', rotated: null });
        expect(mockRefreshMicrosoftToken).not.toHaveBeenCalled();
    });

    it('refreshes a token INSIDE the 60s skew, before it has actually expired', async () => {
        // The skew is the whole point: a token that expires in 30s would be
        // rejected mid-request if we handed it out.
        const nearly = Math.floor(Date.now() / 1000) + 30;
        mockRefreshMicrosoftToken.mockResolvedValue({ accessToken: 'AT2', expiresAt: 99_999_999_999 });
        const res = await resolveSharePointAccessToken(secret(nearly));
        expect(mockRefreshMicrosoftToken).toHaveBeenCalledWith('RT');
        expect(res.accessToken).toBe('AT2');
    });

    it('falls back to refreshMicrosoftToken when no refresher is injected', async () => {
        mockRefreshMicrosoftToken.mockResolvedValue({ accessToken: 'AT2', refreshToken: 'RT2', expiresAt: 12_345 });
        const res = await resolveSharePointAccessToken(secret(0), {});
        expect(mockRefreshMicrosoftToken).toHaveBeenCalledWith('RT');
        expect(res.rotated).toEqual({ accessToken: 'AT2', refreshToken: 'RT2', expiresAt: 12_345 });
    });

    it('returns the rotated pair even when there is nowhere to persist it', async () => {
        // No `persist` dep — the caller still needs the new token to use, and
        // `rotated` non-null is how it learns the secret on disk is stale.
        mockRefreshMicrosoftToken.mockResolvedValue({ accessToken: 'AT2', expiresAt: 500 });
        const res = await resolveSharePointAccessToken(secret(0));
        expect(res.rotated).toEqual({ accessToken: 'AT2', refreshToken: 'RT', expiresAt: 500 });
    });

    it('propagates a refresh failure rather than handing back the dead token', async () => {
        mockRefreshMicrosoftToken.mockRejectedValue(new Error('invalid_grant'));
        await expect(resolveSharePointAccessToken(secret(0))).rejects.toThrow('invalid_grant');
    });

    it('an injected clock overrides the ambient one', async () => {
        // now() is in MILLISECONDS; the module divides by 1000 before comparing.
        // A regression that forgot the divide would call a live token expired.
        const res = await resolveSharePointAccessToken(secret(10_000), { now: () => 1_000_000 });
        expect(res.rotated).toBeNull();
        expect(mockRefreshMicrosoftToken).not.toHaveBeenCalled();
    });
});
