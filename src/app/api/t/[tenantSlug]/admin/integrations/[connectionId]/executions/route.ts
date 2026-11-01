import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getConnectionHeader, listExecutionsForConnection } from '@/app-layer/usecases/integrations';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; connectionId: string };

/**
 * GET /api/t/[tenantSlug]/admin/integrations/[connectionId]/executions
 *
 * P1 — the per-connection outcome view: this connection's check executions
 * (status / last run / summary), independent of whether a control is wired.
 *
 * Also answers WHICH connection (#4870): its name, provider, enabled state and
 * owner, so the page can name it before it has ever run, offer Sync only when
 * it is enabled, and stop downloading every connection to learn one provider.
 * A connection that does not exist is a 404, not an empty history.
 */
export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.manage', async (req: NextRequest, { params }, ctx) => {
        const { connectionId } = await params;
        const limit = Number(new URL(req.url).searchParams.get('limit')) || undefined;
        const connection = await getConnectionHeader(ctx, connectionId);
        const executions = await listExecutionsForConnection(ctx, connectionId, { limit });
        return jsonResponse({ connection, executions });
    }),
);
