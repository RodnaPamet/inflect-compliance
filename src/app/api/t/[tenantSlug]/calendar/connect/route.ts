import { NextRequest, NextResponse } from 'next/server';
import { requireAnyPermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { CALENDAR_BASELINE_PERMISSIONS } from '@/app-layer/usecases/compliance-calendar';
import { buildCalendarAuthorizeUrl } from '@/app-layer/integrations/providers/calendar/token';
import {
    CALENDAR_CALLBACK_PATH,
    prepareCalendarOAuthFlow,
} from '@/app-layer/integrations/providers/calendar/oauth-flow';
import { isCalendarProviderId } from '@/app-layer/usecases/user-calendar-connection';
import { assertCalendarConnectable } from '@/app-layer/usecases/calendar-connectability';

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
 *
 * ═══ PKCE, AND WHERE THE VERIFIER LIVES ═══
 *
 * Every flow carries an S256 PKCE challenge. The verifier is sealed, with the
 * tenant, provider and the starting member's id, into an HttpOnly cookie signed
 * by the server and sent only to the callback path (`oauth-flow.ts`, the SSO
 * flow cookie's pattern). The provider sees a random `state` and the challenge;
 * the verifier is never in a URL and never in this response's body.
 */
export const POST = withApiErrorHandling(
    requireAnyPermission<{ tenantSlug: string }>(
        CALENDAR_BASELINE_PERMISSIONS,
        async (req: NextRequest, { params }, ctx) => {
            const provider = req.nextUrl.searchParams.get('provider') ?? '';
            if (!isCalendarProviderId(provider)) {
                throw badRequest('A known calendar provider is required');
            }

            // The same rule `GET /calendar/connections` reports to the Connect
            // control (`calendar-connectability.ts`), so the page offers a
            // provider exactly where this route accepts it: a deployment with
            // no OAuth client for the provider is a 409, and Microsoft without
            // the workspace's organisation consent a 403 — refused here rather
            // than discovered at Entra, as AADSTS65001, after a failed round
            // trip. For Microsoft it returns the directory the consent was
            // granted in, the authority the person must be sent to.
            const { entraTenantId } = await assertCalendarConnectable(ctx, provider);

            // The callback is outside the /t/[tenantSlug] tree and recovers the
            // tenant, provider, member and verifier from this sealed flow.
            const flow = prepareCalendarOAuthFlow({
                tenantSlug: params.tenantSlug,
                provider,
                userId: ctx.userId,
            });
            const origin = resolvePublicOrigin(req);
            const authorizeUrl = buildCalendarAuthorizeUrl({
                provider,
                redirectUri: `${origin}${CALENDAR_CALLBACK_PATH}`,
                state: flow.state,
                codeChallenge: flow.codeChallenge,
                entraTenantId,
            });

            const res = NextResponse.json({ authorizeUrl });
            flow.bind(res);
            return res;
        },
    ),
);
