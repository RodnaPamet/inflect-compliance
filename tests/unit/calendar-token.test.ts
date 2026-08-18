/**
 * Calendar OAuth: two providers, one token machinery, asymmetric consent.
 *
 * Most of what can go wrong here fails A DAY LATER and looks like something
 * else. A missing `prompt=consent` yields no refresh token on a reconnect; a
 * refresh that omits scopes returns a token without `Calendars.ReadWrite` and
 * every write 403s as if consent were revoked; overwriting a rotated refresh
 * token with `undefined` un-authenticates the connection on the NEXT run.
 *
 * None of those is visible at connect time, which is why the assertions below
 * are about request SHAPE rather than about a happy path returning a token.
 */
import {
    buildCalendarAuthorizeUrl,
    buildMicrosoftAdminConsentUrl,
    exchangeCalendarCode,
    refreshCalendarToken,
    resolveCalendarAccessToken,
    GOOGLE_CALENDAR_SCOPES,
    MICROSOFT_CALENDAR_SCOPES,
    type CalendarToken,
} from '@/app-layer/integrations/providers/calendar/token';

const REDIRECT = 'https://app.example.test/api/integrations/calendar/callback';
const NOW_MS = 1_800_000_000_000;

type FetchFn = jest.Mock<ReturnType<typeof fetch>, Parameters<typeof fetch>>;

/**
 * A Response faithful in the two respects `fetchOAuthToken` actually uses:
 * a `content-type` header (it refuses to read a non-JSON body, because a
 * JSON.parse of a gateway's HTML error page is not a credential verdict) and
 * `clone()` (it clones so the caller's own `res.json()` still works — a body
 * can only be read once).
 *
 * A fake missing either makes the classifier bail and return the Response
 * unchanged, which reads as "the classifier does not work" when in fact the
 * fake does not.
 */
const tokenRes = (body: unknown, ok = true, status = 200): Response => {
    const res = {
        ok,
        status,
        headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
        json: async () => body,
        clone: () => res,
    };
    return res as unknown as Response;
};

const okFetch = (over: Record<string, unknown> = {}): FetchFn =>
    jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
        tokenRes({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, ...over }),
    );

/** The form body a token POST actually sent. */
function sentBody(f: FetchFn, call = 0): URLSearchParams {
    const init = f.mock.calls[call][1] as RequestInit;
    return new URLSearchParams(String(init.body));
}

describe('the Google authorize URL', () => {
    const url = () =>
        new URL(buildCalendarAuthorizeUrl({ provider: 'google-calendar', redirectUri: REDIRECT, state: 's1' }));

    it('asks for calendar.events, NOT full calendar access', () => {
        // The narrower scope is what Google's verification asks us to justify.
        // Requesting full calendar access when we only write events is what
        // turns a 10-day review into a rejection.
        expect(url().searchParams.get('scope')).toBe(GOOGLE_CALENDAR_SCOPES.join(' '));
        expect(url().searchParams.get('scope')).not.toContain('auth/calendar ');
        expect(url().searchParams.get('scope')).not.toBe('https://www.googleapis.com/auth/calendar');
    });

    it('sets BOTH access_type=offline AND prompt=consent', () => {
        // Either alone is insufficient and the failure is delayed. offline asks
        // for a refresh token; without prompt=consent Google issues one only on
        // the FIRST ever consent, so a user who reconnects gets none and the
        // connection silently cannot refresh.
        expect(url().searchParams.get('access_type')).toBe('offline');
        expect(url().searchParams.get('prompt')).toBe('consent');
    });

    it('carries state and the redirect', () => {
        expect(url().searchParams.get('state')).toBe('s1');
        expect(url().searchParams.get('redirect_uri')).toBe(REDIRECT);
        expect(url().searchParams.get('response_type')).toBe('code');
    });
});

describe('the Microsoft authorize URL', () => {
    const url = () =>
        new URL(
            buildCalendarAuthorizeUrl({
                provider: 'outlook-calendar',
                redirectUri: REDIRECT,
                state: 's1',
                entraTenantId: 'contoso.onmicrosoft.com',
            }),
        );

    it('asks for Calendars.ReadWrite AND offline_access', () => {
        // offline_access is what yields a refresh token at all.
        expect(url().searchParams.get('scope')).toBe(MICROSOFT_CALENDAR_SCOPES.join(' '));
        expect(url().searchParams.get('scope')).toContain('offline_access');
    });

    it('does NOT force a consent prompt', () => {
        // The admin has consented for the tenant. Forcing a prompt would show
        // every user the screen this design exists to remove — and on a tenant
        // with user consent disabled it would simply fail.
        expect(url().searchParams.get('prompt')).toBeNull();
    });

    it('is tenant-scoped when the customer’s Entra tenant is known', () => {
        expect(url().pathname).toContain('contoso.onmicrosoft.com');
        expect(url().pathname).toContain('/oauth2/v2.0/authorize');
    });
});

describe('the Microsoft ADMIN consent URL is a different endpoint', () => {
    const url = () =>
        new URL(buildMicrosoftAdminConsentUrl({ redirectUri: REDIRECT, state: 'admin-1' }));

    it('hits /adminconsent, not /authorize', () => {
        // Different endpoint AND different response: it returns
        // `admin_consent=True&tenant=…` with NO authorization code, so a
        // callback expecting a code reads success as failure.
        expect(url().pathname).toContain('/adminconsent');
        expect(url().pathname).not.toContain('/authorize');
    });

    it('sends no response_type and no scope', () => {
        // /adminconsent grants everything the app REGISTRATION declares. A
        // scope list here would imply a narrowing that does not happen.
        expect(url().searchParams.get('response_type')).toBeNull();
        expect(url().searchParams.get('scope')).toBeNull();
    });

    it('carries state — this is a tenant-privileged operation', () => {
        // Without it any site could initiate a tenant-wide grant.
        expect(url().searchParams.get('state')).toBe('admin-1');
    });

    it('defaults to `organizations` so the signer’s own tenant is used', () => {
        expect(url().pathname).toContain('organizations');
    });
});

describe('code exchange', () => {
    it('refuses a response with no refresh token, at consent time', async () => {
        // That connection works until the first expiry and then dies overnight.
        // Failing here means failing while the user is present to re-run it.
        const f = okFetch({ refresh_token: undefined });
        await expect(
            exchangeCalendarCode(
                { provider: 'google-calendar', code: 'c', redirectUri: REDIRECT },
                { fetchImpl: f as unknown as typeof fetch, now: () => NOW_MS },
            ),
        ).rejects.toThrow(/refresh token/i);
    });

    it('computes expiresAt from the INJECTED clock', async () => {
        const f = okFetch();
        const t = await exchangeCalendarCode(
            { provider: 'google-calendar', code: 'c', redirectUri: REDIRECT },
            { fetchImpl: f as unknown as typeof fetch, now: () => NOW_MS },
        );
        expect(t.expiresAt).toBe(Math.floor(NOW_MS / 1000) + 3600);
    });

    it('posts to the provider’s own token endpoint', async () => {
        const g = okFetch();
        await exchangeCalendarCode(
            { provider: 'google-calendar', code: 'c', redirectUri: REDIRECT },
            { fetchImpl: g as unknown as typeof fetch, now: () => NOW_MS },
        );
        expect(String(g.mock.calls[0][0])).toContain('oauth2.googleapis.com');

        const m = okFetch();
        await exchangeCalendarCode(
            { provider: 'outlook-calendar', code: 'c', redirectUri: REDIRECT, entraTenantId: 'contoso' },
            { fetchImpl: m as unknown as typeof fetch, now: () => NOW_MS },
        );
        expect(String(m.mock.calls[0][0])).toContain('login.microsoftonline.com/contoso');
    });
});

describe('refresh — the two quirks that fail a day later', () => {
    it('SENDS THE SAME SCOPES, so the token keeps Calendars.ReadWrite', async () => {
        // The trap this file exists for. @/lib/auth/refresh's Microsoft
        // refresher hardcodes the SIGN-IN scope set, so refreshing a calendar
        // token through it returns one WITHOUT Calendars.ReadWrite — about an
        // hour after consent, with every write then 403ing exactly like
        // revoked consent.
        const f = okFetch();
        await refreshCalendarToken(
            { provider: 'outlook-calendar', refreshToken: 'rt' },
            { fetchImpl: f as unknown as typeof fetch, now: () => NOW_MS },
        );
        expect(sentBody(f).get('scope')).toBe(MICROSOFT_CALENDAR_SCOPES.join(' '));
        expect(sentBody(f).get('scope')).toContain('Calendars.ReadWrite');
    });

    it('KEEPS the current refresh token when the provider returns none', async () => {
        // Google does not return one on refresh. Overwriting with undefined
        // un-authenticates the connection on the NEXT run, surfacing a day
        // later as an unrelated failure.
        const f = okFetch({ refresh_token: undefined });
        const t = await refreshCalendarToken(
            { provider: 'google-calendar', refreshToken: 'original-rt' },
            { fetchImpl: f as unknown as typeof fetch, now: () => NOW_MS },
        );
        expect(t.refreshToken).toBe('original-rt');
    });

    it('takes a ROTATED refresh token when the provider issues one', async () => {
        // Microsoft rotates and invalidates the predecessor, so ignoring the
        // new one is the mirror failure.
        const f = okFetch({ refresh_token: 'rotated-rt' });
        const t = await refreshCalendarToken(
            { provider: 'outlook-calendar', refreshToken: 'old-rt' },
            { fetchImpl: f as unknown as typeof fetch, now: () => NOW_MS },
        );
        expect(t.refreshToken).toBe('rotated-rt');
    });

    it('uses the refresh_token grant', async () => {
        const f = okFetch();
        await refreshCalendarToken(
            { provider: 'google-calendar', refreshToken: 'rt' },
            { fetchImpl: f as unknown as typeof fetch, now: () => NOW_MS },
        );
        expect(sentBody(f).get('grant_type')).toBe('refresh_token');
    });
});

describe('resolve', () => {
    const fresh: CalendarToken = { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW_MS / 1000 + 3600 };
    const stale: CalendarToken = { accessToken: 'old', refreshToken: 'rt', expiresAt: NOW_MS / 1000 + 10 };

    it('does not refresh a still-valid token, and reports rotated: null', async () => {
        // So the caller can skip re-encrypting an identical secret on every run.
        const refresh = jest.fn();
        const r = await resolveCalendarAccessToken(
            fresh,
            { provider: 'google-calendar' },
            { now: () => NOW_MS, refresh: refresh as never },
        );
        expect(r).toEqual({ accessToken: 'at', rotated: null });
        expect(refresh).not.toHaveBeenCalled();
    });

    it('refreshes INSIDE the skew, not only after expiry', async () => {
        // A token expiring in 10s is useless for a request about to be made.
        const refresh = jest.fn(async () => ({ accessToken: 'new', refreshToken: 'rt2', expiresAt: 1 }));
        const r = await resolveCalendarAccessToken(
            stale,
            { provider: 'google-calendar' },
            { now: () => NOW_MS, refresh },
        );
        expect(refresh).toHaveBeenCalledWith('rt');
        expect(r.accessToken).toBe('new');
    });

    it('PERSISTS the rotated pair before returning', async () => {
        // Microsoft invalidates the predecessor on rotation, so a failure after
        // this point must not take the new token with it.
        const order: string[] = [];
        const persist = jest.fn(async () => { order.push('persist'); });
        await resolveCalendarAccessToken(
            stale,
            { provider: 'outlook-calendar' },
            {
                now: () => NOW_MS,
                refresh: async () => { order.push('refresh'); return { accessToken: 'n', refreshToken: 'r2', expiresAt: 2 }; },
                persist,
            },
        );
        expect(order).toEqual(['refresh', 'persist']);
        expect(persist).toHaveBeenCalledWith({ accessToken: 'n', refreshToken: 'r2', expiresAt: 2 });
    });

    it('AWAITS the persist — a failed write must not be swallowed', async () => {
        // Ordering alone cannot see this: an unawaited `void persist(...)` still
        // enters the callback synchronously, so a call-order assertion passes
        // while the write is fire-and-forget. The property that matters is that
        // a FAILING persist is observed — otherwise the rotated token is lost,
        // the predecessor is already invalidated by Microsoft, and the
        // connection is dead on the next run with nothing having reported it.
        await expect(
            resolveCalendarAccessToken(
                stale,
                { provider: 'outlook-calendar' },
                {
                    now: () => NOW_MS,
                    refresh: async () => ({ accessToken: 'n', refreshToken: 'r2', expiresAt: 2 }),
                    persist: async () => { throw new Error('db write failed'); },
                },
            ),
        ).rejects.toThrow('db write failed');
    });
});

describe('the token POST goes through the 400-classifier', () => {
    it('a 400 invalid_grant becomes an auth error, not a generic failure', async () => {
        // Withdrawn consent IS a 400 invalid_grant on refresh. Without
        // fetchOAuthToken it reaches the caller as a generic failure, the
        // terminal-consent handling never fires, and the connection keeps its
        // dead token and keeps being scheduled — failing quietly every night.
        const f = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
            tokenRes({ error: 'invalid_grant', error_description: 'Token has been revoked.' }, false, 400),
        );
        await expect(
            refreshCalendarToken(
                { provider: 'google-calendar', refreshToken: 'rt' },
                { fetchImpl: f as unknown as typeof fetch, now: () => NOW_MS },
            ),
        ).rejects.toMatchObject({ name: 'IntegrationAuthError' });
    });

    it('an ordinary 400 stays an ordinary failure', async () => {
        const f = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
            tokenRes({ error: 'invalid_request' }, false, 400),
        );
        await expect(
            refreshCalendarToken(
                { provider: 'google-calendar', refreshToken: 'rt' },
                { fetchImpl: f as unknown as typeof fetch, now: () => NOW_MS },
            ),
        ).rejects.toThrow(/token refresh failed: 400/i);
    });
});
