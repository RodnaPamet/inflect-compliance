/**
 * Coverage wave E batch 2 — `providers/google-workspace/index.ts`.
 *
 * Every dependency the live path needs (token exchange, directory fetch, SSO
 * assignments) is injectable, so the whole provider is exercised without
 * Google credentials.
 *
 * The load-bearing behaviours pinned here:
 *   • H2 — `ssoEnrolled` is `null` (unknown) off the Directory object, NOT a
 *     blanket `true`. A blanket true made `sso_enforced` impossible to fail.
 *   • GAP-4 — SSO is derived from inbound SAML assignments, tri-state:
 *     customer-wide → true, OU/group-scoped only → null, none → false.
 *   • H3 — a surviving `nextPageToken` at the MAX_USERS cap means the
 *     enumeration is known-partial, and `complete: false` is what stops it
 *     driving the deprovision reconcile.
 */
import { GoogleWorkspaceProvider } from '@/app-layer/integrations/providers/google-workspace';

const provider = (deps = {}) => new GoogleWorkspaceProvider(deps);

const gUser = (over: Record<string, unknown> = {}) => ({
    id: 'u-1',
    primaryEmail: 'ada@acme.com',
    name: { fullName: 'Ada Lovelace' },
    isEnrolledIn2Sv: true,
    ...over,
});

/** A fetch stub that returns the given directory pages in order. */
function directoryFetch(pages: Array<Record<string, unknown>>) {
    const fn = jest.fn();
    for (const p of pages) {
        fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => p });
    }
    return fn;
}

const CONFIG = { domain: 'acme.com', adminEmail: 'admin@acme.com', enrichSso: 'false' };

async function accountsFrom(
    pages: Array<Record<string, unknown>>,
    config: Record<string, unknown> = CONFIG,
) {
    const p = provider({
        getAccessToken: async () => 'tok',
        fetchImpl: directoryFetch(pages) as never,
    });
    return p.listAccounts(config);
}

describe('GoogleWorkspaceProvider — descriptor', () => {
    it('declares the four shared identity checks and non-live validation', () => {
        const p = provider();
        expect(p.id).toBe('google-workspace');
        expect(p.supportedChecks).toEqual([
            'mfa_enforced',
            'no_dormant_admins',
            'admin_count_within_threshold',
            'sso_enforced',
        ]);
        expect(p.liveValidation).toBe(false);
        expect(p.configSchema.configFields.map((f) => f.key)).toEqual([
            'domain',
            'adminEmail',
            'maxAdmins',
            'dormantDays',
            'enrichSso',
        ]);
        expect(p.configSchema.secretFields[0].key).toBe('serviceAccountJson');
    });
});

describe('GoogleWorkspaceProvider.validateConnection', () => {
    const p = provider();
    const sa = JSON.stringify({ client_email: 'sa@acme.iam', private_key: 'KEY' });

    it('requires the domain', async () => {
        expect(await p.validateConnection({}, { serviceAccountJson: sa })).toEqual({
            valid: false,
            error: 'A primary domain is required.',
        });
    });

    it('requires the impersonated admin', async () => {
        expect(
            await p.validateConnection({ domain: 'acme.com' }, { serviceAccountJson: sa }),
        ).toEqual({ valid: false, error: 'An admin email to impersonate is required.' });
    });

    it('requires the service-account JSON', async () => {
        expect(
            await p.validateConnection({ domain: 'acme.com', adminEmail: 'a@acme.com' }, {}),
        ).toEqual({ valid: false, error: 'A service-account JSON key is required.' });
    });

    it('accepts a valid JSON string', async () => {
        expect(
            await p.validateConnection(
                { domain: 'acme.com', adminEmail: 'a@acme.com' },
                { serviceAccountJson: sa },
            ),
        ).toEqual({ valid: true });
    });

    it('accepts an already-parsed object', async () => {
        expect(
            await p.validateConnection(
                { domain: 'acme.com', adminEmail: 'a@acme.com' },
                { serviceAccountJson: { client_email: 'x', private_key: 'y' } },
            ),
        ).toEqual({ valid: true });
    });

    it('rejects JSON missing the required key fields', async () => {
        expect(
            await p.validateConnection(
                { domain: 'acme.com', adminEmail: 'a@acme.com' },
                { serviceAccountJson: JSON.stringify({ client_email: 'x' }) },
            ),
        ).toEqual({
            valid: false,
            error: 'Service-account JSON is missing client_email / private_key.',
        });
    });

    it('rejects unparseable JSON', async () => {
        expect(
            await p.validateConnection(
                { domain: 'acme.com', adminEmail: 'a@acme.com' },
                { serviceAccountJson: 'not json {' },
            ),
        ).toEqual({ valid: false, error: 'Service-account JSON is not valid JSON.' });
    });
});

describe('GoogleWorkspaceProvider.listAccounts — injected override', () => {
    it('uses the injected lister and reports complete', async () => {
        const listAccounts = jest.fn().mockResolvedValue([]);
        const res = await provider({ listAccounts }).listAccounts(CONFIG);
        expect(listAccounts).toHaveBeenCalledWith(CONFIG);
        // The dep-injection path bypasses pagination entirely, so it carries no
        // resume token — deliberately distinct from the real fetch path, which
        // reports `resumeToken: null` to mean "complete, nothing to resume".
        expect(res).toEqual({ accounts: [], complete: true });
    });
});

describe('GoogleWorkspaceProvider — directory fetch', () => {
    it('requests the domain with paging params and a bearer token', async () => {
        const fetchImpl = directoryFetch([{ users: [gUser()] }]);
        await provider({
            getAccessToken: async () => 'tok-123',
            fetchImpl: fetchImpl as never,
        }).listAccounts(CONFIG);

        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toContain('https://admin.googleapis.com/admin/directory/v1/users');
        expect(url).toContain('domain=acme.com');
        expect(url).toContain('maxResults=200');
        expect(url).toContain('projection=full');
        expect(init.headers.Authorization).toBe('Bearer tok-123');
    });

    it('throws with the status on a non-ok directory response', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 403 });
        await expect(
            provider({
                getAccessToken: async () => 'tok',
                fetchImpl: fetchImpl as never,
            }).listAccounts(CONFIG),
        ).rejects.toThrow('Google directory fetch failed (HTTP 403)');
    });

    it('follows nextPageToken and reports complete when it runs out', async () => {
        const fetchImpl = directoryFetch([
            { users: [gUser({ id: 'u-1' })], nextPageToken: 'p2' },
            { users: [gUser({ id: 'u-2' })] },
        ]);
        const res = await provider({
            getAccessToken: async () => 'tok',
            fetchImpl: fetchImpl as never,
        }).listAccounts(CONFIG);

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[1][0]).toContain('pageToken=p2');
        expect(res.accounts).toHaveLength(2);
        expect(res.complete).toBe(true);
    });

    it('tolerates a page with no users array', async () => {
        const res = await accountsFrom([{}]);
        expect(res).toEqual({ accounts: [], complete: true, resumeToken: null });
    });

    it('reports complete=false when the cap is hit with pages remaining (H3)', async () => {
        // One page over the cap, still advertising more.
        const bigPage = {
            users: Array.from({ length: 5000 }, (_, i) => gUser({ id: `u-${i}` })),
            nextPageToken: 'more',
        };
        const res = await accountsFrom([bigPage]);
        expect(res.accounts).toHaveLength(5000);
        // Known-partial: must not drive the deprovision reconcile.
        expect(res.complete).toBe(false);
    });
});

describe('GoogleWorkspaceProvider — user normalization', () => {
    const one = async (over: Record<string, unknown>) =>
        (await accountsFrom([{ users: [gUser(over)] }])).accounts[0];

    it('maps the identity fields', async () => {
        const a = await one({});
        expect(a.externalUserId).toBe('u-1');
        expect(a.email).toBe('ada@acme.com');
        expect(a.displayName).toBe('Ada Lovelace');
        expect(a.groups).toEqual([]);
    });

    it('defaults a missing email to empty and a missing name to undefined', async () => {
        const a = await one({ primaryEmail: undefined, name: undefined });
        expect(a.email).toBe('');
        expect(a.displayName).toBeUndefined();
    });

    it('maps archived → DEPROVISIONED, suspended → SUSPENDED, else ACTIVE', async () => {
        expect((await one({ archived: true, suspended: true })).status).toBe(
            'DEPROVISIONED',
        );
        expect((await one({ suspended: true })).status).toBe('SUSPENDED');
        expect((await one({})).status).toBe('ACTIVE');
    });

    it('treats delegated admins as admins', async () => {
        expect((await one({ isAdmin: true })).isAdmin).toBe(true);
        expect((await one({ isDelegatedAdmin: true })).isAdmin).toBe(true);
        expect((await one({})).isAdmin).toBe(false);
    });

    it('reads the 2SV enrolment flag', async () => {
        expect((await one({ isEnrolledIn2Sv: true })).mfaEnrolled).toBe(true);
        expect((await one({ isEnrolledIn2Sv: false })).mfaEnrolled).toBe(false);
    });

    it('leaves ssoEnrolled null off the Directory object (H2)', async () => {
        // enrichSso is off in CONFIG, so this is the raw normalization result.
        expect((await one({})).ssoEnrolled).toBeNull();
    });

    it('parses lastLoginTime, treating the epoch sentinel as never', async () => {
        expect((await one({ lastLoginTime: '2026-06-01T10:00:00.000Z' })).lastActiveAt).toEqual(
            new Date('2026-06-01T10:00:00.000Z'),
        );
        expect(
            (await one({ lastLoginTime: '1970-01-01T00:00:00.000Z' })).lastActiveAt,
        ).toBeNull();
        expect((await one({ lastLoginTime: null })).lastActiveAt).toBeNull();
        expect((await one({})).lastActiveAt).toBeNull();
    });
});

describe('GoogleWorkspaceProvider — SSO enrichment (GAP-4)', () => {
    const withSso = async (
        cov: { customerWide: boolean; hasSaml: boolean },
        config: Record<string, unknown> = { domain: 'acme.com' },
    ) => {
        const res = await provider({
            getAccessToken: async () => 'tok',
            fetchImpl: directoryFetch([{ users: [gUser()] }]) as never,
            listSsoAssignments: async () => cov,
        }).listAccounts(config);
        return res.accounts[0].ssoEnrolled;
    };

    it('marks every account enrolled on a customer-wide SAML assignment', async () => {
        expect(await withSso({ customerWide: true, hasSaml: true })).toBe(true);
    });

    it('leaves it unknown when SAML exists but is only OU/group-scoped', async () => {
        expect(await withSso({ customerWide: false, hasSaml: true })).toBeNull();
    });

    it('marks accounts NOT enrolled when there is no SAML assignment at all', async () => {
        expect(await withSso({ customerWide: false, hasSaml: false })).toBe(false);
    });

    it('is on by default and opt-out via enrichSso=false', async () => {
        expect(
            await withSso({ customerWide: true, hasSaml: true }, { domain: 'acme.com' }),
        ).toBe(true);
        expect(
            await withSso(
                { customerWide: true, hasSaml: true },
                { domain: 'acme.com', enrichSso: 'false' },
            ),
        ).toBeNull();
        // Boolean false is honoured the same way as the string.
        expect(
            await withSso(
                { customerWide: true, hasSaml: true },
                { domain: 'acme.com', enrichSso: false },
            ),
        ).toBeNull();
    });

    it('leaves SSO unknown when the assignments read fails (missing scope)', async () => {
        const res = await provider({
            getAccessToken: async () => 'tok',
            fetchImpl: directoryFetch([{ users: [gUser()] }]) as never,
            listSsoAssignments: async () => {
                throw new Error('403 scope not authorised');
            },
        }).listAccounts({ domain: 'acme.com' });
        // Swallowed → NOT_APPLICABLE rather than a false FAIL.
        expect(res.accounts[0].ssoEnrolled).toBeNull();
    });
});

describe('GoogleWorkspaceProvider.runCheck', () => {
    const input = (checkType: string) => ({
        parsed: { checkType },
        connectionConfig: CONFIG,
    });

    it('evaluates a check over the enumerated accounts', async () => {
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
                {
                    externalUserId: 'u-2',
                    email: 'b@acme.com',
                    status: 'ACTIVE',
                    isAdmin: false,
                    mfaEnrolled: false,
                    ssoEnrolled: null,
                    groups: [],
                },
            ],
        });

        const res = await p.runCheck(input('mfa_enforced') as never);

        expect(res.status).toBe('FAILED');
        expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('passes when every active account satisfies the check', async () => {
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
        expect((await p.runCheck(input('mfa_enforced') as never)).status).toBe('PASSED');
    });

    it('returns ERROR (not a throw) when enumeration fails', async () => {
        const p = provider({
            listAccounts: async () => {
                throw new Error('token exchange failed');
            },
        });

        const res = await p.runCheck(input('mfa_enforced') as never);

        expect(res.status).toBe('ERROR');
        expect(res.summary).toBe('Google Workspace check failed to run.');
        expect(res.errorMessage).toBe('token exchange failed');
    });

    it('stringifies a non-Error throw', async () => {
        const p = provider({
            listAccounts: async () => {
                throw 'plain string';
            },
        });
        expect((await p.runCheck(input('mfa_enforced') as never)).errorMessage).toBe(
            'plain string',
        );
    });
});

describe('GoogleWorkspaceProvider.mapResultToEvidence', () => {
    const input = { parsed: { checkType: 'mfa_enforced' } } as never;

    it('produces a categorised evidence payload for a real result', () => {
        const ev = provider().mapResultToEvidence(input, {
            status: 'PASSED',
            summary: 'All good',
            details: {},
        } as never);
        expect(ev).toEqual({
            title: 'Google Workspace — mfa_enforced',
            content: 'All good',
            type: 'REPORT',
            category: 'google-workspace:mfa_enforced',
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
