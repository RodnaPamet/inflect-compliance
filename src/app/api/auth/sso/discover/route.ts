import { NextRequest } from 'next/server';
import { z } from 'zod';
import { resolveSsoForTenant } from '@/app-layer/usecases/sso';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

const WorkspaceSchema = z.string().trim().toLowerCase().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/);

/**
 * GET /api/auth/sso/discover?workspace=<tenantSlug>
 *
 * The sign-in page's "Continue with single sign-on": which identity
 * providers a workspace offers, by name. Public, because the caller is not
 * signed in yet.
 *
 * Asked by WORKSPACE, never by email domain. A provider's `emailDomains` are
 * typed in by that workspace's admin and nobody verifies them, so any
 * workspace could list `bigcorp.com` and have bigcorp's people routed to an
 * identity provider it controls.
 *
 * An unknown workspace and one without SSO get the same answer — no
 * providers — and the route is in the edge's strict sign-in rate tier
 * (`/api/auth/sso/`), so it is no better than the trust centre at listing
 * which workspaces exist. Nothing from a provider's configuration leaves
 * here but its id, protocol and display name.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const parsed = WorkspaceSchema.safeParse(req.nextUrl.searchParams.get('workspace') ?? '');
    if (!parsed.success) {
        return jsonResponse({ providers: [] });
    }
    const { providers } = await resolveSsoForTenant(parsed.data);
    return jsonResponse({
        providers: providers.map((p) => ({
            id: p.id,
            protocol: p.type === 'SAML' ? 'saml' : 'oidc',
            name: p.name,
        })),
    });
});
