import { NextRequest, NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { getTenantCtx } from '@/app-layer/context';
import { recordAdminConsent } from '@/app-layer/usecases/tenant-calendar-consent';
import { logger } from '@/lib/observability/logger';

/**
 * Where Entra returns after a tenant admin grants consent.
 *
 * ═══ THIS CALLBACK RECEIVES NO AUTHORIZATION CODE ═══
 *
 * `/adminconsent` answers with `admin_consent=True&tenant=<entra-tenant-id>`
 * and nothing else. A handler written against the ordinary OAuth callback shape
 * reads the ABSENCE of `code` as a failure and reports a successful grant as an
 * error — which is the single most likely way to get this wrong, because every
 * other OAuth callback in the codebase looks for a code.
 *
 * ═══ WHY IT SITS OUTSIDE /t/[tenantSlug] ═══
 *
 * Entra redirects to ONE fixed URI. The tenant is recovered from the
 * `cal_admin_state` cookie, which carries `<state>.<tenantSlug>` — the
 * SharePoint pattern. Splitting on the FIRST dot is safe because state is a
 * UUID and contains none.
 *
 * The state comparison is the CSRF defence for a tenant-wide authorisation, so
 * a missing or mismatched cookie is a refusal, never a "try anyway".
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const url = req.nextUrl;
    const returnedState = url.searchParams.get('state') ?? '';
    const cookie = req.cookies.get('cal_admin_state')?.value ?? '';

    const dot = cookie.indexOf('.');
    const cookieState = dot < 0 ? '' : cookie.slice(0, dot);
    const tenantSlug = dot < 0 ? '' : cookie.slice(dot + 1);

    if (!cookieState || !tenantSlug || cookieState !== returnedState) {
        // Never proceed on a state mismatch. This grant covers every user in a
        // tenant; a forged one is not a thing to be lenient about.
        logger.warn('calendar admin-consent callback rejected: state mismatch', {
            component: 'calendar-admin-callback',
            hasCookie: Boolean(cookie),
        });
        return NextResponse.redirect(new URL('/no-tenant?calendar=consent_failed', url.origin));
    }

    // Entra sends `admin_consent=True` on success, and `error` + a description
    // when the admin declines or lacks the role. Both are absences of a code,
    // so they must be told apart explicitly rather than by "no code = failed".
    const granted = (url.searchParams.get('admin_consent') ?? '').toLowerCase() === 'true';
    const errorCode = url.searchParams.get('error');
    if (!granted || errorCode) {
        logger.info('calendar admin consent not granted', {
            component: 'calendar-admin-callback',
            tenantSlug,
            // The CODE only. `error_description` is provider prose that can
            // carry a tenant name or an admin's UPN.
            errorCode,
        });
        const back = new URL(`/t/${tenantSlug}/admin/integrations`, url.origin);
        back.searchParams.set('calendar', errorCode ? 'consent_declined' : 'consent_failed');
        return NextResponse.redirect(back);
    }

    // The Entra tenant we were ACTUALLY consented in. Subsequent authorize URLs
    // must use it — guessing again would send users to the wrong authority, and
    // a multi-tenant admin can legitimately consent in a directory that is not
    // the one we would have assumed.
    const externalTenantId = url.searchParams.get('tenant');

    const ctx = await getTenantCtx({ tenantSlug }, req);
    await recordAdminConsent(ctx, { provider: 'outlook-calendar', externalTenantId });

    const back = new URL(`/t/${tenantSlug}/admin/integrations`, url.origin);
    back.searchParams.set('calendar', 'consent_granted');
    const res = NextResponse.redirect(back);
    // Single-use: the state has done its job and a lingering cookie is a
    // replayable token for a tenant-wide grant.
    res.cookies.delete('cal_admin_state');
    return res;
});
