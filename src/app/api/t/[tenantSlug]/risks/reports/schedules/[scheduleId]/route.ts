import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { updateSchedule, deleteSchedule } from '@/app-layer/usecases/risk-report';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/** RQ-10 — single schedule: PATCH (pause/resume/edit), DELETE. */
const PatchSchema = z.object({
    isActive: z.boolean().optional(),
    cadence: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY']).optional(),
    // `.max()` mirrors MAX_SCHEDULE_RECIPIENTS in the usecase. The usecase is
    // the authority (the delivery job and any future caller bypass Zod), but
    // rejecting an over-long list at the boundary is cheaper and gives a
    // clearer error than a usecase throw.
    recipients: z.array(z.string().email()).max(20).optional(),
    // Editable since the edit form began surfacing them — the schedule stored
    // both from creation and the UI could neither show nor change either, so a
    // deep-dive schedule's scope was write-once and invisible.
    format: z.enum(['PDF', 'CSV', 'PPTX']).optional(),
    parameters: z.object({ confidenceLevel: z.number().optional(), riskId: z.string().optional() }).optional(),
});

export const PATCH = withApiErrorHandling(
    withValidatedBody(PatchSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; scheduleId: string }> }, body) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await updateSchedule(ctx, params.scheduleId, body);
        return jsonResponse({ success: true });
    }),
);

type DeleteParams = { tenantSlug: string; scheduleId: string };

export const DELETE = withApiErrorHandling(
    requirePermission<DeleteParams>('risks.edit', async (_req, { params }, ctx) => {
        await deleteSchedule(ctx, params.scheduleId);
        return jsonResponse({ success: true });
    }),
);
