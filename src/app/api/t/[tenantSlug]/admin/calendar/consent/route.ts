import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { env } from '@/env';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { buildMicrosoftAdminConsentUrl } from '@/app-layer/integrations/providers/calendar/token';
import {
    getConsentStates,
    revokeAdminConsent,
    requiresAdminConsent,
} from '@/app-layer/usecases/tenant-calendar-consent';
import { badRequest } from '@/lib/errors/types';

/**
 * Tenant-wide calendar consent: start it, read it, withdraw it.
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
 * ═══ THE STATE COOKIE ═══
 *
 * `<state>.<tenantSlug>`, HttpOnly + SameSite=Lax, 10 minutes — the SharePoint
 * pattern, for the same reason: the callback sits OUTSIDE the /t/[tenantSlug]
 * tree (Entra redirects to one fixed URI) and has to recover which tenant this
 * was for. SameSite=Lax survives the top-level OAuth redirect; Strict would not.
 *
 * State is not optional here. This initiates a TENANT-WIDE authorisation, so
 * without it any site could start one on an admin's behalf.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (req: NextRequest, { params }, _ctx) => {
            const provider = req.nextUrl.searchParams.get('provider') ?? 'outlook-calendar';
            if (!requiresAdminConsent(provider)) {
                // Google is per-user by design. Offering an admin-consent flow
                // for it would imply a tenant-wide grant that does not exist.
                throw badRequest(`${provider} does not use tenant-wide admin consent`);
            }

            const state = randomUUID();
            const origin = resolvePublicOrigin(req);
            const consentUrl = buildMicrosoftAdminConsentUrl({
                redirectUri: `${origin}/api/integrations/calendar/admin-callback`,
                state,
            });

            const res = NextResponse.json({ consentUrl });
            res.cookies.set('cal_admin_state', `${state}.${params.tenantSlug}`, {
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

/** What the admin settings page shows: granted / withdrawn / never granted. */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (_req: NextRequest, _routeArgs, ctx) => {
            return Response.json({ consents: await getConsentStates(ctx) });
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
