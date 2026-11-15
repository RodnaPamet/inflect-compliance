/**
 * The run a legacy connection's reconciliation queue opens: the connection's
 * name and its newest PASSED `legacy-mcp.reconcile` run (`null` when there is
 * none).
 *
 * `identity_reconciliation.view`, the queue's own key (#5695, owner decision
 * 2026-11-15: holding the view key is enough to open the queue). The page used
 * to ask the admin connection read `integrations/:id/executions/latest`, which
 * takes `admin.manage`, so a member who could read the queue could not learn
 * which run to read it for. That route stays as it is for the connection's
 * runs card; this one answers the queue's one question and nothing more —
 * legacy connections only, four fields of the run. See
 * `usecases/legacy-reconcile-run.ts`.
 *
 * The edge admits a view-key holder below the admin roles to a GET of exactly
 * this path and the queue beside it (`RECONCILIATION_VIEW_READ_PATHS` in
 * `src/lib/auth/guard.ts`); this handler's `requirePermission` is the authority.
 *
 * @module app/api/t/[tenantSlug]/admin/legacy-access/queue/latest-run
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { getReconciliationQueueRun } from '@/app-layer/usecases/legacy-reconcile-run';

const ConnectionId = z.string().min(1).max(64);

export const GET = withApiErrorHandling(
    requirePermission('identity_reconciliation.view', async (req: NextRequest, _routeArgs, ctx) => {
        const parsed = ConnectionId.safeParse(new URL(req.url).searchParams.get('connectionId'));
        if (!parsed.success) throw badRequest('connectionId is required');

        const { connection, execution } = await getReconciliationQueueRun(ctx, parsed.data);
        return NextResponse.json({ connection, execution });
    }),
);
