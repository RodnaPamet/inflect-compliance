/**
 * Start the OAuth2 consent flow for a Workday connection (#3595).
 *
 * POST returns the authorize URL and sets a short-lived HttpOnly
 * `wd_oauth_state` cookie carrying `<state>.<tenantSlug>.<connectionId>`. The
 * browser navigates there; Workday redirects back to the tenant-agnostic
 * callback, which verifies the state and attaches the token pair.
 *
 * ═══ WHY THIS ROUTE DID NOT EXIST ═══
 *
 * `buildWorkdayAuthorizeUrl` has been correct and uncalled since it was
 * written, so a Workday connection could never obtain its first refresh token
 * and `validateConnection` told operators to "complete the OAuth consent" with
 * nothing to complete it through. A unit test over an exported function proves
 * the function works, never that anything calls it.
 *
 * The connection must already exist and carry its Workday identifiers — the
 * usecase refuses otherwise, BEFORE the admin is sent anywhere. Redirecting a
 * half-configured connection to Workday would return a code that cannot be
 * exchanged, after the admin had already consented.
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

import { env } from '@/env';
import { buildWorkdayAuthorizeUrl } from '@/app-layer/integrations/providers/workday/token';
import { workdayConsentTarget } from '@/app-layer/usecases/workday-connection-consent';
import { withApiErrorHandling } from '@/lib/errors/api';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; connectionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.manage',
        async (req: NextRequest, { params }, ctx) => {
            const { host, tenant, clientId } = await workdayConsentTarget(ctx, params.connectionId);

            const state = randomUUID();
            const origin = resolvePublicOrigin(req);
            const redirectUri = `${origin}/api/integrations/workday/callback`;

            // `clientSecret` is not needed to BUILD the URL and is deliberately
            // not fetched into this frame — the builder's type asks for the
            // whole client, so an empty string is passed for the one field that
            // would be a credential sitting in a route handler for no reason.
            const authorizeUrl = buildWorkdayAuthorizeUrl({
                client: { host, tenant, clientId, clientSecret: '' },
                redirectUri,
                state,
            });

            const res = NextResponse.json({ authorizeUrl });
            // `<state>.<tenantSlug>.<connectionId>` — the state is a UUID and
            // the other two are slugs/cuids, none of which contain a dot, so
            // three parts split unambiguously. HttpOnly + SameSite=Lax survives
            // the top-level OAuth redirect; ten minutes is long enough to
            // consent and short enough not to linger.
            res.cookies.set('wd_oauth_state', `${state}.${params.tenantSlug}.${params.connectionId}`, {
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
