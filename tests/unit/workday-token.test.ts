/**
 * Workday OAuth2 token lifecycle.
 *
 * The value of the SharePoint precedent is not that it saves typing — it is
 * that its dependency injection makes token math testable with no env, no
 * network and no DB. Every case here runs against injected `fetch` and `now`.
 *
 * The cases that matter are the ones that fail a DAY LATER if you get them
 * wrong: a dropped refresh token, an off-by-skew expiry check, and a rotation
 * that is not persisted. None of those surface in a happy-path test.
 */
import {
    WORKDAY_SCOPES,
    buildWorkdayAuthorizeUrl,
    exchangeCodeForWorkdayToken,
    refreshWorkdayToken,
    resolveWorkdayAccessToken,
    type WorkdaySecret,
    type WorkdayOAuthClient,
} from '@/app-layer/integrations/providers/workday/token';

const client: WorkdayOAuthClient = {
    host: 'wd2-impl-services1.workday.com',
    tenant: 'acme_preview',
    clientId: 'cid',
    clientSecret: 'csecret',
};

const jsonRes = (body: unknown, ok = true, status = 200) =>
    ({ ok, status, json: async () => body }) as unknown as Response;

describe('endpoint construction', () => {
    it('builds the tenant-scoped authorize URL', () => {
        const url = new URL(buildWorkdayAuthorizeUrl({ client, redirectUri: 'https://app/cb', state: 'xyz' }));
        expect(url.origin).toBe('https://wd2-impl-services1.workday.com');
        expect(url.pathname).toBe('/ccx/oauth2/acme_preview/authorize');
        expect(url.searchParams.get('client_id')).toBe('cid');
        expect(url.searchParams.get('state')).toBe('xyz');
        expect(url.searchParams.get('scope')).toBe(WORKDAY_SCOPES.join(' '));
    });

    it('tolerates a host given with a scheme or trailing slash', () => {
        // Operators paste what is in their browser bar. Normalising here beats
        // a 404 against `https://https//host/...`.
        const url = buildWorkdayAuthorizeUrl({
            client: { ...client, host: 'https://wd2-impl-services1.workday.com/' },
            redirectUri: 'https://app/cb',
            state: 's',
        });
        expect(url).toContain('https://wd2-impl-services1.workday.com/ccx/oauth2/');
        expect(url).not.toContain('https://https');
    });

    it('refuses an empty host or tenant rather than building a nonsense URL', () => {
        expect(() => buildWorkdayAuthorizeUrl({ client: { ...client, host: '' }, redirectUri: 'r', state: 's' }))
            .toThrow(/host is required/i);
        expect(() => buildWorkdayAuthorizeUrl({ client: { ...client, tenant: '' }, redirectUri: 'r', state: 's' }))
            .toThrow(/tenant is required/i);
    });
});

describe('code exchange', () => {
    it('returns the first pair with an absolute expiry', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(
            jsonRes({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
        );
        const secret = await exchangeCodeForWorkdayToken(
            { client, code: 'c', redirectUri: 'https://app/cb' },
            { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000_000_000_000 },
        );
        expect(secret).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1_000_000_000 + 3600 });

        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('https://wd2-impl-services1.workday.com/ccx/oauth2/acme_preview/token');
        expect(String(init.body)).toContain('grant_type=authorization_code');
    });

    it('sends the client credentials in the Basic header, not the body', async () => {
        // Keeps the secret out of any request-body logging a proxy might do.
        const fetchImpl = jest.fn().mockResolvedValue(
            jsonRes({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
        );
        await exchangeCodeForWorkdayToken(
            { client, code: 'c', redirectUri: 'r' },
            { fetchImpl: fetchImpl as unknown as typeof fetch },
        );
        const init = fetchImpl.mock.calls[0][1];
        expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
        expect(String(init.body)).not.toContain('csecret');
    });

    it('FAILS at consent when no refresh token comes back', async () => {
        // Otherwise the connection works until the first expiry and then dies
        // silently at 04:00 some morning, which reads as an unrelated outage.
        const fetchImpl = jest.fn().mockResolvedValue(jsonRes({ access_token: 'at', expires_in: 3600 }));
        await expect(
            exchangeCodeForWorkdayToken(
                { client, code: 'c', redirectUri: 'r' },
                { fetchImpl: fetchImpl as unknown as typeof fetch },
            ),
        ).rejects.toThrow(/refresh token/i);
    });

    it('surfaces a non-ok exchange', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(jsonRes({}, false, 400));
        await expect(
            exchangeCodeForWorkdayToken(
                { client, code: 'c', redirectUri: 'r' },
                { fetchImpl: fetchImpl as unknown as typeof fetch },
            ),
        ).rejects.toThrow(/400/);
    });
});

describe('refresh keeps the current refresh token when Workday does not rotate it', () => {
    it('carries the old refresh token forward', async () => {
        // The trap. Overwriting with undefined un-authenticates the connection
        // on the NEXT run — a failure a day later, in a different job, that
        // looks nothing like this line.
        const fetchImpl = jest.fn().mockResolvedValue(
            jsonRes({ access_token: 'at2', expires_in: 3600 }),
        );
        const out = await refreshWorkdayToken(
            { client, refreshToken: 'original-rt' },
            { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 },
        );
        expect(out.refreshToken).toBe('original-rt');
        expect(out.accessToken).toBe('at2');
    });

    it('takes the rotated one when Workday does send it', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(
            jsonRes({ access_token: 'at2', refresh_token: 'new-rt', expires_in: 3600 }),
        );
        const out = await refreshWorkdayToken(
            { client, refreshToken: 'original-rt' },
            { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 },
        );
        expect(out.refreshToken).toBe('new-rt');
    });
});

describe('resolve: refresh-on-expiry with skew, and persist the rotation', () => {
    const base = (expiresAt: number): WorkdaySecret => ({ accessToken: 'live', refreshToken: 'rt', expiresAt });

    it('uses the current token when it is comfortably valid, and does not write', async () => {
        const persist = jest.fn();
        const refresh = jest.fn();
        const out = await resolveWorkdayAccessToken(base(2_000), { client }, {
            now: () => 1_000_000, // 1000s — well inside
            refresh, persist,
        });
        expect(out).toEqual({ accessToken: 'live', rotated: null });
        expect(refresh).not.toHaveBeenCalled();
        // Skipping the write matters: re-encrypting an identical secret on
        // every sync is churn on an encrypted column for no change.
        expect(persist).not.toHaveBeenCalled();
    });

    it('refreshes INSIDE the skew window, not only after expiry', async () => {
        // At 30s remaining the token is still nominally valid. Waiting for
        // actual expiry means a request in flight during the boundary fails.
        const refresh = jest.fn().mockResolvedValue(base(9_999));
        const out = await resolveWorkdayAccessToken(base(1_030), { client }, {
            now: () => 1_000_000, // 1000s -> 30s remaining, inside the 60s skew
            refresh,
        });
        expect(refresh).toHaveBeenCalledWith('rt');
        expect(out.rotated).not.toBeNull();
    });

    it('persists the rotated pair', async () => {
        const rotated: WorkdaySecret = { accessToken: 'at2', refreshToken: 'rt2', expiresAt: 9_999 };
        const persist = jest.fn();
        const out = await resolveWorkdayAccessToken(base(0), { client }, {
            now: () => 1_000_000,
            refresh: async () => rotated,
            persist,
        });
        expect(persist).toHaveBeenCalledWith(rotated);
        expect(out).toEqual({ accessToken: 'at2', rotated });
    });

    it('still returns the token when no persist callback is supplied', async () => {
        // The read path must work in contexts with nowhere to write.
        const out = await resolveWorkdayAccessToken(base(0), { client }, {
            now: () => 1_000_000,
            refresh: async () => ({ accessToken: 'at2', refreshToken: 'rt2', expiresAt: 9_999 }),
        });
        expect(out.accessToken).toBe('at2');
    });
});
