/**
 * Branch coverage for `providers/okta/index.ts` — the READ side of the JML
 * chain.
 *
 * The existing suites cover the happy enumeration + the enrichment auth
 * classification (tests/unit/identity-enrichment.test.ts) and the org-URL
 * allowlist (tests/unit/okta-org-url-allowlist.test.ts). What was left
 * untaken is everything that only happens when something goes WRONG or when
 * the directory is bigger than a fixture:
 *
 *   • the lifecycle-status map — SUSPENDED / DEPROVISIONED / LOCKED_OUT.
 *     Getting these wrong is how a leaver keeps reading ACTIVE forever.
 *   • the MAX_USERS truncation — `complete: false` is the flag that stops the
 *     sync deprovisioning the accounts it never saw, and the resume cursor is
 *     what stops the next run stalling in the same place.
 *   • the MAX_ENRICH cap and the per-user failure counter — both leave `null`
 *     signals behind, which silently shrinks what mfa_enforced measures. The
 *     warn is the only thing that says so.
 *   • the validateConnection failure arms.
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));

import { OktaProvider, parseNextLink } from '@/app-layer/integrations/providers/okta';

const ORG = 'https://acme.okta.com';
const CFG = { orgUrl: ORG, apiToken: 'tok' };

type RespOpts = { ok?: boolean; status?: number; link?: string | null };
function resp(body: unknown, opts: RespOpts = {}): Response {
    const { ok = true, status = 200, link = null } = opts;
    return {
        ok,
        status,
        json: async () => body,
        headers: { get: (h: string) => (h.toLowerCase() === 'link' ? link : null) },
    } as unknown as Response;
}

const oktaUser = (over: Record<string, unknown> = {}) => ({
    id: 'u1',
    status: 'ACTIVE',
    profile: { email: 'ada@acme.com' },
    ...over,
});

/** Enumerate one page of users with enrichment OFF, so normalization is what is observed. */
async function normalize(user: Record<string, unknown>) {
    const fetchImpl = jest.fn(async () => resp([user])) as unknown as typeof fetch;
    const p = new OktaProvider({ fetchImpl });
    const { accounts } = await p.listAccounts({ ...CFG, enrichPerUser: 'false' });
    return accounts[0];
}

beforeEach(() => {
    mockLogger.warn.mockClear();
});

describe('Okta lifecycle-status mapping', () => {
    it('carries SUSPENDED and DEPROVISIONED through as themselves', async () => {
        expect((await normalize(oktaUser({ status: 'SUSPENDED' }))).status).toBe('SUSPENDED');
        expect((await normalize(oktaUser({ status: 'DEPROVISIONED' }))).status).toBe('DEPROVISIONED');
    });

    it('treats every non-ACTIVE lifecycle state as SUSPENDED, not as ACTIVE', async () => {
        // The default arm is the fail-closed one: a STAGED / LOCKED_OUT /
        // PASSWORD_EXPIRED account must not read as an active user, or
        // mfa_enforced counts it in the population it measures.
        for (const status of ['STAGED', 'PROVISIONED', 'LOCKED_OUT', 'PASSWORD_EXPIRED', 'RECOVERY']) {
            expect((await normalize(oktaUser({ status }))).status).toBe('SUSPENDED');
        }
        expect((await normalize(oktaUser({ status: 'ACTIVE' }))).status).toBe('ACTIVE');
    });
});

describe('Okta user normalization', () => {
    it('prefers displayName, then first+last, then leaves the name undefined', async () => {
        expect(
            (
                await normalize(
                    oktaUser({
                        profile: { email: 'a@acme.com', displayName: 'Ada L', firstName: 'Ada', lastName: 'Lovelace' },
                    }),
                )
            ).displayName,
        ).toBe('Ada L');
        expect(
            (await normalize(oktaUser({ profile: { email: 'a@acme.com', firstName: 'Ada', lastName: 'Lovelace' } })))
                .displayName,
        ).toBe('Ada Lovelace');
        expect(
            (await normalize(oktaUser({ profile: { email: 'a@acme.com', lastName: 'Lovelace' } }))).displayName,
        ).toBe('Lovelace');
        expect((await normalize(oktaUser({ profile: { email: 'a@acme.com' } }))).displayName).toBeUndefined();
    });

    it('falls back from profile.email to profile.login, then to an empty address', async () => {
        expect((await normalize(oktaUser({ profile: { login: 'ada@acme.com' } }))).email).toBe('ada@acme.com');
        expect((await normalize(oktaUser({ profile: undefined }))).email).toBe('');
    });

    it('reads MFA off _embedded.factors only when the payload actually carries them', async () => {
        // Absent factors must stay `null` (unknown) — measuring an absent array
        // as "no MFA" would make mfa_enforced fail every account on a payload
        // that never answered the question.
        expect((await normalize(oktaUser({}))).mfaEnrolled).toBeNull();
        expect((await normalize(oktaUser({ _embedded: { factors: [] } }))).mfaEnrolled).toBe(false);
        expect(
            (await normalize(oktaUser({ _embedded: { factors: [{ status: 'PENDING_ACTIVATION' }] } }))).mfaEnrolled,
        ).toBe(false);
        expect(
            (
                await normalize(
                    oktaUser({ _embedded: { factors: [{ status: 'PENDING_ACTIVATION' }, { status: 'ACTIVE' }] } }),
                )
            ).mfaEnrolled,
        ).toBe(true);
    });

    it('derives ssoEnrolled from the credentials provider type', async () => {
        expect((await normalize(oktaUser({ credentials: { provider: { type: 'FEDERATION' } } }))).ssoEnrolled).toBe(
            true,
        );
        expect((await normalize(oktaUser({ credentials: { provider: { type: 'SOCIAL' } } }))).ssoEnrolled).toBe(true);
        expect((await normalize(oktaUser({ credentials: { provider: { type: 'OKTA' } } }))).ssoEnrolled).toBe(false);
        expect((await normalize(oktaUser({}))).ssoEnrolled).toBe(false);
    });

    it('never answers the on-prem question, so the leaver rail cannot read a write-target off Okta', async () => {
        expect((await normalize(oktaUser({}))).onPremisesSyncEnabled).toBeNull();
    });

    it('parses lastLogin and treats a null one as never', async () => {
        expect((await normalize(oktaUser({ lastLogin: '2026-01-02T03:04:05.000Z' }))).lastActiveAt).toEqual(
            new Date('2026-01-02T03:04:05.000Z'),
        );
        expect((await normalize(oktaUser({ lastLogin: null }))).lastActiveAt).toBeNull();
        expect((await normalize(oktaUser({}))).lastActiveAt).toBeNull();
    });
});

describe('Okta enumeration — pagination and truncation', () => {
    it('follows the rel="next" Link header and reports a complete enumeration when it runs out', async () => {
        const page2 = `${ORG}/api/v1/users?after=cursor2&limit=200`;
        const fetchImpl = jest.fn(async (url: string) =>
            url.includes('after=cursor2')
                ? resp([oktaUser({ id: 'u2' })])
                : resp([oktaUser({ id: 'u1' })], { link: `<${page2}>; rel="next"` }),
        ) as unknown as typeof fetch;

        const p = new OktaProvider({ fetchImpl });
        const res = await p.listAccounts({ ...CFG, enrichPerUser: 'false' });

        expect(res.accounts.map((a) => a.externalUserId)).toEqual(['u1', 'u2']);
        expect(res.complete).toBe(true);
        expect(res.resumeToken).toBeNull();
        expect((fetchImpl as unknown as jest.Mock).mock.calls[1][0]).toBe(page2);
    });

    it('stops at MAX_USERS, reports the enumeration INCOMPLETE, and hands back the cursor', async () => {
        // `complete: false` is what stops the sync deprovisioning the 5001st
        // account it never enumerated; the resume token is what stops the next
        // run restarting at page one and stalling in exactly the same place.
        const next = `${ORG}/api/v1/users?after=page26&limit=200`;
        const users = Array.from({ length: 5000 }, (_, i) => oktaUser({ id: `u${i}` }));
        const fetchImpl = jest.fn(async () =>
            resp(users, { link: `<${next}>; rel="next"` }),
        ) as unknown as typeof fetch;

        const p = new OktaProvider({ fetchImpl });
        const res = await p.listAccounts({ ...CFG, enrichPerUser: 'false' });

        expect(res.accounts).toHaveLength(5000);
        expect(res.complete).toBe(false);
        expect(res.resumeToken).toBe(next);
        // The cap is a stop, not a slow-down: no further page is requested.
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('throws with the status when a users page is rejected', async () => {
        const fetchImpl = jest.fn(async () => resp(null, { ok: false, status: 503 })) as unknown as typeof fetch;
        await expect(new OktaProvider({ fetchImpl }).listAccounts(CFG)).rejects.toThrow(
            'Okta users fetch failed (HTTP 503)',
        );
    });
});

describe('Okta per-user enrichment — the opt-out is exactly the string "false"', () => {
    function enrichingFetch(users: Array<Record<string, unknown>>) {
        return jest.fn(async (url: string) => {
            if (url.includes('/api/v1/users?')) return resp(users);
            if (url.endsWith('/roles')) return resp([{ type: 'SUPER_ADMIN' }]);
            return resp([{ status: 'ACTIVE' }]);
        }) as unknown as typeof fetch;
    }

    it('skips enrichment for boolean false and for "FALSE" in any case', async () => {
        for (const enrichPerUser of [false, 'FALSE', 'False']) {
            const p = new OktaProvider({ fetchImpl: enrichingFetch([oktaUser({})]) });
            const { accounts } = await p.listAccounts({ ...CFG, enrichPerUser });
            expect(accounts[0].isAdmin).toBeNull();
        }
    });

    it('enriches for any other value, including an absent flag and a nonsense one', async () => {
        for (const enrichPerUser of [undefined, 'no', true]) {
            const p = new OktaProvider({ fetchImpl: enrichingFetch([oktaUser({})]) });
            const { accounts } = await p.listAccounts({ ...CFG, enrichPerUser });
            expect(accounts[0].isAdmin).toBe(true);
            expect(accounts[0].mfaEnrolled).toBe(true);
        }
    });

    it('leaves a signal null when the endpoint answers something that is not a list', async () => {
        // A shape change on Okta's side must not be read as "no factors" /
        // "no roles" — that would be a manufactured PASS on mfa_enforced.
        const fetchImpl = jest.fn(async (url: string) => {
            if (url.includes('/api/v1/users?')) return resp([oktaUser({})]);
            return resp({ errorCode: 'E0000006' });
        }) as unknown as typeof fetch;

        const { accounts } = await new OktaProvider({ fetchImpl }).listAccounts(CFG);
        expect(accounts[0].isAdmin).toBeNull();
        expect(accounts[0].mfaEnrolled).toBeNull();
    });

    it('counts per-user failures and says how many, rather than leaving it to be inferred', async () => {
        const fetchImpl = jest.fn(async (url: string) => {
            if (url.includes('/api/v1/users?')) return resp([oktaUser({ id: 'u1' }), oktaUser({ id: 'u2' })]);
            if (url.includes('/u2/')) return resp(null, { ok: false, status: 500 });
            if (url.endsWith('/roles')) return resp([]);
            return resp([{ status: 'ACTIVE' }]);
        }) as unknown as typeof fetch;

        const { accounts } = await new OktaProvider({ fetchImpl }).listAccounts(CFG);

        expect(accounts[0].mfaEnrolled).toBe(true);
        expect(accounts[1].mfaEnrolled).toBeNull();
        expect(mockLogger.warn).toHaveBeenCalledWith(
            'okta enrichment incomplete — some accounts have unknown MFA/admin signals',
            expect.objectContaining({ provider: 'okta', enrichFailures: 1, enrichAttempted: 2 }),
        );
    });

    it('does not warn about failures when every account enriched cleanly', async () => {
        const p = new OktaProvider({ fetchImpl: enrichingFetch([oktaUser({})]) });
        await p.listAccounts(CFG);
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('caps the enrichment fan-out at 2000 and leaves the remainder UNKNOWN, logged', async () => {
        // Past the cap the signal stays null so the checks report
        // NOT_APPLICABLE for those accounts. A silent cap would instead let
        // mfa_enforced quietly measure a subset of the directory and call it
        // the whole.
        const users = Array.from({ length: 2001 }, (_, i) => oktaUser({ id: `u${i}` }));
        const p = new OktaProvider({ fetchImpl: enrichingFetch(users) });

        const { accounts } = await p.listAccounts(CFG);

        expect(accounts[1999].isAdmin).toBe(true);
        expect(accounts[2000].isAdmin).toBeNull();
        expect(accounts[2000].mfaEnrolled).toBeNull();
        expect(mockLogger.warn).toHaveBeenCalledWith(
            'Okta per-user enrichment capped; accounts past the cap keep null (NOT_APPLICABLE) signals',
            expect.objectContaining({ total: 2001, enriched: 2000 }),
        );
    });
});

describe('OktaProvider.validateConnection — the failure arms', () => {
    it('reports the status when the directory ping is rejected', async () => {
        const fetchImpl = jest.fn(async () => resp(null, { ok: false, status: 401 })) as unknown as typeof fetch;
        expect(await new OktaProvider({ fetchImpl }).validateConnection(CFG, { apiToken: 'tok' })).toEqual({
            valid: false,
            error: 'Okta directory ping failed (HTTP 401).',
        });
    });

    it('reports a thrown transport failure rather than letting it escape the Test button', async () => {
        const fetchImpl = jest.fn(async () => {
            throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch;
        expect(await new OktaProvider({ fetchImpl }).validateConnection(CFG, { apiToken: 'tok' })).toEqual({
            valid: false,
            error: 'Okta connection failed: ECONNREFUSED',
        });
    });

    it('stringifies a non-Error throw', async () => {
        const fetchImpl = jest.fn(async () => {
            throw 'nope';
        }) as unknown as typeof fetch;
        expect((await new OktaProvider({ fetchImpl }).validateConnection(CFG, { apiToken: 'tok' })).error).toBe(
            'Okta connection failed: nope',
        );
    });

    it('requires the API token before it reaches any request', async () => {
        const fetchImpl = jest.fn() as unknown as typeof fetch;
        expect(await new OktaProvider({ fetchImpl }).validateConnection(CFG, {})).toEqual({
            valid: false,
            error: 'An Okta API token is required.',
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('sends the token as an SSWS credential against the validated origin', async () => {
        const fetchImpl = jest.fn(async () => resp([])) as unknown as typeof fetch;
        expect(await new OktaProvider({ fetchImpl }).validateConnection(CFG, { apiToken: 'tok' })).toEqual({
            valid: true,
        });
        const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
        expect(url).toBe(`${ORG}/api/v1/users?limit=1`);
        expect((init.headers as Record<string, string>).Authorization).toBe('SSWS tok');
    });
});

describe('parseNextLink', () => {
    it('picks rel="next" out of a multi-relation header, ignoring self and prev', () => {
        const header = [
            `<${ORG}/api/v1/users?limit=200>; rel="self"`,
            `<${ORG}/api/v1/users?after=a&limit=200>; rel="prev"`,
            `<${ORG}/api/v1/users?after=b&limit=200>; rel="next"`,
        ].join(', ');
        expect(parseNextLink(header)).toBe(`${ORG}/api/v1/users?after=b&limit=200`);
    });

    it('returns null for an absent header and for one with no next relation', () => {
        expect(parseNextLink(null)).toBeNull();
        expect(parseNextLink(`<${ORG}/api/v1/users>; rel="self"`)).toBeNull();
    });
});
