import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import {
    getTenantSsoConfig,
    upsertTenantSsoConfig,
    deleteTenantSsoConfig,
    toggleTenantSso,
    setTenantSsoEnforced,
} from '@/app-layer/usecases/sso';
import { UpsertSsoConfigInput, maskSsoSecrets } from '@/app-layer/schemas/sso-config.schemas';
import type { TenantIdentityProvider } from '@prisma/client';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * Tenant-scoped SSO configuration routes.
 *
 * Gated by `admin.manage` (Epic D.3). Denials surface as 403 with the
 * generic message and an `AUTHZ_DENIED` audit entry — same shape as
 * every other privileged route.
 */

/**
 * GET /api/t/[tenantSlug]/sso — list SSO providers
 */
export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        const providers = await getTenantSsoConfig(ctx);
        return jsonResponse(providers.map(withSecretsMasked));
    }),
);

/**
 * POST /api/t/[tenantSlug]/sso — create or update SSO provider
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await req.json();
        const parsed = UpsertSsoConfigInput.parse(body);
        const provider = await upsertTenantSsoConfig(ctx, parsed);
        // Masked here too: the saved row carries the secret in plain text.
        return jsonResponse(withSecretsMasked(provider), { status: body.id ? 200 : 201 });
    }),
);

/**
 * PATCH /api/t/[tenantSlug]/sso — toggle enable/enforce
 * Body: { id: string, action: 'enable' | 'disable' | 'enforce' | 'unenforce' }
 */
export const PATCH = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const { id, action } = (await req.json()) as { id: string; action: string };

        let result;
        switch (action) {
            case 'enable':
                result = await toggleTenantSso(ctx, id, true);
                break;
            case 'disable':
                result = await toggleTenantSso(ctx, id, false);
                break;
            case 'enforce':
                result = await setTenantSsoEnforced(ctx, id, true);
                break;
            case 'unenforce':
                result = await setTenantSsoEnforced(ctx, id, false);
                break;
            default:
                return jsonResponse({ error: 'Invalid action' }, { status: 400 });
        }
        return jsonResponse(withSecretsMasked(result));
    }),
);

/**
 * DELETE /api/t/[tenantSlug]/sso — delete SSO provider
 * Body: { id: string }
 */
export const DELETE = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const { id } = (await req.json()) as { id: string };
        await deleteTenantSsoConfig(ctx, id);
        return jsonResponse({ ok: true });
    }),
);

// ─── Helpers ─────────────────────────────────────────────────────────

/** A provider as the browser may see it: no stored secret leaves this route. */
function withSecretsMasked(p: TenantIdentityProvider) {
    return { ...p, configJson: maskSsoSecrets(p.configJson as Record<string, unknown>) };
}
