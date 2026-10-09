/**
 * The legacy reconciliation queue for one run.
 *
 * `identity_reconciliation.view`, not `admin.manage`: an auditor checking that
 * the queue is being WORKED needs exactly this read, and a reviewer who may not
 * decide may still need to see what is outstanding. The mapping route beside
 * this one is `admin.manage` because its response enumerates a customer's legacy
 * SCHEMA; this one returns the accounts and the engine's evidence for them,
 * which is the surface a reviewer is entitled to.
 *
 * @module app/api/t/[tenantSlug]/admin/legacy-access/queue
 */

import { NextRequest, NextResponse } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { listReconciliationQueue } from '@/app-layer/usecases/legacy-reviewer-actions';

export const GET = withApiErrorHandling(
    requirePermission('identity_reconciliation.view', async (req: NextRequest, _routeArgs, ctx) => {
        const q = new URL(req.url).searchParams;
        const executionId = q.get('executionId');
        const connectionId = q.get('connectionId');
        // BOTH required. The queue is "one run, on one connection" — an
        // executionId alone cannot say which connection's aliases suppress a
        // row, and defaulting either would silently widen the answer.
        if (!executionId) throw badRequest('executionId is required');
        if (!connectionId) throw badRequest('connectionId is required');

        const rows = await listReconciliationQueue(ctx, { executionId, connectionId });
        return NextResponse.json({ rows });
    })
);
