import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import {
    buildMicrosoftAdminConsentUrl,
    microsoftCalendarClientConfigured,
} from '@/app-layer/integrations/providers/calendar/token';
import {
    CALENDAR_ADMIN_CALLBACK_PATH,
    prepareCalendarAdminConsentFlow,
} from '@/app-layer/integrations/providers/calendar/admin-consent-flow';
import {
    getAdminConsentOverview,
    revokeAdminConsent,
    requiresAdminConsent,
} from '@/app-layer/usecases/tenant-calendar-consent';
import { badRequest, ConflictError } from '@/lib/errors/types';

/**
 * Tenant-wide calendar consent: start it, read it, withdraw it. The consent
 * card on Admin → Integrations is the page that calls these.
 *
 * ═══ WHY THIS IS ADMIN-GATED AND THE USER CONNECT ROUTE IS NOT ═══
 *
 * These are different authorities and the tiers reflect that. Connecting your
 * own calendar affects one person's calendar. Granting tenant-wide consent
 * admits EVERY user in the tenant to a third-party calendar API — Microsoft's
 * grant covers all users unless the app requires assignment — so it is
 * `admin.manage`, and the grant is written to the hash-chained audit trail with
 * a NOT NULL author.
 *
 * The tier is not defensive padding: a key WEAKER than the authority actually
 * exercised is an UNLOGGED gate, because the request passes the middleware and
 * is refused deeper where nothing writes AUTHZ_DENIED.
 *
 * ═══ THE FLOW COOKIE ═══
 *
 * The callback sits OUTSIDE the /t/[tenantSlug] tree (Entra redirects to one
 * fixed URI) and has to recover which workspace this was for, and who asked.
 * Both are sealed into a signed cookie sent only to the callback path
 * (`admin-consent-flow.ts`); Entra is given a random id as `state`. SameSite=Lax
 * survives the top-level redirect back; Strict would not.
 *
 * State is not optional here. This initiates a TENANT-WIDE authorisation, so
 * without it any site could complete one on an admin's behalf.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (req: NextRequest, { params }, ctx) => {
            const provider = req.nextUrl.searchParams.get('provider') ?? 'outlook-calendar';
            if (!requiresAdminConsent(provider)) {
                // Google is per-user by design. Offering an admin-consent flow
                // for it would imply a tenant-wide grant that does not exist.
                throw badRequest(`${provider} does not use tenant-wide admin consent`);
            }
            if (!microsoftCalendarClientConfigured()) {
                // An `/adminconsent` URL with no real client id fails at
                // Microsoft with an error naming nothing the admin can fix.
                throw new ConflictError('This deployment has no Microsoft app registration configured', {
                    reason: 'MICROSOFT_CLIENT_NOT_CONFIGURED',
                });
            }

            const flow = prepareCalendarAdminConsentFlow({ tenantSlug: params.tenantSlug, userId: ctx.userId });
            const origin = resolvePublicOrigin(req);
            const consentUrl = buildMicrosoftAdminConsentUrl({
                redirectUri: `${origin}${CALENDAR_ADMIN_CALLBACK_PATH}`,
                state: flow.state,
            });

            const res = NextResponse.json({ consentUrl });
            flow.bind(res);
            return res;
        },
    ),
);

/**
 * What the consent card shows: granted / withdrawn / never granted, when, by
 * whom and in which directory, and whether this deployment has a Microsoft app
 * registration to send an administrator to at all.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (_req: NextRequest, _routeArgs, ctx) => {
            return Response.json({
                consents: await getAdminConsentOverview(ctx),
                microsoftClientConfigured: microsoftCalendarClientConfigured(),
            });
        },
    ),
);

/**
 * Withdraw the tenant-wide authorisation.
 *
 * Deliberately does NOT bulk-revoke individual connections. Their tokens become
 * unrefreshable and the push path already treats a failed refresh as terminal,
 * so each resolves itself with its own recorded reason — where a bulk revoke
 * would produce one indistinguishable mass event and lose every per-user "why".
 */
export const DELETE = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (req: NextRequest, _routeArgs, ctx) => {
            const provider = req.nextUrl.searchParams.get('provider') ?? 'outlook-calendar';
            if (!requiresAdminConsent(provider)) throw badRequest('Unknown admin-consent provider');
            await revokeAdminConsent(ctx, provider, 'withdrawn by administrator');
            return new Response(null, { status: 204 });
        },
    ),
);
