import { NextRequest, NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { getTenantCtx } from '@/app-layer/context';
import type { RequestContext } from '@/app-layer/types';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import {
    CalendarNoRefreshTokenError,
    exchangeCalendarCode,
} from '@/app-layer/integrations/providers/calendar/token';
import {
    CALENDAR_CALLBACK_PATH,
    clearCalendarOAuthFlow,
    readCalendarOAuthFlow,
} from '@/app-layer/integrations/providers/calendar/oauth-flow';
import {
    saveCalendarConnection,
    recordCalendarConnectFailure,
    type CalendarConnectOutcome,
} from '@/app-layer/usecases/user-calendar-connection';
import { getConsentStates, requiresAdminConsent } from '@/app-layer/usecases/tenant-calendar-consent';
import { readEntraError } from '@/app-layer/integrations/providers/calendar/entra-errors';
import { logger } from '@/lib/observability/logger';

/**
 * Where the provider returns after a USER connects their own calendar.
 *
 * Unlike the admin callback, this one DOES receive an authorization code.
 *
 * Sits outside /t/[tenantSlug] because each provider redirects to one fixed
 * URI. The tenant, provider, the member who started the flow and the PKCE
 * verifier are recovered from the sealed flow cookie (`oauth-flow.ts`), which
 * is signed by the server and sent only to this path. SameSite=Lax survives
 * the top-level redirect back.
 *
 * ═══ EVERY OUTCOME IS A REDIRECT ═══
 *
 * The person arrives here in a browser tab from Google or Microsoft. A thrown
 * error used to reach them as the API wrapper's JSON body — a dead end with no
 * way back. So every path below ends in a redirect to
 * `/t/<slug>/calendar?calendar=<outcome>`, the outcome drawn from the closed
 * `CALENDAR_CONNECT_OUTCOMES`, and the flow cookie is spent whatever happened.
 * When no signed flow names a workspace, the redirect goes to `/tenants`, the
 * workspace picker; an unsigned cookie's slug is never trusted, not even for
 * where to send somebody.
 *
 * The redirect is built from `resolvePublicOrigin`, the same origin the connect
 * route built the `redirect_uri` from. `url.origin` is the origin the
 * container was reached at, which behind the proxy is not the public one.
 *
 * ═══ WHAT IS RECORDED ═══
 *
 * Failures after the person's tenant context resolves are audited
 * (`CALENDAR_CONNECT_FAILED`) and logged; failures before it are logged only,
 * because nothing trustworthy names a tenant to audit into. Neither ever
 * carries the code, a token, the verifier or the provider's
 * `error_description`.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const url = req.nextUrl;
    const origin = resolvePublicOrigin(req);

    const back = (slug: string | null, outcome: CalendarConnectOutcome) => {
        const to = new URL(slug ? `/t/${encodeURIComponent(slug)}/calendar` : '/tenants', origin);
        to.searchParams.set('calendar', outcome);
        const res = NextResponse.redirect(to);
        clearCalendarOAuthFlow(res);
        return res;
    };

    const read = readCalendarOAuthFlow(req, url.searchParams.get('state'));
    if (!read.ok) {
        logger.warn('calendar callback rejected: flow not bound', {
            component: 'calendar-callback',
            reason: read.reason,
        });
        return back(read.tenantSlug, 'flow_invalid');
    }
    const { flow } = read;
    const tenantSlug = flow.tenantSlug;
    const provider = flow.provider;

    let ctx: RequestContext;
    try {
        ctx = await getTenantCtx({ tenantSlug }, req);
    } catch (err) {
        // Signed out, or no longer a member of the workspace. The calendar page
        // sends a signed-out person to sign in; a non-member to their picker.
        logger.warn('calendar callback rejected: no tenant context', {
            component: 'calendar-callback',
            tenantSlug,
            provider,
            error: err instanceof Error ? err.name : 'unknown',
        });
        return back(tenantSlug, 'connect_failed');
    }

    // The session must be the person who started the flow. Otherwise a browser
    // that changed session in between would file one person's calendar token
    // under another person.
    if (ctx.userId !== flow.userId) {
        logger.warn('calendar callback rejected: flow started by another member', {
            component: 'calendar-callback',
            tenantId: ctx.tenantId,
            provider,
        });
        await recordCalendarConnectFailure(ctx, { provider, outcome: 'flow_invalid' });
        return back(tenantSlug, 'flow_invalid');
    }

    const fail = async (outcome: Exclude<CalendarConnectOutcome, 'connected'>, providerErrorCode?: string | null) => {
        try {
            await recordCalendarConnectFailure(ctx, { provider, outcome, providerErrorCode });
        } catch (err) {
            // The audit row is a record of a failure; failing to write it must
            // not leave the person on an error page.
            logger.error('calendar callback could not record a failure', {
                component: 'calendar-callback',
                tenantId: ctx.tenantId,
                error: err instanceof Error ? err.name : 'unknown',
            });
        }
        return back(tenantSlug, outcome);
    };

    // The person declined at the provider, or the provider refused. Distinct
    // from a failed exchange: different remedies, so different outcomes.
    const errorCode = url.searchParams.get('error');
    if (errorCode) {
        if (provider === 'outlook-calendar') {
            // Entra's answer is read from its code and AADSTS number only. A
            // missing organisation-wide consent is its own outcome: Inflect's
            // record of the grant is a memory, and an administrator who removed
            // it in the Entra portal is seen only here (design point 1).
            const reading = readEntraError(errorCode, url.searchParams.get('error_description'), 'user');
            const outcome =
                reading.kind === 'CONSENT_REQUIRED'
                    ? 'consent_required'
                    : reading.kind === 'DECLINED'
                      ? 'connect_declined'
                      : 'provider_error';
            return fail(outcome, reading.errorCode);
        }
        return fail(errorCode === 'access_denied' ? 'connect_declined' : 'provider_error', errorCode);
    }

    const code = url.searchParams.get('code');
    if (!code) return fail('provider_error');

    try {
        // RE-CHECK the tenant grant at the callback, not only at initiation. An
        // admin can withdraw consent inside the ten-minute window between the
        // two, and storing a token minted under an authorisation that no longer
        // exists is exactly the state the revoke was meant to prevent.
        let entraTenantId: string | undefined;
        if (requiresAdminConsent(provider)) {
            const state = (await getConsentStates(ctx)).find((c) => c.provider === provider);
            if (!state?.granted) return fail('consent_withdrawn');
            entraTenantId = state.externalTenantId ?? undefined;
        }

        const token = await exchangeCalendarCode({
            provider,
            code,
            redirectUri: `${origin}${CALENDAR_CALLBACK_PATH}`,
            codeVerifier: flow.codeVerifier,
            entraTenantId,
        });

        await saveCalendarConnection(ctx, {
            provider,
            token,
            // What the provider ACTUALLY granted, which may be narrower than
            // what was asked for — a user can decline individual Google scopes.
            // Recorded so a later push failure can be attributed to a missing
            // scope rather than looking like a revoked connection.
            scopesGranted: (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean),
        });
    } catch (err) {
        if (err instanceof CalendarNoRefreshTokenError) return fail('no_refresh_token');
        logger.warn('calendar callback: exchange or save failed', {
            component: 'calendar-callback',
            tenantId: ctx.tenantId,
            provider,
            // The error's NAME only: a provider response can echo the code.
            error: err instanceof Error ? err.name : 'unknown',
        });
        return fail('connect_failed');
    }

    return back(tenantSlug, 'connected');
});
