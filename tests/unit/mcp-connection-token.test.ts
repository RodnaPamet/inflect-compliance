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
    authorizationFor,
    authorizationForConnection,
    mintAccessToken,
    mintAppOnlyToken,
    resolveMcpCredentials,
    McpTokenError,
    _resetTokenCache,
} from '@/app-layer/integrations/mcp/token';

const TENANT = '0fc6f345-0eee-4408-89a9-96fdd1b6439d';
/**
 * The DELEGATED credential, and `kind` is spelled out (#3467).
 *
 * `McpCredentials` is a discriminated union with a REQUIRED discriminant, and
 * the compiler named all seven call sites here the moment it became one. That
 * is the point of requiring it: the grant decides whether a named person
 * bounds what the token can reach, so a caller that did not say which grant it
 * meant should not get one by default.
 */
const creds = {
    kind: 'delegated' as const,
    tenantId: TENANT,
    clientId: 'client-1',
    clientSecret: 'secret-1',
    refreshToken: 'refresh-1',
};

/** The APP-ONLY credential: no refresh token, and a scope it must carry. */
const appOnly = {
    kind: 'app-only' as const,
    tenantId: TENANT,
    clientId: 'client-1',
    clientSecret: 'secret-1',
    scope: 'https://mcp.svc.cloud.microsoft/.default',
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

/**
 * THE BRANCHING RESOLVER.
 *
 * `authorizationFor` decides WHICH credential a connection means, and until now
 * nothing tested it — only `authorizationForConnection` (minting, caching,
 * rotation) and `mintAccessToken` below it had coverage.
 *
 * That gap had a cost. `listExternalMcpTools` bypassed this function entirely
 * and read `secrets.authorization` itself, so an Entra-backed connection got no
 * header at all and the server answered 401 — while "Test connection", which
 * minted through a second copy of the logic, stayed green. This function's own
 * docstring names that hazard ("Two would be the shape where 'Test connection'
 * succeeds and the agent fails"); it was true and untested at the same time.
 */
describe('authorizationFor — which credential a connection means', () => {
    const OAUTH_CONFIG = { tenantId: TENANT, clientId: 'client-1' };
    const OAUTH_SECRETS = { clientSecret: 'secret-1', refreshToken: 'refresh-1' };

    it('returns the static header when that is all the connection carries', async () => {
        const out = await authorizationFor('conn-1', {}, { authorization: 'Bearer pasted' });
        expect(out).toBe('Bearer pasted');
        expect({ requests: safeFetchMock.mock.calls.length }).toEqual({ requests: 0 });
    });

    it('trims a static header rather than sending stray whitespace', async () => {
        expect(await authorizationFor('conn-1', {}, { authorization: '  Bearer pasted  ' }))
            .toBe('Bearer pasted');
    });

    it('returns undefined when the connection carries no credential at all', async () => {
        expect(await authorizationFor('conn-1', {}, {})).toBeUndefined();
        expect({ requests: safeFetchMock.mock.calls.length }).toEqual({ requests: 0 });
    });

    it('MINTS for an OAuth connection, which is the case the catalogue used to miss', async () => {
        safeFetchMock.mockResolvedValueOnce(
            tokenResponse({ access_token: 'at-oauth', expires_in: 3600 }),
        );
        expect(await authorizationFor('conn-1', OAUTH_CONFIG, OAUTH_SECRETS))
            .toBe('Bearer at-oauth');
    });

    it('prefers the refresh flow over a static header when both are present', async () => {
        // A connection carrying both has been migrated from a pasted token to a
        // real flow, and the flow is the one that still works tomorrow.
        safeFetchMock.mockResolvedValueOnce(
            tokenResponse({ access_token: 'at-oauth', expires_in: 3600 }),
        );
        const out = await authorizationFor(
            'conn-1',
            OAUTH_CONFIG,
            { ...OAUTH_SECRETS, authorization: 'Bearer stale-pasted' },
        );
        expect(out).toBe('Bearer at-oauth');
        expect(out).not.toBe('Bearer stale-pasted');
    });

    it.each([
        ['no clientId', { tenantId: TENANT }, { clientSecret: 's', refreshToken: 'r' }],
        // RELABELLED (#3467). This read "no refreshToken", and since the
        // client-credentials grant landed that is no longer what makes it
        // partial: tenantId + clientId + clientSecret with a SCOPE is a
        // complete app-only credential. What is missing here is the thing that
        // would select EITHER grant.
        ['neither a refreshToken nor a scope', OAUTH_CONFIG, { clientSecret: 's' }],
        ['no clientSecret', OAUTH_CONFIG, { refreshToken: 'r' }],
        ['only a tenantId', { tenantId: TENANT }, {}],
    ])('refuses a PARTIAL Entra connection (%s) rather than falling back', async (_l, cfg, sec) => {
        // Falling back to the static header here would work until the pasted
        // token died and then look like a server problem.
        await expect(authorizationFor('conn-1', cfg, { ...sec, authorization: 'Bearer pasted' }))
            .rejects.toThrow(McpTokenError);
        expect({ requests: safeFetchMock.mock.calls.length }).toEqual({ requests: 0 });
    });

    it('passes a rotation callback through to the minting layer', async () => {
        safeFetchMock.mockResolvedValueOnce(
            tokenResponse({ access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-2' }),
        );
        const rotated: string[] = [];
        await authorizationFor('conn-1', OAUTH_CONFIG, OAUTH_SECRETS, async (rt) => {
            rotated.push(rt);
        });
        expect(rotated).toEqual(['rt-2']);
    });
});

/*
    ═══ THE CLIENT-CREDENTIALS GRANT (#3467) ═══

    Found by a proving run against Microsoft's Entra MCP gateway, not by
    reading the code: the gateway accepts an app-only token and this provider
    could not send one, so the only way to connect was a pasted bearer that
    expires in about an hour.

    The module's own header had argued the opposite — "client credentials
    cannot work against it however the app registration is configured" — on a
    real measurement of a DIFFERENT resource's `appRoles: []`. Both
    measurements stand; the conclusion drawn from the first did not survive
    meeting the second. These cases pin what the grant now does.
*/
describe('the app-only grant', () => {
    it('posts grant_type=client_credentials with the scope and no refresh token', async () => {
        safeFetchMock.mockResolvedValue(tokenResponse({ access_token: 'at-app', expires_in: 3600 }));
        const t = await mintAppOnlyToken(appOnly);
        const form = new URLSearchParams(String(safeFetchMock.mock.calls[0][1].body));
        expect({
            grant: form.get('grant_type'),
            scope: form.get('scope'),
            refresh: form.get('refresh_token'),
            token: t.accessToken,
        }).toEqual({
            grant: 'client_credentials',
            scope: 'https://mcp.svc.cloud.microsoft/.default',
            // ABSENT, not empty. A `refresh_token=` on a client-credentials
            // form is a different request, and Entra answers it differently.
            refresh: null,
            token: 'at-app',
        });
    });

    it('reports no rotated refresh token, because the grant issues none', async () => {
        // Returned as null rather than omitted, so both grants share one result
        // shape and a caller cannot forget to handle rotation on one of them.
        safeFetchMock.mockResolvedValue(tokenResponse({ access_token: 'at-app', expires_in: 3600 }));
        expect((await mintAppOnlyToken(appOnly)).rotatedRefreshToken).toBeNull();
    });

    it('validates the tenant id before it reaches a URL, like the other grant', async () => {
        // The same reason: an unvalidated segment in a URL we construct is how
        // a path becomes somewhere else. Asserted on THIS grant too, because a
        // second entry point is a second place for the check to be missing.
        await expect(mintAppOnlyToken({ ...appOnly, tenantId: '../../evil' }))
            .rejects.toThrow(/GUID/);
        expect({ requests: safeFetchMock.mock.calls.length }).toEqual({ requests: 0 });
    });

    it('refuses an empty scope rather than minting for no audience', async () => {
        // THE FAILURE THIS PREVENTS IS A MISDIAGNOSIS. A token for the wrong
        // audience comes back from the server as
        // `401 InvalidAuthenticationToken — Invalid audience`, which reads as a
        // credential problem; the operator goes and rotates a secret that was
        // never wrong.
        await expect(mintAppOnlyToken({ ...appOnly, scope: '   ' }))
            .rejects.toThrow(/scope is required/);
        expect({ requests: safeFetchMock.mock.calls.length }).toEqual({ requests: 0 });
    });

    it('refuses offline_access rather than silently stripping it', async () => {
        // An operator who copied the delegated scope gets told which half does
        // not apply. Stripping would send something other than what they typed,
        // and Entra's own refusal names an AADSTS code rather than the field.
        await expect(
            mintAppOnlyToken({ ...appOnly, scope: 'https://x/.default offline_access' }),
        ).rejects.toThrow(/offline_access cannot be requested/);
        expect({ requests: safeFetchMock.mock.calls.length }).toEqual({ requests: 0 });
    });

    it('surfaces the error CODE and not the description, like the other grant', async () => {
        // Entra's `error_description` echoes request parameters and this string
        // reaches logs. Asserted per grant, because the shared POST helper is
        // the only thing making it true and a future grant could bypass it.
        safeFetchMock.mockResolvedValue(
            tokenResponse(
                { error: 'unauthorized_client', error_description: 'AADSTS7000215: secret=hunter2' },
                false,
                401,
            ),
        );
        const err = await mintAppOnlyToken(appOnly).catch((e: Error) => e);
        expect(String(err)).toContain('unauthorized_client');
        expect(String(err)).not.toContain('hunter2');
        expect(String(err)).toContain('client_credentials');
    });
});

describe('resolveMcpCredentials — which grant a connection means', () => {
    const BASE = { tenantId: TENANT, clientId: 'client-1' };

    it('a refresh token selects DELEGATED access', () => {
        const out = resolveMcpCredentials(BASE, { clientSecret: 's', refreshToken: 'r' });
        expect(out).toEqual({
            kind: 'delegated',
            tenantId: TENANT,
            clientId: 'client-1',
            clientSecret: 's',
            refreshToken: 'r',
        });
    });

    it('a scope with no refresh token selects APP-ONLY access', () => {
        const out = resolveMcpCredentials({ ...BASE, scope: 'https://x/.default' }, { clientSecret: 's' });
        expect(out).toEqual({
            kind: 'app-only',
            tenantId: TENANT,
            clientId: 'client-1',
            clientSecret: 's',
            scope: 'https://x/.default',
        });
    });

    it('a refresh token WINS over a scope, and the scope is carried not dropped', () => {
        // Both present is a delegated connection whose server has its own
        // audience — a real combination, and the scope is the audience the
        // delegated flow should ask for. Dropping it would silently fall back
        // to the Entra default and produce the invalid-audience 401.
        const out = resolveMcpCredentials({ ...BASE, scope: 'https://x/.default' }, { clientSecret: 's', refreshToken: 'r' });
        expect(out).toEqual({
            kind: 'delegated',
            tenantId: TENANT,
            clientId: 'client-1',
            clientSecret: 's',
            refreshToken: 'r',
            scope: 'https://x/.default',
        });
    });

    it('a SCOPE ALONE is not an Entra configuration', () => {
        // THE REGRESSION THIS BLOCKS. `scope` is a property of the SERVER, not
        // of the grant, so a connection authenticated by a static header may
        // carry one. Counting it as an OAuth field would turn "I told it my
        // server's audience" into "this connection is half-configured for
        // Entra" and refuse to save it.
        expect(resolveMcpCredentials({ scope: 'https://x/.default' }, {})).toBeNull();
    });

    it('returns null for a connection with nothing Entra-ish at all', () => {
        expect(resolveMcpCredentials({ url: 'https://x' }, { authorization: 'Bearer p' })).toBeNull();
    });

    it('names the MISSING FIELD for an app-only credential with no scope', () => {
        // The old message said "tenantId, clientId, clientSecret and
        // refreshToken are all required together" — true of the old code, and
        // the wrong thing to tell an operator who had deliberately supplied
        // three of them because their server wants app-only auth. It sent them
        // looking for a refresh token they cannot obtain.
        expect(() => resolveMcpCredentials(BASE, { clientSecret: 's' }))
            .toThrow(/app-only connection needs a scope/);
    });

    it('names BOTH grants when the shared three are incomplete', () => {
        expect(() => resolveMcpCredentials({ tenantId: TENANT }, { refreshToken: 'r' }))
            .toThrow(/required for either grant/);
    });
});

describe('authorizationFor mints by the app-only grant too', () => {
    it('reaches the client-credentials grant end to end', async () => {
        // THE COMPOSITION, not just the resolver. `authorizationFor` is what
        // the runtime calls, and a resolver that answered correctly into a
        // minting path that only knew one grant was the whole defect.
        safeFetchMock.mockResolvedValueOnce(
            tokenResponse({ access_token: 'at-app', expires_in: 3600 }),
        );
        const out = await authorizationFor(
            'conn-app',
            { tenantId: TENANT, clientId: 'client-1', scope: 'https://x/.default' },
            { clientSecret: 's' },
        );
        expect(out).toBe('Bearer at-app');
        expect(
            new URLSearchParams(String(safeFetchMock.mock.calls[0][1].body)).get('grant_type'),
        ).toBe('client_credentials');
    });

    it('caches an app-only token per connection, like a delegated one', async () => {
        safeFetchMock.mockResolvedValueOnce(
            tokenResponse({ access_token: 'at-app', expires_in: 3600 }),
        );
        const cfg = { tenantId: TENANT, clientId: 'client-1', scope: 'https://x/.default' };
        const a = await authorizationFor('conn-app', cfg, { clientSecret: 's' });
        const b = await authorizationFor('conn-app', cfg, { clientSecret: 's' });
        expect({ a, b, requests: safeFetchMock.mock.calls.length })
            .toEqual({ a: 'Bearer at-app', b: 'Bearer at-app', requests: 1 });
    });
});

