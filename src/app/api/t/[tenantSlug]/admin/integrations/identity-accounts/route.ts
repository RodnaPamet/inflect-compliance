import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listConnectedAccounts } from '@/app-layer/usecases/integrations';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

/**
 * GET /api/t/[tenantSlug]/admin/integrations/identity-accounts
 *
 * P1 — the synced-identity roster (Okta / Google Workspace / Entra ID /
 * Active Directory). Browsable so a directory sync is visible and a
 * CONNECTED_APP access review can be pre-checked instead of throwing on empty.
 *
 * `?q=` searches email / display name / external user id, `?provider=` scopes
 * to one directory kind; both are applied in SQL by the usecase. They exist
 * because the response is capped at IDENTITY_ROSTER_PAGE_SIZE with no cursor,
 * so without them an account sorting past the cap was unreachable from the
 * admin page — the page where an operator marks an account never-offboard.
 *
 * NO PARAMS MEANS EXACTLY THE OLD RESPONSE, and that is a contract rather than
 * an accident: the access-reviews directory gate reads this route unfiltered
 * and treats a short page as "this is the whole roster". A filtered page is a
 * count of MATCHES and carries no such meaning. The body shape is likewise
 * unchanged — still `{ accounts: [...] }` — because that gate consumes it
 * through a reader that fails open on anything it does not recognise.
 */
export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const params = new URL(req.url).searchParams;
        const provider = params.get('provider') ?? undefined;
        const q = params.get('q') ?? undefined;
        const accounts = await listConnectedAccounts(ctx, { provider, q });
        return jsonResponse({ accounts });
    }),
);
