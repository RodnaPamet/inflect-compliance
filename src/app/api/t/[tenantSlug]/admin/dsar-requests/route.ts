import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import {
    listDsarRequests,
    recordDsarRequest,
    transitionDsarRequest,
} from '@/app-layer/usecases/dsar-register';
import { DSAR_REGISTER_CAP } from '@/lib/dsar';

/**
 * DSAR register — manual-fulfilment queue.
 *
 * Read is gated on `admin.compliance_dsar_view` (which AUDITOR holds — reading
 * the rights-request log is the auditor's job); every mutation is gated on
 * `admin.compliance_dsar_manage`, which AUDITOR does not hold.
 *
 * Nothing here exports or erases anything. See `usecases/dsar-register.ts`.
 */

const DSAR_STATUSES = ['RECEIVED', 'VERIFIED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'CANCELED'] as const;

const RecordSchema = z.object({
    userId: z.string().min(1),
    type: z.enum(['EXPORT', 'ERASURE']),
    notes: z.string().max(4000).nullish(),
});

const TransitionSchema = z.object({
    id: z.string().min(1),
    to: z.enum(DSAR_STATUSES),
    reason: z.string().max(200).nullish(),
    notes: z.string().max(4000).nullish(),
});

export const GET = withApiErrorHandling(
    requirePermission('admin.compliance_dsar_view', async (req: NextRequest, _routeArgs, ctx) => {
        const statusParam = req.nextUrl.searchParams.get('status');
        const status = DSAR_STATUSES.find((s) => s === statusParam);
        const rows = await listDsarRequests(ctx, status ? { status } : {});
        return jsonResponse({ requests: rows.slice(0, DSAR_REGISTER_CAP), truncated: rows.length > DSAR_REGISTER_CAP });
    }),
);

export const POST = withApiErrorHandling(
    requirePermission('admin.compliance_dsar_manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = RecordSchema.parse(await req.json());
        const created = await recordDsarRequest(ctx, {
            userId: body.userId,
            type: body.type,
            notes: body.notes ?? undefined,
        });
        return jsonResponse(created, { status: 201 });
    }),
);

export const PATCH = withApiErrorHandling(
    requirePermission('admin.compliance_dsar_manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = TransitionSchema.parse(await req.json());
        const updated = await transitionDsarRequest(ctx, body.id, {
            to: body.to,
            reason: body.reason ?? undefined,
            notes: body.notes ?? undefined,
        });
        return jsonResponse(updated);
    }),
);
