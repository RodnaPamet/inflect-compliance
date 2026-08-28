import { z } from 'zod';
import { updateSchedule, deleteSchedule } from '@/app-layer/usecases/risk-report';
import { parseJsonBody } from '@/lib/validation/route';
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

type ScheduleParams = { tenantSlug: string; scheduleId: string };

/**
 * PATCH and DELETE both gate on `risks.edit`, mirroring `assertCanWrite` in
 * `updateSchedule` / `deleteSchedule`. The gate is what makes a refusal
 * auditable: a usecase assert throws 403 and records nothing, while
 * `AUTHZ_DENIED` is written by `requirePermission` and by nothing else. The
 * asserts stay — they protect non-HTTP callers.
 *
 * `risks.edit` is the ROUTE gate, not the whole authorization story for this
 * verb. A schedule is a standing outbound feed, and editing `recipients` can
 * aim one off-tenant; that elevation is `reports.schedule_external`, enforced
 * inside `updateSchedule` where every caller meets it, HTTP or not. Adding
 * the route gate does not move or weaken that check.
 *
 * PATCH reads its body with `parseJsonBody` rather than composing
 * `withValidatedBody`, whose handler takes the parsed body in the third
 * argument `requirePermission` uses for `ctx`.
 */
export const PATCH = withApiErrorHandling(
    requirePermission<ScheduleParams>('risks.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, PatchSchema);
        await updateSchedule(ctx, params.scheduleId, body);
        return jsonResponse({ success: true });
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<ScheduleParams>('risks.edit', async (_req, { params }, ctx) => {
        await deleteSchedule(ctx, params.scheduleId);
        return jsonResponse({ success: true });
    }),
);
