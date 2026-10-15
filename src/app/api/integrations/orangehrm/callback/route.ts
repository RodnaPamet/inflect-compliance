/**
 * OrangeHRM OAuth2 consent callback, tenant-agnostic (#3594).
 *
 * The instance redirects here after the admin consents. This is a single
 * registered redirect URI for every tenant and every connection; the tenant,
 * the connection and a CSRF nonce ride in the `ohrm_oauth_state` HttpOnly
 * cookie, and the `state` query parameter must equal the cookie's nonce.
 *
 * The route re-authorises via `getTenantCtx` (session + membership) and
 * `assertCanAdmin` before exchanging anything — it never trusts the URL alone,
 * and the connection id comes from the cookie rather than the query, so the two
 * cannot disagree.
 *
 * Always redirects back to the admin integrations page (success or error in the
 * query) so the admin lands somewhere sensible regardless of outcome.
 */
import { NextRequest, NextResponse } from 'next/server';

import { completeOrangeHrmConsent } from '@/app-layer/usecases/orangehrm-connection-consent';
import { getTenantCtx } from '@/app-layer/context';
import { assertCanAdmin } from '@/app-layer/policies/common';
import { withApiErrorHandling } from '@/lib/errors/api';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { edgeLogger } from '@/lib/observability/edge-logger';

export const GET = withApiErrorHandling(async (req: NextRequest): Promise<NextResponse> => {
    const origin = resolvePublicOrigin(req);
    const params = req.nextUrl.searchParams;
    const cookie = req.cookies.get('ohrm_oauth_state')?.value ?? '';
    const [cookieState = '', tenantSlug = '', connectionId = ''] = cookie.split('.');

    const fail = (reason: string, status = 'error'): NextResponse => {
        // The reason, never the code or the state. A consent callback's query
        // string is the one place an authorization code appears in a URL, and
        // a log line carrying it would be a single-use credential in a log
        // aggregator.
        edgeLogger.warn('OrangeHRM consent callback rejected', { component: 'orangehrm', reason });
        const url = tenantSlug
            ? new URL(`/t/${tenantSlug}/admin/integrations?ohrm=${status}`, origin)
            : new URL('/', origin);
        const res = NextResponse.redirect(url);
        res.cookies.delete('ohrm_oauth_state');
        return res;
    };

    // The instance surfaced a consent error (declined, etc.).
    if (params.get('error')) return fail(params.get('error') ?? 'consent_error', 'declined');

    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) return fail('missing_code_or_state');
    if (!cookieState || !tenantSlug || !connectionId) return fail('missing_state_cookie');
    if (state !== cookieState) return fail('state_mismatch');

    // Re-authorise as the tenant admin (session + membership + admin gate).
    let ctx;
    try {
        ctx = await getTenantCtx({ tenantSlug });
        assertCanAdmin(ctx);
    } catch {
        return fail('not_authorised');
    }

    // Byte-identical to the one the consent route sent, because both derive it
    // from `resolvePublicOrigin`. league/oauth2-server compares the two and
    // answers `invalid_grant` on any difference — including a trailing slash.
    const redirectUri = `${origin}/api/integrations/orangehrm/callback`;

    try {
        await completeOrangeHrmConsent(ctx, { connectionId, code, redirectUri });
    } catch (e) {
        // Swallowed into a redirect rather than rethrown as a 500: the admin is
        // in a browser mid-flow and an error page here loses the connection
        // they were configuring. The reason is logged; the message is not put
        // in the query string, because it can carry an upstream body.
        edgeLogger.warn('OrangeHRM consent exchange failed', {
            component: 'orangehrm',
            reason: e instanceof Error ? e.message : String(e),
        });
        return fail('exchange_failed');
    }

    const res = NextResponse.redirect(
        new URL(`/t/${tenantSlug}/admin/integrations?ohrm=connected`, origin),
    );
    res.cookies.delete('ohrm_oauth_state');
    return res;
});
