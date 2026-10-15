/**
 * Start the OAuth2 consent flow for an OrangeHRM connection (#3594).
 *
 * POST returns the authorize URL and sets a short-lived HttpOnly
 * `ohrm_oauth_state` cookie carrying `<state>.<tenantSlug>.<connectionId>`. The
 * browser navigates there; the instance redirects back to the tenant-agnostic
 * callback, which verifies the state and attaches the token pair.
 *
 * The connection must already exist and carry its instance URL, client id and
 * client secret — the usecase refuses otherwise, BEFORE the admin is sent
 * anywhere. Redirecting a half-configured connection to the instance would
 * return a code that cannot be exchanged, after the admin had already
 * consented.
 *
 * Unlike the MCP flow, the authorize endpoint is on the CUSTOMER'S OWN HOST, so
 * the URL is built through `assertOrangeHrmHost` — a second check of a host
 * that already passed config validation, at the moment it is about to receive a
 * browser redirect carrying this deployment's callback address.
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

import { env } from '@/env';
import { buildOrangeHrmAuthorizeUrl } from '@/app-layer/integrations/providers/orangehrm/token';
import { orangeHrmConsentTarget } from '@/app-layer/usecases/orangehrm-connection-consent';
import { withApiErrorHandling } from '@/lib/errors/api';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; connectionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.manage',
        async (req: NextRequest, { params }, ctx) => {
            const { host, clientId } = await orangeHrmConsentTarget(ctx, params.connectionId);

            const state = randomUUID();
            const origin = resolvePublicOrigin(req);
            const redirectUri = `${origin}/api/integrations/orangehrm/callback`;

            const authorizeUrl = buildOrangeHrmAuthorizeUrl({
                client: { host, clientId },
                redirectUri,
                state,
            });

            const res = NextResponse.json({ authorizeUrl });
            // `<state>.<tenantSlug>.<connectionId>` — the state is a UUID and
            // the other two are slugs/cuids, none of which contain a dot, so
            // three parts split unambiguously. HttpOnly + SameSite=Lax survives
            // the top-level OAuth redirect; ten minutes is long enough to
            // consent and short enough not to linger.
            res.cookies.set('ohrm_oauth_state', `${state}.${params.tenantSlug}.${params.connectionId}`, {
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
