/**
 * Start a legacy reconciliation run over one snapshot.
 *
 * ENQUEUES, and returns 202. A run walks a whole snapshot against the whole HR
 * roster and writes one resolution per account, so doing it on a request thread
 * would let an HTTP timeout decide how much of a population was reconciled —
 * and "every account in scope was reviewed" is the only claim the recertification
 * evidence makes that an auditor cares about.
 *
 * Nothing but HTTP happens here: the snapshot lookup, the audit row and the
 * enqueue all live in the usecase, because a route handler that reaches
 * `lib/prisma` itself is what `tests/guards/regression-scanner.test.ts` refuses.
 *
 * @module app/api/t/[tenantSlug]/admin/legacy-access/reconcile
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { API_KEY_CREATE_LIMIT } from '@/lib/security/rate-limit-middleware';
import { badRequest } from '@/lib/errors/types';
import { requestLegacyReconcile } from '@/app-layer/usecases/legacy-reconcile';

const Body = z.object({ snapshotId: z.string().min(1).max(64) });

export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const parsed = Body.safeParse(await req.json().catch(() => null));
        if (!parsed.success) throw badRequest('snapshotId is required');

        const { jobId } = await requestLegacyReconcile(ctx, parsed.data.snapshotId);
        return NextResponse.json({ status: 'queued', jobId }, { status: 202 });
    }),
    {
        // The same tight preset the pull uses. A run is idempotent in the sense
        // that matters — a second one ADDS rows keyed on `(executionId,
        // accountKey)` rather than overwriting — but it is not cheap, and two
        // runs over one snapshot produce two sets of resolutions for a reviewer
        // to tell apart.
        rateLimit: { config: API_KEY_CREATE_LIMIT, scope: 'legacy-reconcile' },
    }
);
