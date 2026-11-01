import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getEntraProvider, upsertEntraProvider } from '@/app-layer/usecases/entra-provider';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { env } from '@/env';
import { publicBaseUrl } from '@/lib/http/public-base-url';

const MICROSOFT_CALLBACK_PATH = '/api/auth/callback/microsoft-entra-id';

/**
 * The Microsoft app this deployment signs people in through (#4869). On the
 * shared deployment it is Inflect's own, so a workspace consents to it rather
 * than registering one; on a deployment the customer runs, it is theirs. A
 * client ID is public — it is in every sign-in redirect — so an admin may see
 * it. The redirect URI is the one NextAuth builds its callbacks from
 * (`NEXTAUTH_URL`), else the deployment's public base URL.
 */
function signInApp(req: NextRequest): { clientId: string | null; redirectUri: string } {
    let base: string | null = null;
    try {
        if (env.NEXTAUTH_URL) base = new URL(env.NEXTAUTH_URL).origin;
    } catch {
        // A bare host (a Vercel preview) is not a URL; fall back below.
    }
    return {
        clientId: env.MICROSOFT_CLIENT_ID || null,
        redirectUri: `${base ?? publicBaseUrl(req)}${MICROSOFT_CALLBACK_PATH}`,
    };
}

/**
 * EI-1 — tenant Entra-ID provider configuration.
 * Gated by `admin.manage`; denials audit as AUTHZ_DENIED (Epic C.1).
 */

/** GET — current Entra provider config (no secrets stored, but masked for parity). */
export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const provider = await getEntraProvider(ctx);
        if (!provider) return jsonResponse({ config: null, signInApp: signInApp(req) });
        return jsonResponse({
            id: provider.id,
            isEnabled: provider.isEnabled,
            config: provider.configJson,
            signInApp: signInApp(req),
        });
    }),
);

/** POST — create/update the Entra provider from the wizard. */
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await req.json();
        const result = await upsertEntraProvider(ctx, body);
        return jsonResponse(result, { status: 201 });
    }),
);
