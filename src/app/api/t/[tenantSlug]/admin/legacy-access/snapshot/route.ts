/**
 * The latest legacy access snapshot of one connection, and the run over it.
 *
 * The connection page reads this to show when the accounts were last read,
 * whether that read was complete, how many accounts it stored, whether they have
 * been matched to people, and the snapshot id that "Match to people" sends to
 * the reconcile route. No other read returns a snapshot: the pull and reconcile
 * routes answer 202 with a job id.
 *
 * `admin.manage`, as the two actions it drives are, and as the mapping route
 * beside it is: the counts describe a customer's legacy access table.
 *
 * Nothing but HTTP happens here; the read lives in the usecase.
 *
 * @module app/api/t/[tenantSlug]/admin/legacy-access/snapshot
 */

import { NextRequest, NextResponse } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { getLegacySnapshotStanding } from '@/app-layer/usecases/legacy-access-standing';

export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const connectionId = new URL(req.url).searchParams.get('connectionId');
        if (!connectionId || connectionId.length > 64) throw badRequest('connectionId is required');

        return NextResponse.json(await getLegacySnapshotStanding(ctx, connectionId));
    })
);
