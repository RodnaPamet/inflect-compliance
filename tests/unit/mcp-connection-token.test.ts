/**
 * MINTING THE TOKEN AN MCP CONNECTION PRESENTS.
 *
 * A connection that stores a bearer token works for an hour and then fails as a
 * 401 somebody has to diagnose. Storing what MINTS a token is the fix, and the
 * three things that make it safe are asserted here rather than assumed:
 *
 *   · the tenant id is INTERPOLATED INTO A URL and arrives from tenant
 *     configuration. Anything but a GUID is refused before a request is made —
 *     an unvalidated segment in a URL we construct is how a path becomes
 *     somewhere else.
 *   · a ROTATED refresh token reaches the caller. Entra may hand back a new one
 *     on any refresh; dropping it strands the connection at the next expiry,
 *     hours later, with nothing pointing back at the cause.
 *   · the error CODE is surfaced and the DESCRIPTION is not. Entra's
 *     `error_description` echoes request parameters, and this string reaches
 *     logs.
 */
const safeFetchMock = jest.fn();
jest.mock('@/app-layer/automation/webhook-safety', () => ({
    safeFetch: (...a: unknown[]) => safeFetchMock(...a),
}));

import {
    authorizationForConnection,
    mintAccessToken,
    McpTokenError,
    _resetTokenCache,
} from '@/app-layer/integrations/mcp/token';

const TENANT = '0fc6f345-0eee-4408-89a9-96fdd1b6439d';
const creds = {
    tenantId: TENANT,
    clientId: 'client-1',
    clientSecret: 'secret-1',
    refreshToken: 'refresh-1',
};

const tokenResponse = (payload: object, ok = true, status = 200) => ({
    ok,
    status,
    text: async () => JSON.stringify(payload),
});

beforeEach(() => {
    // `mockReset`, not `clearAllMocks`: the latter clears CALL RECORDS but
    // leaves queued `mockResolvedValueOnce` implementations in place, so a test
    // that queues two responses and consumes one bleeds the leftover into the
    // next test — which then fails for a reason that has nothing to do with it.
    safeFetchMock.mockReset();
    _resetTokenCache();
});

describe('the tenant id is validated before it reaches a URL', () => {
    it.each([
        ['a path traversal', '../../evil'],
        ['a hostname', 'evil.example.com'],
        ['empty', ''],
        ['nearly a guid', '0fc6f345-0eee-4408-89a9-96fdd1b6439'],
    ])('refuses %s without making a request', async (_label, tenantId) => {
        await expect(mintAccessToken({ ...creds, tenantId })).rejects.toThrow(/GUID/);
        expect({ requests: safeFetchMock.mock.calls.length }).toEqual({ requests: 0 });
    });

    it('accepts a real guid and posts to that tenant', async () => {
        safeFetchMock.mockResolvedValue(tokenResponse({ access_token: 'at-1', expires_in: 3600 }));
        await mintAccessToken(creds);
        expect(safeFetchMock.mock.calls[0][0]).toBe(
            `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
        );
    });
});

describe('minting', () => {
    it('returns the access token and when it expires', async () => {
        safeFetchMock.mockResolvedValue(tokenResponse({ access_token: 'at-1', expires_in: 3600 }));
        const t = await mintAccessToken(creds);
        expect(t.accessToken).toBe('at-1');
        expect(t.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
        expect(t.rotatedRefreshToken).toBeNull();
    });

    it('treats a missing expires_in as the shortest plausible life, not an hour', async () => {
        safeFetchMock.mockResolvedValue(tokenResponse({ access_token: 'at-1' }));
        const t = await mintAccessToken(creds);
        // 300s, not 3600 — assuming an hour would hand out a token that is
        // already dead and blame the server for the 401.
        expect(t.expiresAt).toBeLessThan(Date.now() + 400_000);
    });

    it('surfaces a rotated refresh token', async () => {
        safeFetchMock.mockResolvedValue(
            tokenResponse({ access_token: 'at-1', expires_in: 3600, refresh_token: 'refresh-2' }),
        );
        expect((await mintAccessToken(creds)).rotatedRefreshToken).toBe('refresh-2');
    });
});

describe('refusals are legible without being leaky', () => {
    it('names the error CODE', async () => {
        safeFetchMock.mockResolvedValue(
            tokenResponse({ error: 'invalid_grant', error_description: 'AADSTS70008: expired' }, false, 400),
        );
        await expect(mintAccessToken(creds)).rejects.toThrow(/invalid_grant/);
    });

    it('does NOT echo the description, which can carry request parameters', async () => {
        safeFetchMock.mockResolvedValue(
            tokenResponse(
                { error: 'invalid_client', error_description: 'AADSTS7000215: secret is refresh-1' },
                false,
                401,
            ),
        );
        await expect(mintAccessToken(creds)).rejects.toThrow(
            expect.objectContaining({
                message: expect.not.stringContaining('AADSTS7000215'),
            }) as unknown as Error,
        );
    });

    it('refuses a success response that carries no token', async () => {
        safeFetchMock.mockResolvedValue(tokenResponse({ token_type: 'Bearer' }));
        await expect(mintAccessToken(creds)).rejects.toThrow(/no access_token/);
    });

    it('refuses a non-JSON body', async () => {
        safeFetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '<html>' });
        await expect(mintAccessToken(creds)).rejects.toThrow(McpTokenError);
    });
});

describe('caching', () => {
    it('mints once and reuses, rather than paying per call', async () => {
        safeFetchMock.mockResolvedValue(tokenResponse({ access_token: 'at-1', expires_in: 3600 }));
        const a = await authorizationForConnection('conn-1', creds);
        const b = await authorizationForConnection('conn-1', creds);
        expect(a).toBe('Bearer at-1');
        expect(b).toBe('Bearer at-1');
        expect({ mints: safeFetchMock.mock.calls.length }).toEqual({ mints: 1 });
    });

    it('does not hand one connection another connection\'s token', async () => {
        safeFetchMock
            .mockResolvedValueOnce(tokenResponse({ access_token: 'at-1', expires_in: 3600 }))
            .mockResolvedValueOnce(tokenResponse({ access_token: 'at-2', expires_in: 3600 }));
        expect(await authorizationForConnection('conn-1', creds)).toBe('Bearer at-1');
        expect(await authorizationForConnection('conn-2', creds)).toBe('Bearer at-2');
    });

    /** Inside the renew margin the cached token is discarded rather than risked. */
    it('re-mints a token that is about to expire', async () => {
        safeFetchMock
            .mockResolvedValueOnce(tokenResponse({ access_token: 'at-1', expires_in: 60 }))
            .mockResolvedValueOnce(tokenResponse({ access_token: 'at-2', expires_in: 3600 }));
        expect(await authorizationForConnection('conn-1', creds)).toBe('Bearer at-1');
        expect(await authorizationForConnection('conn-1', creds)).toBe('Bearer at-2');
        expect({ mints: safeFetchMock.mock.calls.length }).toEqual({ mints: 2 });
    });

    it('hands a rotated refresh token to the caller to persist', async () => {
        safeFetchMock.mockResolvedValue(
            tokenResponse({ access_token: 'at-1', expires_in: 3600, refresh_token: 'refresh-2' }),
        );
        const persisted: string[] = [];
        await authorizationForConnection('conn-1', creds, async (rt) => {
            persisted.push(rt);
        });
        expect(persisted).toEqual(['refresh-2']);
    });
});
