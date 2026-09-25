/**
 * Start the Entra consent flow for an MCP server connection.
 *
 * POST returns the authorize URL and sets a short-lived HttpOnly
 * `mcp_oauth_state` cookie carrying `<state>.<tenantSlug>.<connectionId>`. The
 * browser navigates there; Microsoft redirects back to the tenant-agnostic
 * callback, which verifies the state and attaches the refresh token.
 *
 * The connection must already exist and carry its Entra identifiers — the
 * usecase refuses otherwise, BEFORE the admin is sent anywhere. Redirecting a
 * half-configured connection to Microsoft would return a code that cannot be
 * exchanged, after the admin had already consented.
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

import { env } from '@/env';
import { buildMcpAuthorizeUrl } from '@/app-layer/integrations/mcp/token';
import { mcpConsentTarget } from '@/app-layer/usecases/mcp-connection-consent';
import { withApiErrorHandling } from '@/lib/errors/api';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; connectionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.manage',
        async (req: NextRequest, { params }, ctx) => {
            const { tenantId, clientId } = await mcpConsentTarget(ctx, params.connectionId);

            const state = randomUUID();
            const origin = resolvePublicOrigin(req);
            const redirectUri = `${origin}/api/integrations/mcp-server/callback`;

            const authorizeUrl = buildMcpAuthorizeUrl({
                tenantId,
                clientId,
                redirectUri,
                state,
            });

            const res = NextResponse.json({ authorizeUrl });
            // `<state>.<tenantSlug>.<connectionId>` — the state is a UUID and
            // the other two are slugs/cuids, none of which contain a dot, so
            // three parts split unambiguously. HttpOnly + SameSite=Lax survives
            // the top-level OAuth redirect; ten minutes is long enough to
            // consent and short enough not to linger.
            res.cookies.set('mcp_oauth_state', `${state}.${params.tenantSlug}.${params.connectionId}`, {
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
