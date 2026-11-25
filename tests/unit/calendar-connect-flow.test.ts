/**
 * The personal calendar connect round trip: bound to its browser, its person
 * and its PKCE verifier, and ending in a redirect whatever happens.
 *
 * Four properties, each of which regressed silently before #5937:
 *
 *   PKCE       the authorize URL carries an S256 challenge and the exchange
 *              sends the verifier — read from the sealed flow cookie, never the
 *              URL. A flow whose cookie is absent, forged, expired, for another
 *              state, or carries no usable verifier spends no code.
 *   PERSON     the callback refuses a session other than the one that started
 *              the flow, so one person's token is never filed under another.
 *   REDIRECT   every failure lands on `/t/<slug>/calendar?calendar=<outcome>`
 *              (or the workspace picker when nothing signed names a workspace),
 *              never the API wrapper's JSON body.
 *   ORIGIN     the redirect uses `resolvePublicOrigin`, as the connect route's
 *              `redirect_uri` does, not the container's own origin.
 *
 * The provider is never contacted: `exchangeCalendarCode` is replaced, and the
 * real flow sealing (`oauth-flow.ts`) runs against the test AUTH_SECRET.
 */
import { NextRequest, NextResponse } from 'next/server';

jest.mock('@/lib/errors/api', () => ({
    withApiErrorHandling: (handler: unknown) => handler,
}));
jest.mock('@/lib/security/permission-middleware', () => ({
    requireAnyPermission:
        (_keys: unknown, handler: (req: unknown, route: unknown, ctx: unknown) => unknown) =>
        (req: unknown, route: unknown) =>
            handler(req, route, currentCtx()),
}));

let ctxUserId = 'u1';
const currentCtx = () => ({ tenantId: 't1', userId: ctxUserId, requestId: 'r1' });

const getTenantCtx = jest.fn(async () => currentCtx());
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => getTenantCtx(...(a as [])),
}));

const getConsentStates = jest.fn(async () => [
    { provider: 'outlook-calendar', granted: true, externalTenantId: 'contoso-tid' },
]);
jest.mock('@/app-layer/usecases/tenant-calendar-consent', () => ({
    getConsentStates: (...a: unknown[]) => getConsentStates(...(a as [])),
    requiresAdminConsent: (p: string) => p === 'outlook-calendar',
}));

const saveCalendarConnection = jest.fn(async () => ({ id: 'conn-1' }));
const recordCalendarConnectFailure = jest.fn(async () => undefined);
jest.mock('@/app-layer/usecases/user-calendar-connection', () => ({
    ...jest.requireActual('@/app-layer/usecases/user-calendar-connection'),
    saveCalendarConnection: (...a: unknown[]) => saveCalendarConnection(...(a as [])),
    recordCalendarConnectFailure: (...a: unknown[]) => recordCalendarConnectFailure(...(a as [])),
}));

const exchangeCalendarCode = jest.fn(async () => ({ accessToken: 'at', refreshToken: 'rt', expiresAt: 2_000_000_000 }));
jest.mock('@/app-layer/integrations/providers/calendar/token', () => ({
    ...jest.requireActual('@/app-layer/integrations/providers/calendar/token'),
    exchangeCalendarCode: (...a: unknown[]) => exchangeCalendarCode(...(a as [])),
}));

import { POST as CONNECT } from '@/app/api/t/[tenantSlug]/calendar/connect/route';
import { GET as CALLBACK } from '@/app/api/integrations/calendar/callback/route';
import {
    CALENDAR_CALLBACK_PATH,
    CALENDAR_FLOW_COOKIE,
    LEGACY_CALENDAR_STATE_COOKIE,
} from '@/app-layer/integrations/providers/calendar/oauth-flow';
import {
    CalendarNoRefreshTokenError,
    pkceChallengeFor,
} from '@/app-layer/integrations/providers/calendar/token';

const PUBLIC = 'https://app.example.test';
/** The container is reached at its own origin behind the proxy. */
const INTERNAL = 'http://10.0.0.5:3000';
const PROXY_HEADERS = { 'x-forwarded-host': 'app.example.test', 'x-forwarded-proto': 'https' };

type Provider = 'google-calendar' | 'outlook-calendar';

async function connect(provider: Provider) {
    const req = new NextRequest(`${INTERNAL}/api/t/acme/calendar/connect?provider=${provider}`, {
        method: 'POST',
        headers: PROXY_HEADERS,
    });
    const res = (await (CONNECT as unknown as (r: NextRequest, c: unknown) => Promise<NextResponse>)(req, {
        params: { tenantSlug: 'acme' },
    })) as NextResponse;
    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const cookie = res.cookies.get(CALENDAR_FLOW_COOKIE);
    if (!cookie) throw new Error('connect set no flow cookie');
    return { authorizeUrl: new URL(authorizeUrl), cookie };
}

function flowBody(cookieValue: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(cookieValue.split('.')[0], 'base64url').toString('utf8'));
}

async function callback(query: Record<string, string>, cookieValue?: string) {
    const url = new URL(`${INTERNAL}${CALENDAR_CALLBACK_PATH}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { ...PROXY_HEADERS };
    if (cookieValue !== undefined) headers.cookie = `${CALENDAR_FLOW_COOKIE}=${cookieValue}`;
    const res = (await (CALLBACK as unknown as (r: NextRequest) => Promise<NextResponse>)(
        new NextRequest(url, { headers }),
    )) as NextResponse;
    const location = res.headers.get('location');
    return { res, location: location ? new URL(location) : null };
}

beforeEach(() => {
    jest.clearAllMocks();
    ctxUserId = 'u1';
});

describe('connect: PKCE on both providers, the verifier only in the sealed cookie', () => {
    it.each(['google-calendar', 'outlook-calendar'] as const)('%s', async (provider) => {
        const { authorizeUrl, cookie } = await connect(provider);
        const flow = flowBody(cookie.value);

        expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authorizeUrl.searchParams.get('code_challenge')).toBe(pkceChallengeFor(String(flow.codeVerifier)));
        // The state the provider gets is the flow's id, and the verifier is
        // nowhere in the URL.
        expect(authorizeUrl.searchParams.get('state')).toBe(flow.id);
        expect(authorizeUrl.toString()).not.toContain(String(flow.codeVerifier));
        // The redirect_uri is built from the PUBLIC origin.
        expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${PUBLIC}${CALENDAR_CALLBACK_PATH}`);

        expect(flow).toMatchObject({ tenantSlug: 'acme', provider, userId: 'u1' });
        expect(cookie.httpOnly).toBe(true);
        expect(cookie.path).toBe(CALENDAR_CALLBACK_PATH);
        expect(cookie.sameSite).toBe('lax');
    });
});

describe('callback: the verifier comes from the flow and is checked on return', () => {
    it.each(['google-calendar', 'outlook-calendar'] as const)(
        '%s: a bound flow exchanges with the SEALED verifier and redirects connected',
        async (provider) => {
            const { authorizeUrl, cookie } = await connect(provider);
            const { location } = await callback(
                { state: authorizeUrl.searchParams.get('state')!, code: 'the-code', scope: 'a b' },
                cookie.value,
            );
            const flow = flowBody(cookie.value);
            expect(exchangeCalendarCode).toHaveBeenCalledTimes(1);
            expect(exchangeCalendarCode.mock.calls[0]).toEqual([
                expect.objectContaining({
                    provider,
                    code: 'the-code',
                    codeVerifier: flow.codeVerifier,
                    redirectUri: `${PUBLIC}${CALENDAR_CALLBACK_PATH}`,
                }),
            ]);
            expect(saveCalendarConnection).toHaveBeenCalledTimes(1);
            expect(location?.origin).toBe(PUBLIC);
            expect(location?.pathname).toBe('/t/acme/calendar');
            expect(location?.searchParams.get('calendar')).toBe('connected');
        },
    );

    it('the flow cookie is spent on success', async () => {
        const { authorizeUrl, cookie } = await connect('google-calendar');
        const { res } = await callback({ state: authorizeUrl.searchParams.get('state')!, code: 'c' }, cookie.value);
        const spent = res.cookies.get(CALENDAR_FLOW_COOKIE);
        expect(spent?.value).toBe('');
        expect(spent?.maxAge).toBe(0);
        // The pre-hardening cookie lived at `/`; an expiry with no path would
        // be scoped to the callback's directory and leave it in place.
        const legacy = res.cookies.get(LEGACY_CALENDAR_STATE_COOKIE);
        expect(legacy?.value).toBe('');
        expect(legacy?.path).toBe('/');
        expect(legacy?.maxAge).toBe(0);
    });
});

describe('callback: an unbound flow is refused before any code is spent', () => {
    const refusedWithoutExchange = async (q: Record<string, string>, cookieValue: string | undefined, slug: string | null) => {
        const { location, res } = await callback(q, cookieValue);
        expect(exchangeCalendarCode).not.toHaveBeenCalled();
        expect(saveCalendarConnection).not.toHaveBeenCalled();
        expect(location?.origin).toBe(PUBLIC);
        expect(location?.pathname).toBe(slug ? `/t/${slug}/calendar` : '/tenants');
        expect(location?.searchParams.get('calendar')).toBe('flow_invalid');
        expect(res.cookies.get(CALENDAR_FLOW_COOKIE)?.value).toBe('');
    };

    it('absent cookie → the workspace picker, flow_invalid', async () => {
        await refusedWithoutExchange({ state: 'x', code: 'c' }, undefined, null);
    });

    it('a returned state that is not the flow\'s → flow_invalid, back to the signed workspace', async () => {
        const { cookie } = await connect('google-calendar');
        await refusedWithoutExchange({ state: 'somebody-elses-state', code: 'c' }, cookie.value, 'acme');
    });

    it('a cookie whose body was altered (e.g. a swapped verifier) fails the signature, and its slug is not trusted', async () => {
        const { authorizeUrl, cookie } = await connect('google-calendar');
        const [, mac] = cookie.value.split('.');
        const flow = flowBody(cookie.value);
        const swapped = Buffer.from(
            JSON.stringify({ ...flow, codeVerifier: 'A'.repeat(43), tenantSlug: 'victim' }),
        ).toString('base64url');
        await refusedWithoutExchange(
            { state: authorizeUrl.searchParams.get('state')!, code: 'c' },
            `${swapped}.${mac}`,
            null,
        );
    });

    it('an expired flow → flow_invalid', async () => {
        const { authorizeUrl, cookie } = await connect('google-calendar');
        const realNow = Date.now;
        Date.now = () => realNow() + 11 * 60 * 1000;
        try {
            await refusedWithoutExchange({ state: authorizeUrl.searchParams.get('state')!, code: 'c' }, cookie.value, 'acme');
        } finally {
            Date.now = realNow;
        }
    });

    it('a session other than the one that started the flow → flow_invalid, audited', async () => {
        const { authorizeUrl, cookie } = await connect('google-calendar');
        ctxUserId = 'u2';
        await refusedWithoutExchange({ state: authorizeUrl.searchParams.get('state')!, code: 'c' }, cookie.value, 'acme');
        expect(recordCalendarConnectFailure).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u2' }),
            { provider: 'google-calendar', outcome: 'flow_invalid' },
        );
    });
});

describe('callback: every failure redirects to its outcome, never a JSON error', () => {
    async function bound(provider: Provider = 'google-calendar') {
        const { authorizeUrl, cookie } = await connect(provider);
        return { state: authorizeUrl.searchParams.get('state')!, cookie: cookie.value };
    }
    const expectOutcome = (location: URL | null, outcome: string) => {
        expect(location?.origin).toBe(PUBLIC);
        expect(location?.pathname).toBe('/t/acme/calendar');
        expect(location?.searchParams.get('calendar')).toBe(outcome);
    };

    it('declined at the provider → connect_declined', async () => {
        const f = await bound();
        const { location } = await callback({ state: f.state, error: 'access_denied', error_description: 'jane@x.test said no' }, f.cookie);
        expectOutcome(location, 'connect_declined');
        expect(exchangeCalendarCode).not.toHaveBeenCalled();
        expect(recordCalendarConnectFailure).toHaveBeenCalledWith(expect.anything(), {
            provider: 'google-calendar',
            outcome: 'connect_declined',
            providerErrorCode: 'access_denied',
        });
        // The description is never reflected or recorded.
        expect(location?.toString()).not.toContain('jane');
        expect(JSON.stringify(recordCalendarConnectFailure.mock.calls)).not.toContain('jane');
    });

    it('any other provider error → provider_error', async () => {
        const f = await bound('outlook-calendar');
        const { location } = await callback({ state: f.state, error: 'invalid_client' }, f.cookie);
        expectOutcome(location, 'provider_error');
    });

    it.each([
        // Design point 1: an admin consent removed in the Entra portal is seen
        // only here. Mapped from Entra's codes; unverified against a real
        // directory (docs/calendar-push-design.md).
        [{ error: 'consent_required' }, 'consent_required'],
        [{ error: 'invalid_client', error_description: 'AADSTS65001: The user or administrator has not consented. jane@x.test' }, 'consent_required'],
        [{ error: 'access_denied', error_description: 'AADSTS90094: The grant requires admin permission. Contoso' }, 'consent_required'],
        [{ error: 'access_denied', error_description: 'AADSTS65004: User declined to consent. jane@x.test' }, 'connect_declined'],
    ])('Outlook: %j → %s, from the codes only', async (q, outcome) => {
        const f = await bound('outlook-calendar');
        const { location } = await callback({ state: f.state, ...q }, f.cookie);
        expectOutcome(location, outcome);
        expect(exchangeCalendarCode).not.toHaveBeenCalled();
        expect(recordCalendarConnectFailure).toHaveBeenCalledWith(expect.anything(), {
            provider: 'outlook-calendar',
            outcome,
            providerErrorCode: q.error,
        });
        const recorded = JSON.stringify([recordCalendarConnectFailure.mock.calls, location?.toString()]);
        expect(recorded).not.toContain('jane');
        expect(recorded).not.toContain('Contoso');
    });

    it('Google: consent_required is not read as a Microsoft organisation consent', async () => {
        const f = await bound('google-calendar');
        const { location } = await callback({ state: f.state, error: 'consent_required' }, f.cookie);
        expectOutcome(location, 'provider_error');
    });

    it('no code and no error → provider_error', async () => {
        const f = await bound();
        const { location } = await callback({ state: f.state }, f.cookie);
        expectOutcome(location, 'provider_error');
    });

    it('admin consent withdrawn mid-flow → consent_withdrawn, no exchange', async () => {
        const f = await bound('outlook-calendar');
        getConsentStates.mockResolvedValueOnce([]);
        const { location } = await callback({ state: f.state, code: 'c' }, f.cookie);
        expectOutcome(location, 'consent_withdrawn');
        expect(exchangeCalendarCode).not.toHaveBeenCalled();
    });

    it('no refresh token → no_refresh_token, nothing saved', async () => {
        const f = await bound();
        exchangeCalendarCode.mockRejectedValueOnce(new CalendarNoRefreshTokenError());
        const { location } = await callback({ state: f.state, code: 'c' }, f.cookie);
        expectOutcome(location, 'no_refresh_token');
        expect(saveCalendarConnection).not.toHaveBeenCalled();
    });

    it('a failed code exchange → connect_failed, and the code is not in what is recorded', async () => {
        const f = await bound();
        exchangeCalendarCode.mockRejectedValueOnce(new Error('Calendar code exchange failed: 400 the-secret-code'));
        const { location } = await callback({ state: f.state, code: 'the-secret-code' }, f.cookie);
        expectOutcome(location, 'connect_failed');
        expect(JSON.stringify(recordCalendarConnectFailure.mock.calls)).not.toContain('the-secret-code');
    });

    it('a failed save → connect_failed', async () => {
        const f = await bound();
        saveCalendarConnection.mockRejectedValueOnce(new Error('db down'));
        const { location } = await callback({ state: f.state, code: 'c' }, f.cookie);
        expectOutcome(location, 'connect_failed');
    });

    it('no tenant context (signed out, or no longer a member) → connect_failed', async () => {
        const f = await bound();
        getTenantCtx.mockRejectedValueOnce(new Error('unauthorized'));
        const { location } = await callback({ state: f.state, code: 'c' }, f.cookie);
        expectOutcome(location, 'connect_failed');
        expect(exchangeCalendarCode).not.toHaveBeenCalled();
    });

    it('a failure to write the audit row still redirects', async () => {
        const f = await bound();
        recordCalendarConnectFailure.mockRejectedValueOnce(new Error('audit down'));
        const { location } = await callback({ state: f.state, error: 'access_denied' }, f.cookie);
        expectOutcome(location, 'connect_declined');
    });

});
