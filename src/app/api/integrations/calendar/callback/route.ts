import { NextRequest, NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { getTenantCtx } from '@/app-layer/context';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { exchangeCalendarCode } from '@/app-layer/integrations/providers/calendar/token';
import {
    saveCalendarConnection,
    isCalendarProviderId,
} from '@/app-layer/usecases/user-calendar-connection';
import { getConsentStates, requiresAdminConsent } from '@/app-layer/usecases/tenant-calendar-consent';
import { logger } from '@/lib/observability/logger';

/**
 * Where the provider returns after a USER connects their own calendar.
 *
 * Unlike the admin callback, this one DOES receive an authorization code.
 *
 * Sits outside /t/[tenantSlug] because each provider redirects to one fixed
 * URI; the tenant and provider are recovered from the `cal_oauth_state` cookie
 * (`<state>.<tenantSlug>.<provider>`). SameSite=Lax survives the top-level
 * redirect back.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const url = req.nextUrl;
    const returnedState = url.searchParams.get('state') ?? '';
    const cookie = req.cookies.get('cal_oauth_state')?.value ?? '';
    const [cookieState, tenantSlug, provider] = cookie.split('.');

    const fail = (slug: string | undefined, reason: string) => {
        const back = new URL(slug ? `/t/${slug}/account/calendar` : '/no-tenant', url.origin);
        back.searchParams.set('calendar', reason);
        const res = NextResponse.redirect(back);
        res.cookies.delete('cal_oauth_state');
        return res;
    };

    if (!cookieState || !tenantSlug || !provider || cookieState !== returnedState) {
        logger.warn('calendar callback rejected: state mismatch', {
            component: 'calendar-callback',
            hasCookie: Boolean(cookie),
        });
        return fail(tenantSlug, 'connect_failed');
    }
    if (!isCalendarProviderId(provider)) return fail(tenantSlug, 'connect_failed');

    // The user declined at the provider, or the provider refused. Distinct from
    // a state mismatch, and distinct from a failed exchange — three different
    // remedies, so three different reasons.
    const errorCode = url.searchParams.get('error');
    if (errorCode) {
        logger.info('calendar consent declined at the provider', {
            component: 'calendar-callback',
            tenantSlug,
            provider,
            // The CODE only — `error_description` is provider prose that can
            // carry an email address or a tenant name.
            errorCode,
        });
        return fail(tenantSlug, 'connect_declined');
    }

    const code = url.searchParams.get('code');
    if (!code) return fail(tenantSlug, 'connect_failed');

    const ctx = await getTenantCtx({ tenantSlug }, req);

    // RE-CHECK the tenant grant at the callback, not only at initiation. An
    // admin can withdraw consent inside the ten-minute window between the two,
    // and storing a token minted under an authorisation that no longer exists
    // is exactly the state the revoke was meant to prevent.
    let entraTenantId: string | undefined;
    if (requiresAdminConsent(provider)) {
        const state = (await getConsentStates(ctx)).find((c) => c.provider === provider);
        if (!state?.granted) return fail(tenantSlug, 'consent_withdrawn');
        entraTenantId = state.externalTenantId ?? undefined;
    }

    const origin = resolvePublicOrigin(req);
    const token = await exchangeCalendarCode({
        provider,
        code,
        redirectUri: `${origin}/api/integrations/calendar/callback`,
        entraTenantId,
    });

    await saveCalendarConnection(ctx, {
        provider,
        token,
        // What the provider ACTUALLY granted, which may be narrower than what
        // was asked for — a user can decline individual Google scopes. Recorded
        // so a later push failure can be attributed to a missing scope rather
        // than looking like a revoked connection.
        scopesGranted: (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean),
    });

    const back = new URL(`/t/${tenantSlug}/account/calendar`, url.origin);
    back.searchParams.set('calendar', 'connected');
    const res = NextResponse.redirect(back);
    res.cookies.delete('cal_oauth_state');
    return res;
});
