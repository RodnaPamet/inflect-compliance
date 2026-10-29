import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { assertCanAdmin } from '@/app-layer/policies/common';
import { processOutbox } from '@/app-layer/notifications/processOutbox';
import { runDailyEvidenceExpiryNotifications } from '@/app-layer/jobs/dailyEvidenceExpiry';
import { jsonResponse } from '@/lib/api-response';

const RunJobSchema = z.object({
    jobType: z.enum(['processOutbox', 'dailySweep']),
});

/**
 * Run one of the page's two notification jobs now, for THIS workspace.
 *
 * Gated `admin.manage` at the route (#4469), so a refusal writes an
 * AUTHZ_DENIED row. It compared `ctx.role` to OWNER/ADMIN by hand, which is
 * the predicate `assertCanAdmin` reads (`canAdmin` is the OWNER/ADMIN rung of
 * the effective role), so that check moved to `assertCanAdmin` with no change
 * in who passes it.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        assertCanAdmin(ctx);

        const { jobType } = RunJobSchema.parse(await req.json());

        if (jobType === 'processOutbox') {
            // Scoped to THIS tenant. It used to run globally — the message below
            // even said "(Global)" — so an ADMIN of any tenant could drain every
            // other tenant's outbox from their own settings page and see the
            // combined total. `dailySweep` immediately below is scoped the same
            // way, outbox flush included.
            const stats = await processOutbox({ limit: 100, tenantId: ctx.tenantId });
            return jsonResponse({ success: true, jobType, stats, message: 'Outbox processed successfully' });
        }

        const stats = await runDailyEvidenceExpiryNotifications({ tenantId: ctx.tenantId });
        return jsonResponse({ success: true, jobType, stats, message: 'Daily sweep executed successfully' });
    }),
);
