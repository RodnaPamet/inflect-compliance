/**
 * Entra consent callback for an MCP server connection (tenant-agnostic).
 *
 * ONE registered redirect URI serves every tenant. The IC tenant, the target
 * connection and a CSRF nonce ride in the `mcp_oauth_state` HttpOnly cookie,
 * and the `state` query parameter must equal the cookie's nonce.
 *
 * THE URL IS NEVER TRUSTED ON ITS OWN. The route re-authorises through
 * `getTenantCtx` (session + membership) and `assertCanAdmin` before exchanging
 * anything — a callback that accepted the query alone would let anyone who
 * could make a browser follow a link attach a credential to somebody else's
 * connection.
 *
 * It always redirects to the integrations page, success or failure, so an admin
 * lands somewhere they can act rather than on a blank error.
 */
import { NextRequest, NextResponse } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { assertCanAdmin } from '@/app-layer/policies/common';
import { completeMcpConsent } from '@/app-layer/usecases/mcp-connection-consent';
import { withApiErrorHandling } from '@/lib/errors/api';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { edgeLogger } from '@/lib/observability/edge-logger';

export const GET = withApiErrorHandling(async (req: NextRequest): Promise<NextResponse> => {
    const origin = resolvePublicOrigin(req);
    const params = req.nextUrl.searchParams;

    const cookie = req.cookies.get('mcp_oauth_state')?.value ?? '';
    const [cookieState = '', tenantSlug = '', connectionId = ''] = cookie.split('.');

    const fail = (reason: string, status = 'error') => {
        // The REASON, never the code or any query value: the URL carries an
        // authorization code, and a log line is somewhere it must not reach.
        edgeLogger.warn('MCP consent callback rejected', { component: 'mcp', reason });
        const url = tenantSlug
            ? new URL(`/t/${tenantSlug}/admin/integrations?mcp=${status}`, origin)
            : new URL('/', origin);
        const res = NextResponse.redirect(url);
        res.cookies.delete('mcp_oauth_state');
        return res;
    };

    if (params.get('error')) return fail(params.get('error') ?? 'consent_error', 'declined');

    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) return fail('missing_code_or_state');
    if (!cookieState || !tenantSlug || !connectionId) return fail('missing_state_cookie');
    if (state !== cookieState) return fail('state_mismatch');

    let ctx;
    try {
        ctx = await getTenantCtx({ tenantSlug });
        assertCanAdmin(ctx);
    } catch {
        return fail('not_authorised');
    }

    try {
        await completeMcpConsent(ctx, {
            connectionId,
            code,
            // Must match the value sent to /authorize byte for byte, or Entra
            // refuses the exchange. Rebuilt from the same helper rather than
            // carried in the cookie, so the two cannot disagree.
            redirectUri: `${origin}/api/integrations/mcp-server/callback`,
        });
    } catch (err) {
        edgeLogger.warn('MCP consent exchange failed', {
            component: 'mcp',
            reason: err instanceof Error ? err.name : 'non-Error thrown',
        });
        return fail('exchange_failed');
    }

    const res = NextResponse.redirect(
        new URL(`/t/${tenantSlug}/admin/integrations?mcp=connected`, origin),
    );
    res.cookies.delete('mcp_oauth_state');
    return res;
});
