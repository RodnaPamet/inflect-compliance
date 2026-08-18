import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { env } from '@/env';
import { requireAnyPermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest, forbidden } from '@/lib/errors/types';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { CALENDAR_BASELINE_PERMISSIONS } from '@/app-layer/usecases/compliance-calendar';
import { buildCalendarAuthorizeUrl } from '@/app-layer/integrations/providers/calendar/token';
import { isCalendarProviderId } from '@/app-layer/usecases/user-calendar-connection';
import { getConsentStates, requiresAdminConsent } from '@/app-layer/usecases/tenant-calendar-consent';

/**
 * A user starts connecting their OWN calendar.
 *
 * Gated by `CALENDAR_BASELINE_PERMISSIONS`, not `admin.manage` and not a new
 * key: this affects one person's calendar, and the derived baseline already
 * means "holds at least one of the permissions the calendar shows". Someone
 * with none has nothing to push, so a separate key would let a role be granted
 * "connect" with nothing to connect about.
 *
 * ═══ THE ADMIN-CONSENT PRECONDITION IS CHECKED HERE, NOT DISCOVERED AT ENTRA ═══
 *
 * For Microsoft, a tenant admin must have granted consent first. We hold that
 * fact locally, so the honest thing is to refuse before the redirect and say
 * why. The alternative — send them to Entra and let AADSTS65001 come back — is
 * a failed round trip to learn something we already knew, and the error it
 * returns is not one an end user can act on.
 *
 * Google is unaffected: its model is per-user consent, so there is nothing to
 * precheck.
 */
export const POST = withApiErrorHandling(
    requireAnyPermission<{ tenantSlug: string }>(
        CALENDAR_BASELINE_PERMISSIONS,
        async (req: NextRequest, { params }, ctx) => {
            const provider = req.nextUrl.searchParams.get('provider') ?? '';
            if (!isCalendarProviderId(provider)) {
                throw badRequest('A known calendar provider is required');
            }

            let entraTenantId: string | undefined;
            if (requiresAdminConsent(provider)) {
                const state = (await getConsentStates(ctx)).find((c) => c.provider === provider);
                if (!state?.granted) {
                    // A refusal the user can act on: it names who has to act.
                    throw forbidden(
                        'Your administrator has not yet authorised calendar access for this organisation.',
                    );
                }
                // Use the directory we were ACTUALLY consented in. Guessing
                // again would send the user to an authority where the grant
                // does not exist.
                entraTenantId = state.externalTenantId ?? undefined;
            }

            const oauthState = randomUUID();
            const origin = resolvePublicOrigin(req);
            const authorizeUrl = buildCalendarAuthorizeUrl({
                provider,
                redirectUri: `${origin}/api/integrations/calendar/callback`,
                state: oauthState,
                entraTenantId,
            });

            const res = NextResponse.json({ authorizeUrl });
            // `<state>.<tenantSlug>.<provider>` — the callback is outside the
            // /t/[tenantSlug] tree and must recover both. State is a UUID and
            // the provider ids contain no dots, so splitting is unambiguous.
            res.cookies.set('cal_oauth_state', `${oauthState}.${params.tenantSlug}.${provider}`, {
                httpOnly: true,
                sameSite: 'lax',
                secure: env.NODE_ENV === 'production',
                path: '/',
                maxAge: 600,
            });
            return res;
        },
    ),
);
