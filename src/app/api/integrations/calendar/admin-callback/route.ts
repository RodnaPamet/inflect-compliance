import { NextRequest, NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { getTenantCtx } from '@/app-layer/context';
import type { RequestContext } from '@/app-layer/types';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { assertPermission } from '@/lib/security/assert-permission';
import {
    CALENDAR_ADMIN_CALLBACK_PATH,
    clearCalendarAdminConsentFlow,
    readCalendarAdminConsentFlow,
} from '@/app-layer/integrations/providers/calendar/admin-consent-flow';
import {
    isEntraTenantId,
    readEntraError,
    type EntraErrorKind,
} from '@/app-layer/integrations/providers/calendar/entra-errors';
import {
    recordAdminConsent,
    recordAdminConsentFailure,
    type CalendarAdminConsentOutcome,
} from '@/app-layer/usecases/tenant-calendar-consent';
import { logger } from '@/lib/observability/logger';

/** Entra's error, as the consent card words it. */
const OUTCOME_FOR_ENTRA_ERROR: Record<EntraErrorKind, Exclude<CalendarAdminConsentOutcome, 'consent_granted'>> = {
    DECLINED: 'consent_declined',
    // On the admin flow, "consent is required" is the grant itself not being
    // given; there is no narrower remedy than trying again.
    CONSENT_REQUIRED: 'consent_declined',
    NOT_DIRECTORY_ADMIN: 'not_directory_admin',
    APP_NOT_IN_DIRECTORY: 'app_not_in_directory',
    OTHER: 'provider_error',
};

/**
 * Where Entra returns after a workspace administrator grants (or refuses)
 * organisation-wide consent.
 *
 * ═══ THIS CALLBACK RECEIVES NO AUTHORIZATION CODE ═══
 *
 * `/adminconsent` answers with `admin_consent=True&tenant=<entra-tenant-id>`
 * and nothing else. A handler written against the ordinary OAuth callback shape
 * reads the ABSENCE of `code` as a failure and reports a successful grant as an
 * error — which is the single most likely way to get this wrong, because every
 * other OAuth callback in the codebase looks for a code.
 *
 * ═══ THE FLOW IS SEALED, AND NAMES WHO ASKED ═══
 *
 * Entra redirects to ONE fixed URI, outside /t/[tenantSlug]. The workspace and
 * the administrator who started the flow are recovered from the signed flow
 * cookie (`admin-consent-flow.ts`), sent only to this path. A missing, forged,
 * expired or mismatched cookie is a refusal, never a "try anyway": the grant
 * covers every person in a workspace. The session must be the administrator
 * who started it, and must STILL hold `admin.manage` — a grant is recorded
 * with its author, and the author must be one who may grant.
 *
 * ═══ EVERY OUTCOME IS A REDIRECT ═══
 *
 * The administrator arrives here in a browser tab from Microsoft. A thrown
 * error used to leave them on the API wrapper's JSON body. Every path below
 * ends in a redirect to `/t/<slug>/admin/integrations?calendar=<outcome>`, the
 * outcome from the closed `CALENDAR_ADMIN_CONSENT_OUTCOMES`, and the flow
 * cookie is spent whatever happened. With no signed flow naming a workspace,
 * the redirect goes to `/tenants`, the workspace picker. The origin is
 * `resolvePublicOrigin`, the one the consent route built `redirect_uri` from.
 *
 * ═══ WHAT IS RECORDED ═══
 *
 * A grant is audited `CALENDAR_ADMIN_CONSENT_GRANTED` by `recordAdminConsent`.
 * Failures after the workspace context resolves are audited
 * `CALENDAR_ADMIN_CONSENT_FAILED`; failures before it are logged only, because
 * nothing trustworthy names a workspace to audit into. Neither ever carries
 * Entra's `error_description`: only its OAuth error code and the AADSTS number.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const url = req.nextUrl;
    const origin = resolvePublicOrigin(req);
    const provider = 'outlook-calendar' as const;

    const back = (slug: string | null, outcome: CalendarAdminConsentOutcome) => {
        const to = new URL(slug ? `/t/${encodeURIComponent(slug)}/admin/integrations` : '/tenants', origin);
        to.searchParams.set('calendar', outcome);
        const res = NextResponse.redirect(to);
        clearCalendarAdminConsentFlow(res);
        return res;
    };

    const read = readCalendarAdminConsentFlow(req, url.searchParams.get('state'));
    if (!read.ok) {
        logger.warn('calendar admin-consent callback rejected: flow not bound', {
            component: 'calendar-admin-callback',
            reason: read.reason,
        });
        return back(read.tenantSlug, 'flow_invalid');
    }
    const { flow } = read;
    const tenantSlug = flow.tenantSlug;

    let ctx: RequestContext;
    try {
        ctx = await getTenantCtx({ tenantSlug }, req);
    } catch (err) {
        logger.warn('calendar admin-consent callback rejected: no tenant context', {
            component: 'calendar-admin-callback',
            tenantSlug,
            error: err instanceof Error ? err.name : 'unknown',
        });
        return back(tenantSlug, 'consent_failed');
    }

    const fail = async (
        outcome: Exclude<CalendarAdminConsentOutcome, 'consent_granted'>,
        codes: { providerErrorCode?: string | null; aadstsCode?: string | null } = {},
    ) => {
        try {
            await recordAdminConsentFailure(ctx, { provider, outcome, ...codes });
        } catch (err) {
            // The audit row records a failure; failing to write it must not
            // leave the administrator on an error page.
            logger.error('calendar admin-consent callback could not record a failure', {
                component: 'calendar-admin-callback',
                tenantId: ctx.tenantId,
                error: err instanceof Error ? err.name : 'unknown',
            });
        }
        return back(tenantSlug, outcome);
    };

    // Another person's session: the grant would be recorded under somebody who
    // never asked for it.
    if (ctx.userId !== flow.userId) {
        logger.warn('calendar admin-consent callback rejected: flow started by another member', {
            component: 'calendar-admin-callback',
            tenantId: ctx.tenantId,
        });
        return fail('flow_invalid');
    }

    // The administrator's authority is asked again here, not only at the
    // start: it can be withdrawn inside the ten-minute window, and a refusal
    // writes the same AUTHZ_DENIED row the route gate would.
    try {
        await assertPermission(ctx, 'admin.manage', { method: 'GET', path: CALENDAR_ADMIN_CALLBACK_PATH });
    } catch {
        return fail('not_permitted');
    }

    // Entra sends `admin_consent=True` on success, and `error` + a description
    // when the administrator declines or cannot grant. Both are absences of a
    // code, so they must be told apart explicitly.
    const errorParam = url.searchParams.get('error');
    if (errorParam) {
        const reading = readEntraError(errorParam, url.searchParams.get('error_description'), 'admin');
        return fail(OUTCOME_FOR_ENTRA_ERROR[reading.kind], {
            providerErrorCode: reading.errorCode,
            aadstsCode: reading.aadstsCode,
        });
    }
    const granted = (url.searchParams.get('admin_consent') ?? '').toLowerCase() === 'true';
    if (!granted) return fail('provider_error');

    // The directory we were ACTUALLY consented in. Later authorize URLs go to
    // it, so it is only ever stored as the GUID Entra sends; anything else in
    // that position is not a directory we can send people to.
    const tenantParam = url.searchParams.get('tenant');
    if (tenantParam !== null && !isEntraTenantId(tenantParam)) return fail('provider_error');
    const externalTenantId = tenantParam;

    try {
        await recordAdminConsent(ctx, { provider, externalTenantId });
    } catch (err) {
        logger.warn('calendar admin-consent callback: the grant could not be recorded', {
            component: 'calendar-admin-callback',
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.name : 'unknown',
        });
        return fail('consent_failed');
    }

    return back(tenantSlug, 'consent_granted');
});
