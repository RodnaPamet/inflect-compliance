/**
 * Coverage wave E batch 2 — `providers/entra-id/index.ts`.
 *
 * Driven through a URL-routing `fetchImpl` so the Graph surfaces (users,
 * directory roles, MFA registration report, domains) can each be steered
 * independently.
 *
 * The behaviours worth locking:
 *   • the signInActivity retry — the full `$select` needs AuditLog.Read.All +
 *     a premium licence; a tenant without it must fall back to the base select
 *     and still enumerate, not fail the sync.
 *   • H2 tri-state signals — isAdmin / mfaEnrolled / ssoEnrolled start `null`
 *     (unknown) and each enrichment is independently wrapped, so one failing
 *     Graph surface leaves its signal NOT_APPLICABLE rather than vacuously
 *     passing or sinking the whole enumeration.
 */
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { EntraIdProvider } from '@/app-layer/integrations/providers/entra-id';
import {
    IntegrationAuthError,
    IntegrationTerminalError,
} from '@/app-layer/integrations/http-resilience';

const CONFIG = { tenantId: 't-1', clientId: 'c-1' };
const SECRETS = { clientSecret: 's-1' };

const graphUser = (over: Record<string, unknown> = {}) => ({
    id: 'u-1',
    displayName: 'Ada Lovelace',
    userPrincipalName: 'ada@acme.com',
    accountEnabled: true,
    ...over,
});

const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

/**
 * Route Graph calls by URL. `users` may be a list of successive page bodies,
 * or a function for full control (used for the retry test).
 */
function graphFetch(opts: {
    users?: unknown[] | ((url: string, call: number) => unknown);
    roles?: unknown;
    mfa?: unknown;
    domains?: unknown;
} = {}) {
    let userCall = 0;
    return jest.fn(async (url: string) => {
        if (url.includes('/users')) {
            const n = userCall++;
            if (typeof opts.users === 'function') return opts.users(url, n);
            const pages = (opts.users as unknown[]) ?? [{ value: [] }];
            return jsonOk(pages[Math.min(n, pages.length - 1)]);
        }
        if (url.includes('directoryRoles') || url.includes('roleManagement')) {
            if (opts.roles === 'fail') return { ok: false, status: 403 };
            return jsonOk(opts.roles ?? { value: [] });
        }
        if (url.includes('authenticationMethods') || url.includes('Registration')) {
            if (opts.mfa === 'fail') return { ok: false, status: 403 };
            return jsonOk(opts.mfa ?? { value: [] });
        }
        if (url.includes('/domains')) {
            if (opts.domains === 'fail') return { ok: false, status: 403 };
            return jsonOk(opts.domains ?? { value: [] });
        }
        return jsonOk({});
    });
}

const provider = (deps = {}) => new EntraIdProvider(deps);
const withToken = (extra = {}) => ({ getAccessToken: async () => 'tok', ...extra });

describe('EntraIdProvider — descriptor', () => {
    it('declares live validation and the four shared checks', () => {
        const p = provider();
        expect(p.id).toBe('entra-id');
        expect(p.liveValidation).toBe(true);
        expect(p.supportedChecks).toEqual([
            'mfa_enforced',
            'no_dormant_admins',
            'admin_count_within_threshold',
            'sso_enforced',
        ]);
        expect(p.configSchema.configFields.map((f) => f.key)).toEqual([
            'tenantId',
            'clientId',
            'maxAdmins',
            'dormantDays',
            'enrichMfa',
            'enrichFederation',
            // The offboarding write opt-in. Every field here must also carry a
            // rule in CONFIG_FIELD_RULES — validateProviderConfig rejects an
            // undeclared key outright — so this list and that map move together.
            'writesEnabled',
        ]);
    });

    it('the write opt-in defaults off, so a read-only tenant stays read-only', () => {
        const field = provider().configSchema.configFields.find((f) => f.key === 'writesEnabled');
        // With client credentials the token exchange asks for `.default`, which
        // returns exactly what an admin already consented rather than what we
        // request. So consent granted for any other purpose would otherwise hand
        // this application standing power to disable any user in the directory;
        // `required: false` plus the writer's explicit `=== true` check is what
        // keeps that an opt-in rather than a side effect.
        expect(field).toBeDefined();
        expect(field!.type).toBe('boolean');
        expect(field!.required).toBe(false);
    });
});

describe('EntraIdProvider.validateConnection', () => {
    it('requires tenantId, clientId, and the secret in order', async () => {
        const p = provider();
        expect(await p.validateConnection({}, SECRETS)).toEqual({
            valid: false,
            error: 'A Directory (tenant) ID is required.',
        });
        expect(await p.validateConnection({ tenantId: 't' }, SECRETS)).toEqual({
            valid: false,
            error: 'An Application (client) ID is required.',
        });
        expect(await p.validateConnection(CONFIG, {})).toEqual({
            valid: false,
            error: 'A client secret is required.',
        });
    });

    it('trims whitespace-only ids into the required error', async () => {
        expect(
            await provider().validateConnection({ tenantId: '   ' }, SECRETS),
        ).toEqual({ valid: false, error: 'A Directory (tenant) ID is required.' });
    });

    it('pings the directory and passes on 2xx', async () => {
        const fetchImpl = graphFetch();
        const res = await provider(withToken({ fetchImpl })).validateConnection(
            CONFIG,
            SECRETS,
        );
        expect(res).toEqual({ valid: true });
        expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('$top=1'))).toBe(
            true,
        );
    });

    it('reports the status when the ping is rejected', async () => {
        const fetchImpl = jest.fn(async () => ({ ok: false, status: 401 }));
        expect(
            await provider(withToken({ fetchImpl })).validateConnection(CONFIG, SECRETS),
        ).toEqual({ valid: false, error: 'Entra directory ping failed (HTTP 401).' });
    });

    it('surfaces a token-exchange failure as an invalid connection', async () => {
        const p = provider({
            getAccessToken: async () => {
                throw new Error('AADSTS7000215');
            },
            fetchImpl: graphFetch(),
        });
        expect(await p.validateConnection(CONFIG, SECRETS)).toEqual({
            valid: false,
            error: 'Entra connection failed: AADSTS7000215',
        });
    });

    it('stringifies a non-Error throw', async () => {
        const p = provider({
            getAccessToken: async () => {
                throw 'boom';
            },
            fetchImpl: graphFetch(),
        });
        expect(
            (await p.validateConnection(CONFIG, SECRETS)).error,
        ).toBe('Entra connection failed: boom');
    });
});

describe('EntraIdProvider.listAccounts — injected override', () => {
    it('uses the injected lister and reports complete', async () => {
        const listAccounts = jest.fn().mockResolvedValue([]);
        expect(await provider({ listAccounts }).listAccounts(CONFIG)).toEqual({
            accounts: [],
            complete: true,
        });
        expect(listAccounts).toHaveBeenCalledWith(CONFIG);
    });
});

describe('EntraIdProvider — directory enumeration', () => {
    it('records that the directory ANSWERED the on-prem question', async () => {
        // The pair the write-target rail reads. Graph returning null means "not
        // synced from on-premises"; it is only safe to act on because the field
        // was in the $select and the directory replied. Both select sets carry
        // it, so this holds on the signInActivity fallback path too.
        const fetchImpl = graphFetch({ users: [{ value: [graphUser()] }] });
        const res = await provider(withToken({ fetchImpl })).listAccounts(CONFIG);
        expect(res.accounts[0].onPremStateObserved).toBe(true);
    });

    it('requests the full select with signInActivity first', async () => {
        const fetchImpl = graphFetch({ users: [{ value: [graphUser()] }] });
        await provider(withToken({ fetchImpl })).listAccounts(CONFIG);
        expect(String(fetchImpl.mock.calls[0][0])).toContain('signInActivity');
    });

    it('retries the enumeration without signInActivity when the tenant cannot serve it', async () => {
        // First call (full select) 4xxs; the retry with the base select succeeds.
        const fetchImpl = graphFetch({
            users: (url: string, call: number) => {
                if (call === 0) return { ok: false, status: 403 };
                return jsonOk({ value: [graphUser()] });
            },
        });

        const res = await provider(withToken({ fetchImpl })).listAccounts(CONFIG);

        const userUrls = fetchImpl.mock.calls
            .map(([u]) => String(u))
            .filter((u) => u.includes('/users'));
        expect(userUrls[0]).toContain('signInActivity');
        expect(userUrls[1]).not.toContain('signInActivity');
        expect(res.accounts).toHaveLength(1);
    });

    it('retries without signInActivity when the tenant THROWS 403 for it', async () => {
        // THE SHAPE PRODUCTION ACTUALLY PRODUCES. The test above hands back
        // `{ ok: false, status: 403 }`, but the real `doFetch` is
        // `resilientFetch`, which THROWS IntegrationAuthError on 401/403 rather
        // than returning the response — so the `!res.ok` branch could never see
        // a 403, and 403 is exactly what Graph answers for `signInActivity` on a
        // tenant without Entra ID P1/P2.
        //
        // Observed in production: a connection with every permission consented
        // and a valid token failed every sync with
        // `Integration auth failed (403): …/v1.0/users`, and the fallback's warn
        // line had never once been logged.
        let call = 0;
        const fetchImpl = jest.fn(async (url: string | URL) => {
            const u = String(url);
            if (u.includes('/users')) {
                call += 1;
                if (call === 1) throw new IntegrationAuthError(403, u);
                return jsonOk({ value: [graphUser()] }) as unknown as Response;
            }
            return jsonOk({ value: [] }) as unknown as Response;
        });

        const res = await provider(withToken({ fetchImpl })).listAccounts(CONFIG);

        const userUrls = fetchImpl.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/users'));
        expect(userUrls[0]).toContain('signInActivity');
        expect(userUrls[1]).not.toContain('signInActivity');
        expect(res.accounts).toHaveLength(1);
    });

    it('still fails when the credential itself is bad, not just the premium field', async () => {
        // THE CONTROL, and it is the reason the retry is safe. A genuinely
        // rejected credential throws on the retry too, so it propagates and the
        // connection is still marked. Without this, the fix above would convert
        // every real 403 into a silent success.
        const fetchImpl = jest.fn(async (url: string | URL) => {
            throw new IntegrationAuthError(403, String(url));
        });

        await expect(
            provider(withToken({ fetchImpl })).listAccounts(CONFIG),
        ).rejects.toBeInstanceOf(IntegrationAuthError);

        // It really did try twice — once with the field, once without — so the
        // failure is a verdict rather than a refusal to look.
        const userUrls = fetchImpl.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/users'));
        expect(userUrls).toHaveLength(2);
        expect(userUrls[0]).toContain('signInActivity');
        expect(userUrls[1]).not.toContain('signInActivity');
    });

    it('does not retry a 5xx as though it were a premium-field refusal', async () => {
        // Only 4xx is a permissions answer. A 500 must surface, not be retried
        // into a quieter select that hides a broken directory.
        const fetchImpl = jest.fn(async (url: string | URL) => {
            throw new IntegrationTerminalError(500, String(url));
        });
        await expect(
            provider(withToken({ fetchImpl })).listAccounts(CONFIG),
        ).rejects.toBeInstanceOf(IntegrationTerminalError);
        expect(fetchImpl.mock.calls.filter(([u]) => String(u).includes('/users'))).toHaveLength(1);
    });

    it('throws when a non-first page fails', async () => {
        const fetchImpl = graphFetch({
            users: (url: string, call: number) => {
                if (call === 0)
                    return jsonOk({
                        value: [graphUser()],
                        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?page=2',
                    });
                return { ok: false, status: 500 };
            },
        });
        await expect(
            provider(withToken({ fetchImpl })).listAccounts(CONFIG),
        ).rejects.toThrow('Entra users fetch failed (HTTP 500)');
    });

    it('follows @odata.nextLink and reports complete when exhausted', async () => {
        const fetchImpl = graphFetch({
            users: [
                {
                    value: [graphUser({ id: 'u-1' })],
                    '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?page=2',
                },
                { value: [graphUser({ id: 'u-2' })] },
            ],
        });

        const res = await provider(withToken({ fetchImpl })).listAccounts(CONFIG);
        expect(res.accounts).toHaveLength(2);
        expect(res.complete).toBe(true);
    });

    it('tolerates a page with no value array', async () => {
        const fetchImpl = graphFetch({ users: [{}] });
        const res = await provider(withToken({ fetchImpl })).listAccounts(CONFIG);
        expect(res).toEqual({ accounts: [], complete: true, resumeToken: null });
    });
});

describe('EntraIdProvider — user normalization', () => {
    const one = async (over: Record<string, unknown>) => {
        const fetchImpl = graphFetch({ users: [{ value: [graphUser(over)] }] });
        const res = await provider(withToken({ fetchImpl })).listAccounts({
            ...CONFIG,
            enrichMfa: 'false',
            enrichFederation: 'false',
        });
        return res.accounts[0];
    };

    it('prefers mail over userPrincipalName', async () => {
        expect((await one({ mail: 'real@acme.com' })).email).toBe('real@acme.com');
        expect((await one({ mail: null })).email).toBe('ada@acme.com');
        expect((await one({ mail: null, userPrincipalName: undefined })).email).toBe('');
    });

    it('maps a disabled account to SUSPENDED and everything else to ACTIVE', async () => {
        expect((await one({ accountEnabled: false })).status).toBe('SUSPENDED');
        expect((await one({ accountEnabled: true })).status).toBe('ACTIVE');
        // Absent flag is not treated as disabled.
        expect((await one({ accountEnabled: undefined })).status).toBe('ACTIVE');
    });

    it('leaves the opt-out enrichment signals unknown (H2)', async () => {
        const a = await one({});
        // MFA + federation were opted out here, so both stay unknown.
        expect(a.mfaEnrolled).toBeNull();
        expect(a.ssoEnrolled).toBeNull();
        expect(a.groups).toEqual([]);
        // Admin membership has NO opt-out flag — it always runs, and is
        // authoritative when it succeeds, so an account absent from the role
        // set is a definite `false` rather than unknown.
        expect(a.isAdmin).toBe(false);
    });

    it('parses lastSignInDateTime when present', async () => {
        expect(
            (
                await one({
                    signInActivity: { lastSignInDateTime: '2026-06-01T00:00:00.000Z' },
                })
            ).lastActiveAt,
        ).toEqual(new Date('2026-06-01T00:00:00.000Z'));
        expect((await one({ signInActivity: null })).lastActiveAt).toBeNull();
        expect(
            (await one({ signInActivity: { lastSignInDateTime: null } })).lastActiveAt,
        ).toBeNull();
    });
});

describe('EntraIdProvider — enrichment resilience', () => {
    const listWith = async (
        opts: Parameters<typeof graphFetch>[0],
        config: Record<string, unknown> = CONFIG,
    ) => {
        const fetchImpl = graphFetch({ users: [{ value: [graphUser()] }], ...opts });
        return provider(withToken({ fetchImpl })).listAccounts(config);
    };

    it('leaves isAdmin unknown when the roles surface fails', async () => {
        const res = await listWith({ roles: 'fail' });
        expect(res.accounts[0].isAdmin).toBeNull();
        // …and the enumeration still succeeded.
        expect(res.accounts).toHaveLength(1);
    });

    it('leaves mfaEnrolled unknown when the registration report fails', async () => {
        const res = await listWith({ mfa: 'fail' });
        expect(res.accounts[0].mfaEnrolled).toBeNull();
        expect(res.accounts).toHaveLength(1);
    });

    it('leaves ssoEnrolled unknown when the domains read fails', async () => {
        const res = await listWith({ domains: 'fail' });
        expect(res.accounts[0].ssoEnrolled).toBeNull();
        expect(res.accounts).toHaveLength(1);
    });

    it('skips the MFA enrichment when opted out', async () => {
        const fetchImpl = graphFetch({ users: [{ value: [graphUser()] }] });
        await provider(withToken({ fetchImpl })).listAccounts({
            ...CONFIG,
            enrichMfa: 'false',
        });
        expect(
            fetchImpl.mock.calls.some(([u]) => String(u).includes('Registration')),
        ).toBe(false);
    });

    it('skips the federation enrichment when opted out', async () => {
        const fetchImpl = graphFetch({ users: [{ value: [graphUser()] }] });
        await provider(withToken({ fetchImpl })).listAccounts({
            ...CONFIG,
            enrichFederation: 'false',
        });
        expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('/domains'))).toBe(
            false,
        );
    });

    it('treats an empty-string opt-out value as the default (enabled)', async () => {
        const fetchImpl = graphFetch({ users: [{ value: [graphUser()] }] });
        await provider(withToken({ fetchImpl })).listAccounts({
            ...CONFIG,
            enrichFederation: '',
        });
        expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('/domains'))).toBe(
            true,
        );
    });
});

describe('EntraIdProvider.runCheck', () => {
    const input = (checkType: string) => ({
        parsed: { checkType },
        connectionConfig: CONFIG,
    });

    it('evaluates over the enumerated accounts', async () => {
        const p = provider({
            listAccounts: async () => [
                {
                    externalUserId: 'u-1',
                    email: 'a@acme.com',
                    status: 'ACTIVE',
                    isAdmin: false,
                    mfaEnrolled: true,
                    ssoEnrolled: null,
                    groups: [],
                },
            ],
        });
        const res = await p.runCheck(input('mfa_enforced') as never);
        expect(res.status).toBe('PASSED');
        expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns ERROR rather than throwing when enumeration fails', async () => {
        const p = provider({
            listAccounts: async () => {
                throw new Error('graph down');
            },
        });
        const res = await p.runCheck(input('mfa_enforced') as never);
        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Entra ID check failed to run.');
        expect(res.errorMessage).toBe('graph down');
    });

    it('stringifies a non-Error throw', async () => {
        const p = provider({
            listAccounts: async () => {
                throw 42;
            },
        });
        expect((await p.runCheck(input('mfa_enforced') as never)).errorMessage).toBe('42');
    });
});

describe('EntraIdProvider.mapResultToEvidence', () => {
    const input = { parsed: { checkType: 'sso_enforced' } } as never;

    it('categorises a real result', () => {
        expect(
            provider().mapResultToEvidence(input, {
                status: 'PASSED',
                summary: 'ok',
                details: {},
            } as never),
        ).toEqual({
            title: 'Microsoft Entra ID — sso_enforced',
            content: 'ok',
            type: 'REPORT',
            category: 'entra-id:sso_enforced',
        });
    });

    it('produces nothing for an errored check', () => {
        expect(
            provider().mapResultToEvidence(input, {
                status: 'ERROR',
                summary: 'x',
                details: {},
            } as never),
        ).toBeNull();
    });
});
