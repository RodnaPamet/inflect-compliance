/**
 * Start a legacy access pull.
 *
 * ENQUEUES, and returns 202. The pull dials a customer-hosted server, pages
 * until it has a whole access table, and writes thousands of rows — doing that
 * on a request thread would let an HTTP timeout decide whether a snapshot is
 * complete, which is the one question the snapshot exists to answer. So the
 * route's entire job is to authorise, validate and hand off.
 *
 * @module app/api/t/[tenantSlug]/admin/legacy-access/pull
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { enqueue } from '@/app-layer/jobs/queue';
import { API_KEY_CREATE_LIMIT } from '@/lib/security/rate-limit-middleware';
import { badRequest } from '@/lib/errors/types';
import { logEvent } from '@/app-layer/events/audit';
import { prisma } from '@/lib/prisma';

const Body = z.object({ connectionId: z.string().min(1).max(64) });

export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const parsed = Body.safeParse(await req.json().catch(() => null));
        if (!parsed.success) throw badRequest('connectionId is required');

        // The connection is confirmed to belong to THIS tenant before a job is
        // queued. The job re-reads it under tenant context and would find
        // nothing, so this is not the security boundary — it is the difference
        // between a 404 the administrator can act on and a queued job that
        // quietly records NOT_APPLICABLE somewhere they are not looking.
        const conn = await prisma.integrationConnection.findFirst({
            where: { id: parsed.data.connectionId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!conn) return NextResponse.json({ error: 'not_found' }, { status: 404 });

        const job = await enqueue('legacy-access-pull', {
            tenantId: ctx.tenantId,
            connectionId: conn.id,
        });

        await logEvent(prisma, ctx, {
            action: 'LEGACY_ACCESS_PULL_REQUESTED',
            entityType: 'IntegrationConnection',
            entityId: conn.id,
            details: `Legacy access pull requested by user ${ctx.userId}`,
            metadata: { jobId: job.id },
        });

        return NextResponse.json({ status: 'queued', jobId: job.id }, { status: 202 });
    }),
    {
        // A pull reads a customer's whole access table. Tight on purpose: the
        // per-connection lock already makes a concurrent second pull a no-op, so
        // a high limit would buy nothing but load on the customer's server.
        rateLimit: { config: API_KEY_CREATE_LIMIT, scope: 'legacy-access-pull' },
    }
);
