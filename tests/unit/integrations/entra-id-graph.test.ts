/**
 * Coverage wave E batch 3 — Entra ID's Graph surfaces:
 * the exported client-credentials token exchange, plus the three bulk
 * enrichment readers driven through a routing `fetchImpl` with real payloads.
 *
 * The first Entra suite (`entra-id-provider.test.ts`) proves each enrichment
 * DEGRADES safely when its surface fails. This one proves each one is
 * CORRECT when it succeeds — the other half of the H2 contract. A signal that
 * degrades safely but computes the wrong answer on the happy path is worse
 * than one that fails loudly.
 */
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
    EntraIdProvider,
    getEntraAccessToken,
} from '@/app-layer/integrations/providers/entra-id';

const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const graphUser = (over: Record<string, unknown> = {}) => ({
    id: 'u-1',
    displayName: 'Ada',
    userPrincipalName: 'ada@acme.com',
    accountEnabled: true,
    ...over,
});

/** Route Graph calls, allowing multi-page bodies per surface. */
function routedFetch(routes: {
    users?: unknown[];
    roles?: unknown[];
    mfa?: unknown[];
    domains?: unknown[] | 'fail';
}) {
    const counters: Record<string, number> = {};
    const take = (key: string, pages: unknown[] | undefined, fallback: unknown) => {
        if (!pages) return jsonOk(fallback);
        const i = counters[key] ?? 0;
        counters[key] = i + 1;
        return jsonOk(pages[Math.min(i, pages.length - 1)]);
    };
    return jest.fn(async (url: string) => {
        if (url.includes('/users')) return take('users', routes.users, { value: [] });
        if (url.includes('directoryRoles')) return take('roles', routes.roles, { value: [] });
        if (url.includes('userRegistrationDetails'))
            return take('mfa', routes.mfa, { value: [] });
        if (url.includes('/domains')) {
            if (routes.domains === 'fail') return { ok: false, status: 403 };
            return take('domains', routes.domains as unknown[], { value: [] });
        }
        return jsonOk({});
    });
}

const CONFIG = { tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'shh' };

const listWith = async (
    routes: Parameters<typeof routedFetch>[0],
    config: Record<string, unknown> = CONFIG,
) => {
    const fetchImpl = routedFetch(routes);
    const p = new EntraIdProvider({
        getAccessToken: async () => 'tok',
        fetchImpl: fetchImpl as never,
    });
    return p.listAccounts(config);
};

describe('getEntraAccessToken', () => {
    it('POSTs the client-credentials grant to the tenant token endpoint', async () => {
        const doFetch = jest
            .fn()
            .mockResolvedValue(jsonOk({ access_token: 'at-123' }));

        const token = await getEntraAccessToken(CONFIG, doFetch as never);

        expect(token).toBe('at-123');
        const [url, init] = doFetch.mock.calls[0];
        expect(url).toBe(
            'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token',
        );
        expect(init.method).toBe('POST');
        expect(init.headers['Content-Type']).toBe(
            'application/x-www-form-urlencoded',
        );
        const body = init.body as URLSearchParams;
        expect(body.get('grant_type')).toBe('client_credentials');
        expect(body.get('client_id')).toBe('client-1');
        expect(body.get('client_secret')).toBe('shh');
        expect(body.get('scope')).toBe('https://graph.microsoft.com/.default');
    });

    it('url-encodes the tenant id', async () => {
        const doFetch = jest.fn().mockResolvedValue(jsonOk({ access_token: 'x' }));
        await getEntraAccessToken({ ...CONFIG, tenantId: 'a b/c' }, doFetch as never);
        expect(doFetch.mock.calls[0][0]).toContain('a%20b%2Fc');
    });

    it('trims whitespace around the ids', async () => {
        const doFetch = jest.fn().mockResolvedValue(jsonOk({ access_token: 'x' }));
        await getEntraAccessToken(
            { tenantId: '  t  ', clientId: '  c  ', clientSecret: 'shh' },
            doFetch as never,
        );
        expect(doFetch.mock.calls[0][0]).toContain('/t/oauth2');
        expect((doFetch.mock.calls[0][1].body as URLSearchParams).get('client_id')).toBe(
            'c',
        );
    });

    it('refuses to send an absent secret rather than coercing it to empty', async () => {
        // This assertion is inverted from what it used to be. The old contract
        // was "an absent secret coerces to empty rather than 'undefined'",
        // which sent `client_secret=` and drew
        //   401 AADSTS7000218 "The request body must contain ... client_secret"
        // — our own malformed request. Because resilientFetch converts EVERY
        // 401 into IntegrationAuthError, that answer marked the connection
        // credential-failed and stripped the job of its retries, so a secret
        // missing because it failed to decrypt was recorded permanently as
        // "your credentials are revoked".
        //
        // Not sending the request is the whole fix, so that is what is asserted.
        const doFetch = jest.fn().mockResolvedValue(jsonOk({ access_token: 'x' }));
        await expect(
            getEntraAccessToken({ tenantId: 't', clientId: 'c' }, doFetch as never),
        ).rejects.toThrow(/clientSecret is missing/);
        expect(doFetch).not.toHaveBeenCalled();
    });

    it('throws with the status on a rejected exchange', async () => {
        const doFetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
        await expect(getEntraAccessToken(CONFIG, doFetch as never)).rejects.toThrow(
            'Entra token exchange failed (HTTP 401)',
        );
    });

    it('throws when the response carries no access_token', async () => {
        const doFetch = jest.fn().mockResolvedValue(jsonOk({}));
        await expect(getEntraAccessToken(CONFIG, doFetch as never)).rejects.toThrow(
            'Entra token exchange returned no access_token',
        );
    });
});

describe('Entra admin-role enrichment', () => {
    const userRole = (ids: string[]) => ({
        value: [
            {
                members: ids.map((id) => ({
                    id,
                    '@odata.type': '#microsoft.graph.user',
                })),
            },
        ],
    });

    it('marks role members as admins and everyone else as definitively not', async () => {
        const res = await listWith({
            users: [{ value: [graphUser({ id: 'admin-1' }), graphUser({ id: 'plain-1' })] }],
            roles: [userRole(['admin-1'])],
        });

        const byId = Object.fromEntries(
            res.accounts.map((a) => [a.externalUserId, a.isAdmin]),
        );
        expect(byId['admin-1']).toBe(true);
        // Authoritative false, not unknown — the roles read succeeded.
        expect(byId['plain-1']).toBe(false);
    });

    it('ignores non-user role members (groups, service principals)', async () => {
        const res = await listWith({
            users: [{ value: [graphUser({ id: 'sp-1' })] }],
            roles: [
                {
                    value: [
                        {
                            members: [
                                { id: 'sp-1', '@odata.type': '#microsoft.graph.servicePrincipal' },
                                { id: 'grp-1', '@odata.type': '#microsoft.graph.group' },
                            ],
                        },
                    ],
                },
            ],
        });
        expect(res.accounts[0].isAdmin).toBe(false);
    });

    it('tolerates roles with no members and members with no id', async () => {
        const res = await listWith({
            users: [{ value: [graphUser()] }],
            roles: [{ value: [{}, { members: [{ '@odata.type': '#microsoft.graph.user' }] }] }],
        });
        expect(res.accounts[0].isAdmin).toBe(false);
    });

    it('follows pagination across role pages', async () => {
        const res = await listWith({
            users: [{ value: [graphUser({ id: 'a' }), graphUser({ id: 'b' })] }],
            roles: [
                {
                    ...userRole(['a']),
                    '@odata.nextLink': 'https://graph.microsoft.com/v1.0/directoryRoles?p=2',
                },
                userRole(['b']),
            ],
        });
        expect(res.accounts.every((a) => a.isAdmin)).toBe(true);
    });
});

describe('Entra MFA-registration enrichment', () => {
    it('applies the registration report per user id', async () => {
        const res = await listWith({
            users: [{ value: [graphUser({ id: 'u-1' }), graphUser({ id: 'u-2' })] }],
            mfa: [
                {
                    value: [
                        { id: 'u-1', isMfaRegistered: true },
                        { id: 'u-2', isMfaRegistered: false },
                    ],
                },
            ],
        });

        const byId = Object.fromEntries(
            res.accounts.map((a) => [a.externalUserId, a.mfaEnrolled]),
        );
        expect(byId['u-1']).toBe(true);
        expect(byId['u-2']).toBe(false);
    });

    it('leaves users absent from the report unknown', async () => {
        const res = await listWith({
            users: [{ value: [graphUser({ id: 'u-1' }), graphUser({ id: 'ghost' })] }],
            mfa: [{ value: [{ id: 'u-1', isMfaRegistered: true }] }],
        });
        const ghost = res.accounts.find((a) => a.externalUserId === 'ghost')!;
        expect(ghost.mfaEnrolled).toBeNull();
    });

    it('coerces a missing isMfaRegistered flag to false', async () => {
        const res = await listWith({
            users: [{ value: [graphUser({ id: 'u-1' })] }],
            mfa: [{ value: [{ id: 'u-1' }] }],
        });
        expect(res.accounts[0].mfaEnrolled).toBe(false);
    });

    it('ignores report rows with no id, and follows pagination', async () => {
        const res = await listWith({
            users: [{ value: [graphUser({ id: 'u-2' })] }],
            mfa: [
                {
                    value: [{ isMfaRegistered: true }],
                    '@odata.nextLink':
                        'https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails?p=2',
                },
                { value: [{ id: 'u-2', isMfaRegistered: true }] },
            ],
        });
        expect(res.accounts[0].mfaEnrolled).toBe(true);
    });
});

describe('Entra federated-domain (SSO) enrichment', () => {
    const domains = (list: unknown[]) => [{ value: list }];

    it('marks accounts on a Federated domain as SSO-enrolled', async () => {
        const res = await listWith({
            users: [{ value: [graphUser({ userPrincipalName: 'ada@acme.com', mail: null })] }],
            domains: domains([{ id: 'acme.com', authenticationType: 'Federated' }]),
        });
        expect(res.accounts[0].ssoEnrolled).toBe(true);
    });

    it('marks accounts on a Managed domain as NOT SSO-enrolled', async () => {
        const res = await listWith({
            users: [{ value: [graphUser({ mail: null })] }],
            domains: domains([{ id: 'acme.com', authenticationType: 'Managed' }]),
        });
        expect(res.accounts[0].ssoEnrolled).toBe(false);
    });

    it('matches the domain case-insensitively', async () => {
        const res = await listWith({
            users: [{ value: [graphUser({ mail: 'Ada@ACME.com' })] }],
            domains: domains([{ id: 'ACME.com', authenticationType: 'Federated' }]),
        });
        expect(res.accounts[0].ssoEnrolled).toBe(true);
    });

    it('leaves an account on an unverified-set domain unknown (e.g. a guest)', async () => {
        const res = await listWith({
            users: [
                { value: [graphUser({ mail: 'guest_partner.com#EXT#@acme.onmicrosoft.com' })] },
            ],
            domains: domains([{ id: 'acme.com', authenticationType: 'Federated' }]),
        });
        expect(res.accounts[0].ssoEnrolled).toBeNull();
    });

    it('excludes explicitly unverified domains', async () => {
        const res = await listWith({
            users: [{ value: [graphUser({ mail: null })] }],
            domains: domains([
                { id: 'acme.com', authenticationType: 'Federated', isVerified: false },
            ]),
        });
        expect(res.accounts[0].ssoEnrolled).toBeNull();
    });

    it('leaves SSO unknown when the domains list is empty', async () => {
        const res = await listWith({
            users: [{ value: [graphUser({ mail: null })] }],
            domains: domains([]),
        });
        expect(res.accounts[0].ssoEnrolled).toBeNull();
    });

    it('leaves SSO unknown for an account with no parseable domain', async () => {
        const res = await listWith({
            users: [{ value: [graphUser({ mail: 'no-at-sign', userPrincipalName: undefined })] }],
            domains: domains([{ id: 'acme.com', authenticationType: 'Federated' }]),
        });
        expect(res.accounts[0].ssoEnrolled).toBeNull();
    });

    it('leaves SSO unknown when the domains read is rejected', async () => {
        const res = await listWith({
            users: [{ value: [graphUser({ mail: null })] }],
            domains: 'fail',
        });
        expect(res.accounts[0].ssoEnrolled).toBeNull();
    });
});
