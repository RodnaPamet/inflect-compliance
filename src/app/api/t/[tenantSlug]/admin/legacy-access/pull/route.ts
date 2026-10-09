/**
 * Start a legacy access pull.
 *
 * ENQUEUES, and returns 202. The pull dials a customer-hosted server, pages until
 * it has a whole access table, and writes thousands of rows — doing that on a
 * request thread would let an HTTP timeout decide whether a snapshot is complete,
 * which is the one question the snapshot exists to answer.
 *
 * Nothing but HTTP happens here: the connection lookup, the audit row and the
 * enqueue all live in the usecase, because a route handler that reaches
 * `lib/prisma` itself is what `tests/guards/regression-scanner.test.ts` refuses.
 *
 * @module app/api/t/[tenantSlug]/admin/legacy-access/pull
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { API_KEY_CREATE_LIMIT } from '@/lib/security/rate-limit-middleware';
import { badRequest } from '@/lib/errors/types';
import { requestLegacyAccessPull } from '@/app-layer/usecases/legacy-access-pull';

const Body = z.object({ connectionId: z.string().min(1).max(64) });

export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const parsed = Body.safeParse(await req.json().catch(() => null));
        if (!parsed.success) throw badRequest('connectionId is required');

        const { jobId } = await requestLegacyAccessPull(ctx, parsed.data.connectionId);
        return NextResponse.json({ status: 'queued', jobId }, { status: 202 });
    }),
    {
        // A pull reads a customer's whole access table. Tight on purpose: the
        // per-connection lock already makes a concurrent second pull a no-op, so a
        // high limit would buy nothing but load on the customer's server.
        rateLimit: { config: API_KEY_CREATE_LIMIT, scope: 'legacy-access-pull' },
    }
);
