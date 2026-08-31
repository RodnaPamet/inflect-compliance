/**
 * The remaining untaken branches on the two cloud directory readers —
 * `providers/google-workspace/index.ts` and `providers/entra-id/index.ts`.
 *
 * Both files already sit at 100% lines, so nothing here is about executing
 * code: every case is a branch that only runs on a refusal, a fallback, a
 * second page, or a truncation. Two of them are load-bearing for the leaver
 * chain in particular:
 *
 *   • Entra's `onPremStateObserved` — a Graph payload that explicitly SENDS
 *     `onPremisesSyncEnabled: null` is an ANSWER ("not synced, manageable in
 *     Entra"), while an absent property is no answer at all. Both surface as
 *     the same `null` value, and only this flag separates them. Collapsing
 *     them is how a cloud-only tenant's leaver path goes permanently inert —
 *     or, in the other direction, how a synced account gets a write it will
 *     silently revert.
 *   • the MAX_USERS truncation on both — `complete: false` is what stops a
 *     partial enumeration driving deprovisioning.
 */
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { GoogleWorkspaceProvider, getGoogleAccessToken } from '@/app-layer/integrations/providers/google-workspace';
import { EntraIdProvider } from '@/app-layer/integrations/providers/entra-id';

const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const jsonErr = (status: number) => ({ ok: false, status, json: async () => ({}) });

/** A throwaway RSA key so the DWD assertion can actually be signed. */
function serviceAccount(): { client_email: string; private_key: string } {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return {
        client_email: 'svc@example.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
}

function assertionClaim(body: string): Record<string, unknown> {
    const assertion = new URLSearchParams(body).get('assertion') ?? '';
    return JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

// ─────────────────────────── Google Workspace ───────────────────────────

describe('getGoogleAccessToken — key shapes and rejections', () => {
    it('accepts an already-parsed service-account object, not just the pasted JSON string', async () => {
        let sent = '';
        const doFetch = (async (_url: unknown, init?: RequestInit) => {
            sent = String(init?.body ?? '');
            return jsonOk({ access_token: 'tok' });
        }) as unknown as typeof fetch;
        const sa = serviceAccount();

        await expect(
            getGoogleAccessToken({ serviceAccountJson: sa, adminEmail: 'admin@acme.com' }, doFetch),
        ).resolves.toBe('tok');
        expect(assertionClaim(sent).iss).toBe(sa.client_email);
        expect(assertionClaim(sent).sub).toBe('admin@acme.com');
    });

    it('impersonates nobody rather than the string "undefined" when adminEmail is absent', async () => {
        let sent = '';
        const doFetch = (async (_url: unknown, init?: RequestInit) => {
            sent = String(init?.body ?? '');
            return jsonOk({ access_token: 'tok' });
        }) as unknown as typeof fetch;

        await getGoogleAccessToken({ serviceAccountJson: JSON.stringify(serviceAccount()) }, doFetch);

        expect(assertionClaim(sent).sub).toBe('');
    });

    it('throws with the status when the token endpoint rejects the exchange', async () => {
        const doFetch = (async () => jsonErr(500)) as unknown as typeof fetch;
        await expect(
            getGoogleAccessToken({ serviceAccountJson: JSON.stringify(serviceAccount()) }, doFetch),
        ).rejects.toThrow('Google token exchange failed (HTTP 500)');
    });

    it('throws when a 200 carries no access_token, instead of returning "undefined" as a bearer', async () => {
        const doFetch = (async () => jsonOk({ expires_in: 3599 })) as unknown as typeof fetch;
        await expect(
            getGoogleAccessToken({ serviceAccountJson: JSON.stringify(serviceAccount()) }, doFetch),
        ).rejects.toThrow('Google token exchange returned no access_token');
    });
});

describe('GoogleWorkspaceProvider — SSO coverage over the live Cloud Identity surface', () => {
    const CFG = { domain: 'acme.com', adminEmail: 'admin@acme.com' };
    const user = { id: 'g1', primaryEmail: 'ada@acme.com' };

    /** Route the directory read and the SSO-assignment pages. */
    function gwsFetch(ssoPages: Array<unknown | 'fail'>) {
        let ssoCall = 0;
        return jest.fn(async (url: string) => {
            if (url.includes('/admin/directory/')) return jsonOk({ users: [user] });
            const page = ssoPages[Math.min(ssoCall++, ssoPages.length - 1)];
            if (page === 'fail') return jsonErr(403);
            return jsonOk(page);
        });
    }

    const run = async (fetchImpl: jest.Mock, over: Record<string, unknown> = {}) => {
        const p = new GoogleWorkspaceProvider({
            getAccessToken: async () => 'tok',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        return p.listAccounts({ ...CFG, ...over });
    };

    it('pages through the assignments before deciding, and only then reports coverage', async () => {
        // A customer-wide SAML assignment on page two is still customer-wide.
        // Stopping at page one would report "SAML exists but is scoped" —
        // i.e. NOT_APPLICABLE — on a tenant that has full SSO.
        const fetchImpl = gwsFetch([
            { inboundSsoAssignments: [{ ssoMode: 'SSO_OFF' }], nextPageToken: 'p2' },
            { inboundSsoAssignments: [{ ssoMode: 'SAML_SSO' }] },
        ]);

        const { accounts } = await run(fetchImpl);

        expect(accounts[0].ssoEnrolled).toBe(true);
        const ssoUrls = fetchImpl.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('inboundSsoAssignments'));
        expect(ssoUrls).toHaveLength(2);
        expect(ssoUrls[1]).toContain('pageToken=p2');
    });

    it('reports NOT enrolled when the assignments list carries nothing at all', async () => {
        // No SAML assignment anywhere is a real, failing answer — not unknown.
        const { accounts } = await run(gwsFetch([{}]));
        expect(accounts[0].ssoEnrolled).toBe(false);
    });

    it('leaves SSO unknown when the assignments surface refuses the read', async () => {
        // A missing cloud-identity scope must not be read as "no SSO
        // configured", which would fail sso_enforced for the wrong reason.
        const { accounts } = await run(gwsFetch(['fail']));
        expect(accounts[0].ssoEnrolled).toBeNull();
    });

    it('skips the enrichment entirely for a boolean false and for "FALSE"', async () => {
        for (const enrichSso of [false, 'FALSE']) {
            const fetchImpl = gwsFetch([{ inboundSsoAssignments: [{ ssoMode: 'SAML_SSO' }] }]);
            const { accounts } = await run(fetchImpl, { enrichSso });
            expect(accounts[0].ssoEnrolled).toBeNull();
            expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('inboundSsoAssignments'))).toBe(false);
        }
    });
});

describe('GoogleWorkspaceProvider — default construction', () => {
    it('refuses an incomplete connection before it can reach the network', async () => {
        // Built with no injected deps at all, so the only reason no request is
        // made is that the field checks run first.
        const p = new GoogleWorkspaceProvider();
        expect(await p.validateConnection({ domain: 'acme.com' }, {})).toEqual({
            valid: false,
            error: 'An admin email to impersonate is required.',
        });
    });
});

// ─────────────────────────── Microsoft Entra ID ───────────────────────────

describe('EntraIdProvider — the three states of the on-prem question', () => {
    const CONFIG = { tenantId: 't-1', clientId: 'c-1' };
    const enumerate = async (userOver: Record<string, unknown>) => {
        const fetchImpl = jest.fn(async (url: string) => {
            if (url.includes('/users')) return jsonOk({ value: [{ id: 'u-1', userPrincipalName: 'ada@acme.com', ...userOver }] });
            return jsonOk({ value: [] });
        }) as unknown as typeof fetch;
        const p = new EntraIdProvider({ getAccessToken: async () => 'tok', fetchImpl });
        return (await p.listAccounts(CONFIG)).accounts[0];
    };

    it('treats an explicit null from Graph as an ANSWER — the directory said "not synced"', async () => {
        // Graph documents `true` as "synced from on-premises AD" and anything
        // else as "manageable in Microsoft Entra ID". A null it actually SENT
        // is that "otherwise", so the observation is real and the leaver pass
        // may act on it. Reading it as "no answer" is what left every
        // cloud-only tenant's leaver path permanently inert.
        const a = await enumerate({ onPremisesSyncEnabled: null });
        expect(a.onPremisesSyncEnabled).toBeNull();
        expect(a.onPremStateObserved).toBe(true);
    });

    it('claims no observation when the property is simply absent from the payload', async () => {
        const a = await enumerate({});
        expect(a.onPremisesSyncEnabled).toBeNull();
        expect(a.onPremStateObserved).toBe(false);
    });

    it('carries a true through as a synced account, which the write rail refuses', async () => {
        const a = await enumerate({ onPremisesSyncEnabled: true });
        expect(a.onPremisesSyncEnabled).toBe(true);
        expect(a.onPremStateObserved).toBe(true);
    });
});

describe('EntraIdProvider — truncation and domain edges', () => {
    const CONFIG = { tenantId: 't-1', clientId: 'c-1' };

    it('stops at MAX_USERS, reports the enumeration incomplete, and carries the nextLink out', async () => {
        const next = 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc';
        const value = Array.from({ length: 5000 }, (_, i) => ({
            id: `u-${i}`,
            userPrincipalName: `u${i}@acme.com`,
            accountEnabled: true,
        }));
        const fetchImpl = jest.fn(async (url: string) => {
            if (url.includes('/users')) return jsonOk({ value, '@odata.nextLink': next });
            return jsonOk({ value: [] });
        }) as unknown as typeof fetch;

        const p = new EntraIdProvider({ getAccessToken: async () => 'tok', fetchImpl });
        const res = await p.listAccounts(CONFIG);

        expect(res.accounts).toHaveLength(5000);
        expect(res.complete).toBe(false);
        expect(res.resumeToken).toBe(next);
        // One users page only — the cap stops the walk rather than slowing it.
        expect(
            (fetchImpl as unknown as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('/users')),
        ).toHaveLength(1);
    });

    it('leaves SSO unknown for an address whose domain part is empty', async () => {
        // `ada@` has an `@` but nothing after it. Slicing blindly would look up
        // the empty string, which cannot be in the verified-domain map — same
        // answer by luck. Returning null is the answer by decision.
        const fetchImpl = jest.fn(async (url: string) => {
            if (url.includes('/users')) return jsonOk({ value: [{ id: 'u-1', mail: 'ada@' }] });
            if (url.includes('/domains')) {
                return jsonOk({ value: [{ id: 'acme.com', authenticationType: 'Federated' }] });
            }
            return jsonOk({ value: [] });
        }) as unknown as typeof fetch;

        const p = new EntraIdProvider({ getAccessToken: async () => 'tok', fetchImpl });
        const { accounts } = await p.listAccounts(CONFIG);

        expect(accounts[0].email).toBe('ada@');
        expect(accounts[0].ssoEnrolled).toBeNull();
    });

    it('pages the verified-domain list before deciding federation', async () => {
        // The federated domain on page two decides this account. Stopping at
        // page one would report the user as NOT SSO-enrolled — a FAIL manufactured
        // by pagination rather than by the tenant's configuration.
        const fetchImpl = jest.fn(async (url: string) => {
            if (url.includes('/users')) return jsonOk({ value: [{ id: 'u-1', mail: 'ada@second.com' }] });
            if (url.includes('/domains')) {
                return url.includes('skiptoken')
                    ? jsonOk({ value: [{ id: 'second.com', authenticationType: 'Federated' }] })
                    : jsonOk({
                          value: [{ id: 'first.com', authenticationType: 'Managed' }],
                          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/domains?$skiptoken=d2',
                      });
            }
            return jsonOk({ value: [] });
        }) as unknown as typeof fetch;

        const p = new EntraIdProvider({ getAccessToken: async () => 'tok', fetchImpl });
        const { accounts } = await p.listAccounts(CONFIG);

        expect(accounts[0].ssoEnrolled).toBe(true);
    });

    it('tolerates enrichment pages that carry no value array at all', async () => {
        const fetchImpl = jest.fn(async (url: string) => {
            if (url.includes('/users')) return jsonOk({ value: [{ id: 'u-1', mail: 'ada@acme.com' }] });
            return jsonOk({});
        }) as unknown as typeof fetch;

        const p = new EntraIdProvider({ getAccessToken: async () => 'tok', fetchImpl });
        const { accounts } = await p.listAccounts(CONFIG);

        // Roles answered with an empty population, so admin is a definite false;
        // MFA and the domains answered nothing, so both stay unknown.
        expect(accounts[0].isAdmin).toBe(false);
        expect(accounts[0].mfaEnrolled).toBeNull();
        expect(accounts[0].ssoEnrolled).toBeNull();
    });
});

describe('EntraIdProvider — default construction', () => {
    it('refuses an incomplete connection before it can reach the network', async () => {
        const p = new EntraIdProvider();
        expect(await p.validateConnection({ tenantId: 't-1' }, { clientSecret: 's' })).toEqual({
            valid: false,
            error: 'An Application (client) ID is required.',
        });
    });
});
