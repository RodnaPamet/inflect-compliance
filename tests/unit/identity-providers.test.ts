/**
 * PR-2 — Okta + Google Workspace identity providers: pure check logic +
 * per-provider runCheck via the injectable listAccounts seam (no live API).
 */
import {
    runIdentityCheck,
    isIdentitySyncProvider,
    type NormalizedIdentityAccount,
} from '@/app-layer/integrations/providers/identity/types';
import { OktaProvider, parseNextLink } from '@/app-layer/integrations/providers/okta';
import { GoogleWorkspaceProvider } from '@/app-layer/integrations/providers/google-workspace';
import { EntraIdProvider } from '@/app-layer/integrations/providers/entra-id';
import {
    ActiveDirectoryProvider,
    formatObjectGuid,
    fileTimeToDate,
    cnOf,
} from '@/app-layer/integrations/providers/active-directory';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function acct(over: Partial<NormalizedIdentityAccount>): NormalizedIdentityAccount {
    return {
        externalUserId: over.externalUserId ?? 'u1',
        email: over.email ?? 'u1@acme.com',
        displayName: over.displayName,
        status: over.status ?? 'ACTIVE',
        isAdmin: over.isAdmin ?? false,
        mfaEnrolled: over.mfaEnrolled ?? true,
        ssoEnrolled: over.ssoEnrolled ?? true,
        groups: over.groups ?? [],
        lastActiveAt: 'lastActiveAt' in over ? (over.lastActiveAt ?? null) : NOW,
    };
}

describe('runIdentityCheck', () => {
    it('mfa_enforced FAILs when an active account lacks MFA, ignoring suspended', () => {
        const accounts = [
            acct({ externalUserId: 'a', mfaEnrolled: true }),
            acct({ externalUserId: 'b', mfaEnrolled: false }),
            acct({ externalUserId: 'c', mfaEnrolled: false, status: 'SUSPENDED' }),
        ];
        const r = runIdentityCheck('mfa_enforced', accounts, {}, NOW);
        expect(r.status).toBe('FAILED');
        expect(r.details.passed).toBe(1);
        expect(r.details.failed).toBe(1); // suspended account excluded
    });

    it('mfa_enforced PASSes when every active account has MFA', () => {
        const r = runIdentityCheck('mfa_enforced', [acct({ mfaEnrolled: true })], {}, NOW);
        expect(r.status).toBe('PASSED');
    });

    it('no_dormant_admins FAILs a dormant admin past the threshold', () => {
        const old = new Date(NOW.getTime() - 200 * 24 * 60 * 60 * 1000);
        const accounts = [
            acct({ externalUserId: 'admin1', isAdmin: true, lastActiveAt: old }),
            acct({ externalUserId: 'admin2', isAdmin: true, lastActiveAt: NOW }),
            acct({ externalUserId: 'user1', isAdmin: false, lastActiveAt: old }), // non-admin excluded
        ];
        const r = runIdentityCheck('no_dormant_admins', accounts, { dormantDays: 90 }, NOW);
        expect(r.status).toBe('FAILED');
        expect(r.details.failed).toBe(1);
        expect(r.details.passed).toBe(1);
    });

    it('no_dormant_admins treats a never-logged-in admin as dormant', () => {
        const r = runIdentityCheck('no_dormant_admins', [acct({ isAdmin: true, lastActiveAt: null })], {}, NOW);
        expect(r.status).toBe('FAILED');
    });

    it('admin_count_within_threshold FAILs when admins exceed the cap', () => {
        const accounts = [
            acct({ externalUserId: 'a', isAdmin: true }),
            acct({ externalUserId: 'b', isAdmin: true }),
            acct({ externalUserId: 'c', isAdmin: true }),
        ];
        const r = runIdentityCheck('admin_count_within_threshold', accounts, { maxAdmins: 2 }, NOW);
        expect(r.status).toBe('FAILED');
        expect(r.details.adminCount).toBe(3);
        expect(r.details.threshold).toBe(2);
    });

    it('admin_count_within_threshold PASSes at/under the cap', () => {
        const r = runIdentityCheck('admin_count_within_threshold', [acct({ isAdmin: true })], { maxAdmins: 5 }, NOW);
        expect(r.status).toBe('PASSED');
    });

    it('sso_enforced FAILs a non-federated active account', () => {
        const r = runIdentityCheck('sso_enforced', [acct({ ssoEnrolled: false })], {}, NOW);
        expect(r.status).toBe('FAILED');
    });

    it('an unknown check returns ERROR', () => {
        const r = runIdentityCheck('nope', [], {}, NOW);
        expect(r.status).toBe('ERROR');
    });
});

describe('OktaProvider', () => {
    const accounts = [acct({ externalUserId: 'a', mfaEnrolled: false })];
    const provider = new OktaProvider({ listAccounts: async () => accounts });

    it('is an IdentitySyncProvider', () => {
        expect(isIdentitySyncProvider(provider)).toBe(true);
        expect(provider.supportedChecks).toContain('mfa_enforced');
    });

    it('runCheck routes to the identity check and carries durationMs', async () => {
        const r = await provider.runCheck({
            automationKey: 'okta.mfa_enforced',
            parsed: { provider: 'okta', checkType: 'mfa_enforced', raw: 'okta.mfa_enforced' },
            tenantId: 't1',
            connectionConfig: {},
            triggeredBy: 'scheduled',
        });
        expect(r.status).toBe('FAILED');
        expect(typeof r.durationMs).toBe('number');
    });

    it('runCheck returns ERROR when the directory fetch throws', async () => {
        const boom = new OktaProvider({ listAccounts: async () => { throw new Error('401'); } });
        const r = await boom.runCheck({
            automationKey: 'okta.mfa_enforced',
            parsed: { provider: 'okta', checkType: 'mfa_enforced', raw: 'okta.mfa_enforced' },
            tenantId: 't1',
            connectionConfig: {},
            triggeredBy: 'scheduled',
        });
        expect(r.status).toBe('ERROR');
        expect(r.errorMessage).toContain('401');
    });

    it('validateConnection rejects missing org/token', async () => {
        expect((await provider.validateConnection({}, {})).valid).toBe(false);
        expect((await provider.validateConnection({ orgUrl: 'https://x.okta.com' }, {})).valid).toBe(false);
    });

    it('mapResultToEvidence returns null on ERROR, a REPORT otherwise', () => {
        const input = { automationKey: 'okta.mfa_enforced', parsed: { provider: 'okta', checkType: 'mfa_enforced', raw: 'okta.mfa_enforced' }, tenantId: 't', connectionConfig: {}, triggeredBy: 'scheduled' as const };
        expect(provider.mapResultToEvidence(input, { status: 'ERROR', summary: '', details: {} })).toBeNull();
        const ev = provider.mapResultToEvidence(input, { status: 'PASSED', summary: 'ok', details: {} });
        expect(ev?.type).toBe('REPORT');
    });
});

describe('parseNextLink', () => {
    it('extracts the rel="next" URL from an Okta Link header', () => {
        const header = '<https://x.okta.com/api/v1/users?after=1>; rel="next", <https://x.okta.com/api/v1/users>; rel="self"';
        expect(parseNextLink(header)).toBe('https://x.okta.com/api/v1/users?after=1');
    });
    it('returns null when there is no next link', () => {
        expect(parseNextLink(null)).toBeNull();
        expect(parseNextLink('<https://x>; rel="self"')).toBeNull();
    });
});

describe('GoogleWorkspaceProvider', () => {
    const accounts = [acct({ externalUserId: 'g1', isAdmin: true, lastActiveAt: null })];
    const provider = new GoogleWorkspaceProvider({ listAccounts: async () => accounts });

    it('runCheck evaluates no_dormant_admins from injected accounts', async () => {
        const r = await provider.runCheck({
            automationKey: 'google-workspace.no_dormant_admins',
            parsed: { provider: 'google-workspace', checkType: 'no_dormant_admins', raw: 'google-workspace.no_dormant_admins' },
            tenantId: 't1',
            connectionConfig: {},
            triggeredBy: 'scheduled',
        });
        expect(r.status).toBe('FAILED'); // never-logged-in admin
    });

    it('validateConnection rejects malformed service-account JSON', async () => {
        const bad = await provider.validateConnection({ domain: 'acme.com', adminEmail: 'a@acme.com' }, { serviceAccountJson: 'not json' });
        expect(bad.valid).toBe(false);
    });

    it('validateConnection accepts a well-formed key only if the credentials actually work', async () => {
        // Split out of the test above, which asserted valid:true on a
        // well-formed key. That was true when validateConnection stopped at a
        // shape check — and it is precisely why "Test connection" used to pass
        // on a connection whose domain-wide-delegation grant had been revoked.
        // It now performs a real token exchange and directory read, so reaching
        // valid:true requires a transport.
        const live = new GoogleWorkspaceProvider({
            getAccessToken: async () => 'tok',
            fetchImpl: (async () =>
                new Response(JSON.stringify({ users: [] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })) as unknown as typeof fetch,
        });
        const ok = await live.validateConnection(
            { domain: 'acme.com', adminEmail: 'a@acme.com' },
            { serviceAccountJson: JSON.stringify({ client_email: 'x@y.iam', private_key: 'k' }) },
        );
        expect(ok.valid).toBe(true);
    });
});

describe('EntraIdProvider', () => {
    const accounts = [acct({ externalUserId: 'e1', mfaEnrolled: false })];
    const provider = new EntraIdProvider({ listAccounts: async () => accounts });

    it('is an IdentitySyncProvider supporting the shared identity checks', () => {
        expect(isIdentitySyncProvider(provider)).toBe(true);
        expect(provider.supportedChecks).toContain('mfa_enforced');
        expect(provider.supportedChecks).toContain('sso_enforced');
    });

    it('runCheck routes to the identity check and carries durationMs', async () => {
        const r = await provider.runCheck({
            automationKey: 'entra-id.mfa_enforced',
            parsed: { provider: 'entra-id', checkType: 'mfa_enforced', raw: 'entra-id.mfa_enforced' },
            tenantId: 't1',
            connectionConfig: {},
            triggeredBy: 'scheduled',
        });
        expect(r.status).toBe('FAILED'); // e1 lacks MFA
        expect(typeof r.durationMs).toBe('number');
    });

    it('runCheck returns ERROR when the directory fetch throws', async () => {
        const boom = new EntraIdProvider({ listAccounts: async () => { throw new Error('403'); } });
        const r = await boom.runCheck({
            automationKey: 'entra-id.mfa_enforced',
            parsed: { provider: 'entra-id', checkType: 'mfa_enforced', raw: 'entra-id.mfa_enforced' },
            tenantId: 't1',
            connectionConfig: {},
            triggeredBy: 'scheduled',
        });
        expect(r.status).toBe('ERROR');
        expect(r.errorMessage).toContain('403');
    });

    it('validateConnection requires tenantId, clientId, and clientSecret', async () => {
        expect((await provider.validateConnection({}, {})).valid).toBe(false);
        expect((await provider.validateConnection({ tenantId: 't', clientId: 'c' }, {})).valid).toBe(false);
    });

    it('mapResultToEvidence returns null on ERROR, a REPORT with an entra-id category otherwise', () => {
        const input = { automationKey: 'entra-id.mfa_enforced', parsed: { provider: 'entra-id', checkType: 'mfa_enforced', raw: 'entra-id.mfa_enforced' }, tenantId: 't', connectionConfig: {}, triggeredBy: 'scheduled' as const };
        expect(provider.mapResultToEvidence(input, { status: 'ERROR', summary: '', details: {} })).toBeNull();
        const ev = provider.mapResultToEvidence(input, { status: 'PASSED', summary: 'ok', details: {} });
        expect(ev?.type).toBe('REPORT');
        expect(ev?.category).toBe('entra-id:mfa_enforced');
    });

    it('fetchEntraAccounts normalizes Graph users and applies bulk admin/MFA/SSO enrichment', async () => {
        // Route the injected fetch by URL to exercise the live enumeration path
        // (users list → directoryRoles → MFA report → domains) without real creds.
        const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body } as unknown as Response);
        const fetchImpl = (async (url: string | URL | Request) => {
            const u = String(url);
            if (u.includes('/users')) {
                return json({
                    value: [
                        { id: 'u1', displayName: 'One', userPrincipalName: 'one@acme.com', mail: 'one@acme.com', accountEnabled: true, signInActivity: { lastSignInDateTime: '2026-05-01T00:00:00Z' } },
                        { id: 'u2', displayName: 'Two', userPrincipalName: 'two@acme.com', accountEnabled: false },
                    ],
                });
            }
            if (u.includes('/directoryRoles')) {
                return json({ value: [{ members: [{ id: 'u1', '@odata.type': '#microsoft.graph.user' }] }] });
            }
            if (u.includes('userRegistrationDetails')) {
                return json({ value: [{ id: 'u1', isMfaRegistered: true }, { id: 'u2', isMfaRegistered: false }] });
            }
            if (u.includes('/domains')) {
                return json({ value: [{ id: 'acme.com', authenticationType: 'Federated', isVerified: true }] });
            }
            throw new Error(`unexpected fetch ${u}`);
        }) as unknown as typeof fetch;

        const live = new EntraIdProvider({ getAccessToken: async () => 'tok', fetchImpl });
        const { accounts: got, complete } = await live.listAccounts({ tenantId: 't', clientId: 'c' });
        expect(complete).toBe(true);
        const u1 = got.find((a) => a.externalUserId === 'u1')!;
        const u2 = got.find((a) => a.externalUserId === 'u2')!;
        expect(u1.status).toBe('ACTIVE');
        expect(u2.status).toBe('SUSPENDED'); // accountEnabled: false
        expect(u1.isAdmin).toBe(true);
        expect(u2.isAdmin).toBe(false); // authoritative role membership → not null
        expect(u1.mfaEnrolled).toBe(true);
        expect(u2.mfaEnrolled).toBe(false);
        expect(u1.ssoEnrolled).toBe(true); // acme.com is Federated
        expect(u1.lastActiveAt).toBeInstanceOf(Date);
    });

    it('leaves signals null (→ NOT_APPLICABLE) when the enrichment surfaces fail', async () => {
        const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body } as unknown as Response);
        const fetchImpl = (async (url: string | URL | Request) => {
            const u = String(url);
            if (u.includes('/users')) {
                return json({ value: [{ id: 'u1', userPrincipalName: 'one@acme.com', accountEnabled: true }] });
            }
            // directoryRoles / reports / domains all fail — signals must stay null.
            return { ok: false, status: 403, json: async () => ({}) } as unknown as Response;
        }) as unknown as typeof fetch;
        const live = new EntraIdProvider({ getAccessToken: async () => 'tok', fetchImpl });
        const { accounts: got } = await live.listAccounts({ tenantId: 't', clientId: 'c' });
        expect(got[0].isAdmin).toBeNull();
        expect(got[0].mfaEnrolled).toBeNull();
        expect(got[0].ssoEnrolled).toBeNull();
        // An all-unknown population makes the MFA check NOT_APPLICABLE, never PASSED.
        const na = runIdentityCheck('mfa_enforced', got, {}, NOW);
        expect(na.status).toBe('NOT_APPLICABLE');
    });
});

describe('Active Directory helpers', () => {
    it('formatObjectGuid renders the AD mixed-endian byte order', () => {
        const buf = Buffer.from([0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255]);
        expect(formatObjectGuid(buf)).toBe('33221100-5544-7766-8899-aabbccddeeff');
        expect(formatObjectGuid('not-16-bytes')).toBeUndefined();
    });

    it('fileTimeToDate converts a Windows FILETIME and treats 0 / never as null', () => {
        const ft = ((BigInt(Date.parse('2026-05-01T00:00:00Z')) + BigInt('11644473600000')) * BigInt(10000)).toString();
        expect(fileTimeToDate(ft)?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
        expect(fileTimeToDate('0')).toBeNull();
        expect(fileTimeToDate(undefined)).toBeNull();
    });

    it('cnOf extracts the leading CN from a distinguished name', () => {
        expect(cnOf('CN=Domain Admins,CN=Users,DC=corp,DC=example,DC=com')).toBe('Domain Admins');
        expect(cnOf('OU=Staff,DC=corp')).toBeNull();
    });
});

describe('ActiveDirectoryProvider', () => {
    // Built literally (not via acct(), whose `?? true` fallback would coerce the
    // null MFA/SSO signals) so the NOT_APPLICABLE assertions are exercised.
    const adAccounts: NormalizedIdentityAccount[] = [
        { externalUserId: 'a1', email: 'a1@corp.example.com', displayName: 'A1', status: 'ACTIVE', isAdmin: true, mfaEnrolled: null, ssoEnrolled: null, groups: ['Domain Admins'], lastActiveAt: NOW },
    ];
    const provider = new ActiveDirectoryProvider({ listAccounts: async () => adAccounts });

    it('is an IdentitySyncProvider supporting the shared identity checks', () => {
        expect(isIdentitySyncProvider(provider)).toBe(true);
        expect(provider.supportedChecks).toContain('no_dormant_admins');
    });

    it('runCheck routes to the identity check and carries durationMs', async () => {
        const r = await provider.runCheck({
            automationKey: 'active-directory.admin_count_within_threshold',
            parsed: { provider: 'active-directory', checkType: 'admin_count_within_threshold', raw: 'active-directory.admin_count_within_threshold' },
            tenantId: 't1',
            connectionConfig: { maxAdmins: 0 },
            triggeredBy: 'scheduled',
        });
        expect(r.status).toBe('FAILED'); // 1 admin > threshold 0
        expect(typeof r.durationMs).toBe('number');
    });

    it('runCheck returns ERROR when the LDAP enumeration throws', async () => {
        const boom = new ActiveDirectoryProvider({ listAccounts: async () => { throw new Error('LDAPS bind failed'); } });
        const r = await boom.runCheck({
            automationKey: 'active-directory.no_dormant_admins',
            parsed: { provider: 'active-directory', checkType: 'no_dormant_admins', raw: 'active-directory.no_dormant_admins' },
            tenantId: 't1',
            connectionConfig: {},
            triggeredBy: 'scheduled',
        });
        expect(r.status).toBe('ERROR');
        expect(r.errorMessage).toContain('LDAPS bind failed');
    });

    it('mfa_enforced / sso_enforced are NOT_APPLICABLE on AD (no such attribute)', async () => {
        const { accounts } = await provider.listAccounts({});
        expect(runIdentityCheck('mfa_enforced', accounts, {}, NOW).status).toBe('NOT_APPLICABLE');
        expect(runIdentityCheck('sso_enforced', accounts, {}, NOW).status).toBe('NOT_APPLICABLE');
    });

    it('validateConnection requires ldaps://, base DN, and bind credentials', async () => {
        expect((await provider.validateConnection({}, {})).valid).toBe(false);
        expect((await provider.validateConnection({ url: 'ldap://dc', baseDN: 'DC=corp' }, { bindDN: 'b', bindPassword: 'p' })).valid).toBe(false); // not ldaps
    });

    it('fetchAdAccounts maps UAC status, admin group membership, and last-logon over an injected LDAP client', async () => {
        const guid = Buffer.from([0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255]);
        const ft = ((BigInt(Date.parse('2026-05-01T00:00:00Z')) + BigInt('11644473600000')) * BigInt(10000)).toString();
        let bound = false;
        const fakeClient = {
            bind: async () => { bound = true; },
            search: async () => ({
                searchEntries: [
                    { objectGUID: guid, sAMAccountName: 'jdoe', userPrincipalName: 'jdoe@corp.example.com', displayName: 'John Doe', userAccountControl: '512', memberOf: ['CN=Domain Admins,CN=Users,DC=corp,DC=example,DC=com'], lastLogonTimestamp: ft, distinguishedName: 'CN=John Doe,DC=corp' },
                    { objectGUID: Buffer.from([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), sAMAccountName: 'svc', userAccountControl: '514', memberOf: [], distinguishedName: 'CN=svc,DC=corp' },
                ],
            }),
            unbind: async () => {},
        };
        const live = new ActiveDirectoryProvider({ createClient: () => fakeClient });
        const { accounts, complete } = await live.listAccounts({ url: 'ldaps://dc:636', baseDN: 'DC=corp', bindDN: 'x', bindPassword: 'y' });
        expect(bound).toBe(true);
        expect(complete).toBe(true);
        const jdoe = accounts.find((a) => a.email === 'jdoe@corp.example.com')!;
        const svc = accounts.find((a) => a.displayName === 'svc')!;
        expect(jdoe.externalUserId).toBe('33221100-5544-7766-8899-aabbccddeeff');
        expect(jdoe.status).toBe('ACTIVE');
        expect(jdoe.isAdmin).toBe(true); // Domain Admins
        expect(jdoe.mfaEnrolled).toBeNull();
        expect(jdoe.ssoEnrolled).toBeNull();
        expect(jdoe.lastActiveAt).toBeInstanceOf(Date);
        expect(svc.status).toBe('SUSPENDED'); // UAC 514 has ACCOUNTDISABLE
        expect(svc.isAdmin).toBe(false);
    });

    it('mapResultToEvidence returns null on ERROR, a REPORT with an active-directory category otherwise', () => {
        const input = { automationKey: 'active-directory.no_dormant_admins', parsed: { provider: 'active-directory', checkType: 'no_dormant_admins', raw: 'active-directory.no_dormant_admins' }, tenantId: 't', connectionConfig: {}, triggeredBy: 'scheduled' as const };
        expect(provider.mapResultToEvidence(input, { status: 'ERROR', summary: '', details: {} })).toBeNull();
        const ev = provider.mapResultToEvidence(input, { status: 'PASSED', summary: 'ok', details: {} });
        expect(ev?.category).toBe('active-directory:no_dormant_admins');
    });
});
