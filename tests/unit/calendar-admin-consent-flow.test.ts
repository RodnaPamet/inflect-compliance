/**
 * The Microsoft admin-consent round trip (#5937 step 3): bound to its browser,
 * its workspace and the administrator who started it, and ending in a redirect
 * whatever happens.
 *
 *   BOUND      the callback refuses a flow cookie that is absent, forged,
 *              expired, for another `state`, or started by somebody other than
 *              the session — and records nothing for it.
 *   AUTHORITY  the session must still hold `admin.manage` when Entra answers.
 *   REDIRECT   every outcome lands on `/t/<slug>/admin/integrations?calendar=…`
 *              (or the workspace picker when nothing signed names a
 *              workspace), never the API wrapper's JSON body.
 *   ORIGIN     redirects and `redirect_uri` use `resolvePublicOrigin`, not the
 *              container's own origin.
 *   SILENCE    Entra's `error_description` is never reflected, recorded or
 *              logged; only its OAuth code and AADSTS number are.
 *
 * Microsoft is never contacted. The real flow sealing runs against the test
 * AUTH_SECRET; the consent usecases are replaced so the route's decisions are
 * what is observed.
 */
import { NextRequest, NextResponse } from 'next/server';

jest.mock('@/lib/errors/api', () => ({
    withApiErrorHandling: (handler: unknown) => handler,
}));
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission:
        (_key: unknown, handler: (req: unknown, route: unknown, ctx: unknown) => unknown) =>
        (req: unknown, route: unknown) =>
            handler(req, route, currentCtx()),
}));

let ctxUserId = 'admin-1';
let ctxMayManage = true;
const currentCtx = () => ({
    tenantId: 't1',
    userId: ctxUserId,
    requestId: 'r1',
    role: 'ADMIN',
    appPermissions: { admin: { manage: ctxMayManage } },
});

const getTenantCtx = jest.fn(async () => currentCtx());
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...a: unknown[]) => getTenantCtx(...(a as [])),
}));

const appendAuditEntryOrQueue = jest.fn(async () => undefined);
jest.mock('@/lib/audit', () => ({
    ...jest.requireActual('@/lib/audit'),
    appendAuditEntryOrQueue: (...a: unknown[]) => appendAuditEntryOrQueue(...(a as [])),
}));

const logged: unknown[] = [];
jest.mock('@/lib/observability/logger', () => {
    const rec = (...a: unknown[]) => {
        logged.push(a);
    };
    return { logger: { info: rec, warn: rec, error: rec, debug: rec } };
});

const recordAdminConsent = jest.fn(async () => ({}));
const recordAdminConsentFailure = jest.fn(async () => undefined);
const getAdminConsentOverview = jest.fn(async () => []);
const revokeAdminConsent = jest.fn(async () => undefined);
jest.mock('@/app-layer/usecases/tenant-calendar-consent', () => ({
    ...jest.requireActual('@/app-layer/usecases/tenant-calendar-consent'),
    recordAdminConsent: (...a: unknown[]) => recordAdminConsent(...(a as [])),
    recordAdminConsentFailure: (...a: unknown[]) => recordAdminConsentFailure(...(a as [])),
    getAdminConsentOverview: (...a: unknown[]) => getAdminConsentOverview(...(a as [])),
    revokeAdminConsent: (...a: unknown[]) => revokeAdminConsent(...(a as [])),
}));

let clientConfigured = true;
jest.mock('@/app-layer/integrations/providers/calendar/token', () => ({
    ...jest.requireActual('@/app-layer/integrations/providers/calendar/token'),
    microsoftCalendarClientConfigured: () => clientConfigured,
}));

import {
    POST as START,
    GET as READ,
} from '@/app/api/t/[tenantSlug]/admin/calendar/consent/route';
import { GET as CALLBACK } from '@/app/api/integrations/calendar/admin-callback/route';
import {
    CALENDAR_ADMIN_CALLBACK_PATH,
    CALENDAR_ADMIN_FLOW_COOKIE,
    LEGACY_CALENDAR_ADMIN_STATE_COOKIE,
} from '@/app-layer/integrations/providers/calendar/admin-consent-flow';
import {
    CALENDAR_FLOW_COOKIE,
    prepareCalendarOAuthFlow,
} from '@/app-layer/integrations/providers/calendar/oauth-flow';
import { microsoftCalendarClientConfigured } from '@/app-layer/integrations/providers/calendar/token';

const PUBLIC = 'https://app.example.test';
const INTERNAL = 'http://10.0.0.5:3000';
const PROXY_HEADERS = { 'x-forwarded-host': 'app.example.test', 'x-forwarded-proto': 'https' };
const DIRECTORY = '72f988bf-86f1-41af-91ab-2d7cd011db47';

type Handler = (r: NextRequest, c?: unknown) => Promise<NextResponse>;

async function start() {
    const req = new NextRequest(`${INTERNAL}/api/t/acme/admin/calendar/consent?provider=outlook-calendar`, {
        method: 'POST',
        headers: PROXY_HEADERS,
    });
    const res = await (START as unknown as Handler)(req, { params: { tenantSlug: 'acme' } });
    const { consentUrl } = (await res.json()) as { consentUrl: string };
    const cookie = res.cookies.get(CALENDAR_ADMIN_FLOW_COOKIE);
    if (!cookie) throw new Error('start set no flow cookie');
    return { consentUrl: new URL(consentUrl), cookie, res };
}

function flowBody(value: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString('utf8'));
}

async function callback(query: Record<string, string>, cookieHeader?: string) {
    const url = new URL(`${INTERNAL}${CALENDAR_ADMIN_CALLBACK_PATH}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { ...PROXY_HEADERS };
    if (cookieHeader !== undefined) headers.cookie = cookieHeader;
    const res = await (CALLBACK as unknown as Handler)(new NextRequest(url, { headers }));
    const location = res.headers.get('location');
    return { res, location: location ? new URL(location) : null };
}

const asCookie = (value: string) => `${CALENDAR_ADMIN_FLOW_COOKIE}=${value}`;

async function bound() {
    const { consentUrl, cookie } = await start();
    return { state: consentUrl.searchParams.get('state')!, cookie: asCookie(cookie.value) };
}

const expectLanding = (location: URL | null, slug: string | null, outcome: string) => {
    expect(location?.origin).toBe(PUBLIC);
    expect(location?.pathname).toBe(slug ? `/t/${slug}/admin/integrations` : '/tenants');
    expect(location?.searchParams.get('calendar')).toBe(outcome);
    // Nothing but the outcome travels.
    expect([...(location?.searchParams.keys() ?? [])]).toEqual(['calendar']);
};

beforeEach(() => {
    jest.clearAllMocks();
    logged.length = 0;
    ctxUserId = 'admin-1';
    ctxMayManage = true;
    clientConfigured = true;
});

describe('start: a sealed flow naming the workspace and the administrator', () => {
    it('sends Entra only a random state, on the public redirect_uri, and seals slug + starter', async () => {
        const { consentUrl, cookie } = await start();
        const flow = flowBody(cookie.value);

        expect(consentUrl.pathname.endsWith('/adminconsent')).toBe(true);
        expect(consentUrl.searchParams.get('redirect_uri')).toBe(`${PUBLIC}${CALENDAR_ADMIN_CALLBACK_PATH}`);
        expect(consentUrl.searchParams.get('state')).toBe(flow.id);
        // The workspace and the administrator are in the sealed cookie, never in the URL.
        expect(consentUrl.toString()).not.toContain('acme');
        expect(consentUrl.toString()).not.toContain('admin-1');
        expect(flow).toMatchObject({ tenantSlug: 'acme', userId: 'admin-1' });

        expect(cookie.httpOnly).toBe(true);
        expect(cookie.sameSite).toBe('lax');
        expect(cookie.path).toBe(CALENDAR_ADMIN_CALLBACK_PATH);
    });

    it('clears the pre-step-3 cookie at `/`', async () => {
        const { res } = await start();
        const legacy = res.cookies.get(LEGACY_CALENDAR_ADMIN_STATE_COOKIE);
        expect(legacy?.value).toBe('');
        expect(legacy?.path).toBe('/');
        expect(legacy?.maxAge).toBe(0);
    });

    it('refuses to start when the deployment has no Microsoft client, rather than send the admin to a failing page', async () => {
        clientConfigured = false;
        const req = new NextRequest(`${INTERNAL}/api/t/acme/admin/calendar/consent`, { method: 'POST' });
        await expect((START as unknown as Handler)(req, { params: { tenantSlug: 'acme' } })).rejects.toMatchObject({
            status: 409,
        });
    });

    it('the read reports whether a Microsoft client is configured', async () => {
        clientConfigured = false;
        const res = await (READ as unknown as Handler)(new NextRequest(`${INTERNAL}/api/t/acme/admin/calendar/consent`), {
            params: { tenantSlug: 'acme' },
        });
        expect(await res.json()).toEqual({ consents: [], microsoftClientConfigured: false });
    });
});

describe('callback: a grant is recorded only for the bound administrator', () => {
    it('admin_consent=True → recorded with the directory, consent_granted on the public origin, flow spent', async () => {
        const f = await bound();
        const { res, location } = await callback(
            { state: f.state, admin_consent: 'True', tenant: DIRECTORY },
            f.cookie,
        );
        expect(recordAdminConsent).toHaveBeenCalledTimes(1);
        expect(recordAdminConsent).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-1', tenantId: 't1' }), {
            provider: 'outlook-calendar',
            externalTenantId: DIRECTORY,
        });
        expect(getTenantCtx).toHaveBeenCalledWith({ tenantSlug: 'acme' }, expect.anything());
        expectLanding(location, 'acme', 'consent_granted');

        const spent = res.cookies.get(CALENDAR_ADMIN_FLOW_COOKIE);
        expect(spent?.value).toBe('');
        expect(spent?.maxAge).toBe(0);
        expect(spent?.path).toBe(CALENDAR_ADMIN_CALLBACK_PATH);
        expect(res.cookies.get(LEGACY_CALENDAR_ADMIN_STATE_COOKIE)?.path).toBe('/');
    });

    const refused = async (q: Record<string, string>, cookieHeader: string | undefined, slug: string | null) => {
        const { location, res } = await callback(q, cookieHeader);
        expect(recordAdminConsent).not.toHaveBeenCalled();
        expectLanding(location, slug, 'flow_invalid');
        expect(res.cookies.get(CALENDAR_ADMIN_FLOW_COOKIE)?.value).toBe('');
    };

    it('absent cookie → the workspace picker', async () => {
        await refused({ state: 'x', admin_consent: 'True', tenant: DIRECTORY }, undefined, null);
        expect(getTenantCtx).not.toHaveBeenCalled();
    });

    it('the pre-step-3 unsigned cookie is not accepted, and its slug is not trusted', async () => {
        await refused(
            { state: 'abc', admin_consent: 'True', tenant: DIRECTORY },
            `${LEGACY_CALENDAR_ADMIN_STATE_COOKIE}=abc.victim`,
            null,
        );
    });

    it('a returned state that is not the flow\'s → back to the signed workspace', async () => {
        const f = await bound();
        await refused({ state: 'somebody-elses-state', admin_consent: 'True', tenant: DIRECTORY }, f.cookie, 'acme');
    });

    it('a forged body (another workspace, another admin) fails the signature, and its slug is not trusted', async () => {
        const { consentUrl, cookie } = await start();
        const [, mac] = cookie.value.split('.');
        const forged = Buffer.from(
            JSON.stringify({ ...flowBody(cookie.value), tenantSlug: 'victim', userId: 'attacker' }),
        ).toString('base64url');
        await refused(
            { state: consentUrl.searchParams.get('state')!, admin_consent: 'True', tenant: DIRECTORY },
            asCookie(`${forged}.${mac}`),
            null,
        );
    });

    it('a flow sealed by the personal-connect flow does not verify as an admin flow (its own HKDF label)', async () => {
        const personal = prepareCalendarOAuthFlow({ tenantSlug: 'acme', provider: 'outlook-calendar', userId: 'admin-1' });
        const res = NextResponse.json({});
        personal.bind(res);
        const value = res.cookies.get(CALENDAR_FLOW_COOKIE)!.value;
        await refused({ state: personal.state, admin_consent: 'True', tenant: DIRECTORY }, asCookie(value), null);
    });

    it('an expired flow → flow_invalid', async () => {
        const f = await bound();
        const realNow = Date.now;
        Date.now = () => realNow() + 11 * 60 * 1000;
        try {
            await refused({ state: f.state, admin_consent: 'True', tenant: DIRECTORY }, f.cookie, 'acme');
        } finally {
            Date.now = realNow;
        }
    });

    it('another member\'s session → flow_invalid, audited, nothing recorded', async () => {
        const f = await bound();
        ctxUserId = 'admin-2';
        await refused({ state: f.state, admin_consent: 'True', tenant: DIRECTORY }, f.cookie, 'acme');
        expect(recordAdminConsentFailure).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-2' }), {
            provider: 'outlook-calendar',
            outcome: 'flow_invalid',
        });
    });

    it('a session that lost admin.manage mid-flow → not_permitted, AUTHZ_DENIED written, nothing recorded', async () => {
        const f = await bound();
        ctxMayManage = false;
        const { location } = await callback({ state: f.state, admin_consent: 'True', tenant: DIRECTORY }, f.cookie);
        expect(recordAdminConsent).not.toHaveBeenCalled();
        expectLanding(location, 'acme', 'not_permitted');
        expect(appendAuditEntryOrQueue).toHaveBeenCalledWith(expect.objectContaining({ action: 'AUTHZ_DENIED' }));
        expect(recordAdminConsentFailure).toHaveBeenCalledWith(expect.anything(), {
            provider: 'outlook-calendar',
            outcome: 'not_permitted',
        });
    });

    it('no workspace context (signed out, not a member) → consent_failed, nothing recorded', async () => {
        const f = await bound();
        getTenantCtx.mockRejectedValueOnce(new Error('unauthorized'));
        const { location } = await callback({ state: f.state, admin_consent: 'True', tenant: DIRECTORY }, f.cookie);
        expect(recordAdminConsent).not.toHaveBeenCalled();
        expectLanding(location, 'acme', 'consent_failed');
    });
});

describe('callback: Entra\'s answers map to their own outcomes, from codes only', () => {
    const DESCRIPTION_WITH_PII = (n: string) => `${n}: jane.admin@contoso.example declined for Contoso Ltd. Trace ID: 1234`;

    it.each([
        ['access_denied', 'AADSTS65004', 'consent_declined'],
        ['permission_denied', null, 'consent_declined'],
        ['access_denied', 'AADSTS90094', 'not_directory_admin'],
        ['unauthorized_client', 'AADSTS700016', 'app_not_in_directory'],
        ['invalid_request', 'AADSTS90002', 'provider_error'],
        ['server_error', null, 'provider_error'],
    ])('error=%s, %s → %s', async (error, aadsts, outcome) => {
        const f = await bound();
        const q: Record<string, string> = { state: f.state, error };
        if (aadsts) q.error_description = DESCRIPTION_WITH_PII(aadsts);
        const { location } = await callback(q, f.cookie);

        expect(recordAdminConsent).not.toHaveBeenCalled();
        expectLanding(location, 'acme', outcome);
        expect(recordAdminConsentFailure).toHaveBeenCalledWith(expect.anything(), {
            provider: 'outlook-calendar',
            outcome,
            providerErrorCode: error,
            aadstsCode: aadsts,
        });
        // The description's prose reaches neither the URL, the audit row nor a log line.
        const recorded = JSON.stringify([recordAdminConsentFailure.mock.calls, logged, location?.toString()]);
        expect(recorded).not.toContain('jane');
        expect(recorded).not.toContain('Contoso');
        expect(recorded).not.toContain('Trace');
    });

    it('an error code that is not OAuth-shaped is not recorded verbatim', async () => {
        const f = await bound();
        const { location } = await callback({ state: f.state, error: '<script>x</script>' }, f.cookie);
        expectLanding(location, 'acme', 'provider_error');
        expect(recordAdminConsentFailure).toHaveBeenCalledWith(expect.anything(), {
            provider: 'outlook-calendar',
            outcome: 'provider_error',
            providerErrorCode: null,
            aadstsCode: null,
        });
    });

    it('neither admin_consent=True nor an error → provider_error', async () => {
        const f = await bound();
        const { location } = await callback({ state: f.state, admin_consent: 'False' }, f.cookie);
        expect(recordAdminConsent).not.toHaveBeenCalled();
        expectLanding(location, 'acme', 'provider_error');
    });

    it('a `tenant` that is not a directory GUID is never stored', async () => {
        const f = await bound();
        const { location } = await callback(
            { state: f.state, admin_consent: 'True', tenant: '../evil/oauth2' },
            f.cookie,
        );
        expect(recordAdminConsent).not.toHaveBeenCalled();
        expectLanding(location, 'acme', 'provider_error');
    });

    it('a grant that cannot be recorded → consent_failed, still a redirect', async () => {
        const f = await bound();
        recordAdminConsent.mockRejectedValueOnce(new Error('db down'));
        const { location } = await callback({ state: f.state, admin_consent: 'True', tenant: DIRECTORY }, f.cookie);
        expectLanding(location, 'acme', 'consent_failed');
    });

    it('a failure to write the audit row still redirects', async () => {
        const f = await bound();
        recordAdminConsentFailure.mockRejectedValueOnce(new Error('audit down'));
        const { location } = await callback({ state: f.state, error: 'access_denied' }, f.cookie);
        expectLanding(location, 'acme', 'consent_declined');
    });
});

describe('whether a Microsoft client is configured', () => {
    const real = jest.requireActual('@/app-layer/integrations/providers/calendar/token') as {
        microsoftCalendarClientConfigured: typeof microsoftCalendarClientConfigured;
    };
    it.each([
        [{ clientId: 'b0f6…real-guid', clientSecret: 's3cret' }, true],
        [{ clientId: '', clientSecret: 's3cret' }, false],
        [{ clientId: '   ', clientSecret: 's3cret' }, false],
        [{ clientId: 'REPLACE_ME_MICROSOFT_OAUTH_CLIENT_ID', clientSecret: 's3cret' }, false],
        [{ clientId: 'your-microsoft-client-id', clientSecret: 's3cret' }, false],
        [{ clientId: 'b0f6', clientSecret: '' }, false],
    ])('%j → %s', (env, expected) => {
        expect(real.microsoftCalendarClientConfigured(env)).toBe(expected);
    });
});
