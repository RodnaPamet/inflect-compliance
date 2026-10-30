import { z } from 'zod';
import { updateVulnerabilityStatus, VULN_STATUSES } from '@/app-layer/usecases/vulnerability';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string };

const UpdateSchema = z.object({
    status: z.enum(VULN_STATUSES).optional(),
    note: z.string().max(20_000).optional().nullable(),
    ownerUserId: z.string().max(200).optional().nullable(),
    remediationDueAt: z.string().max(40).optional().nullable(),
});

/**
 * Triage edits a vulnerability, which is an asset-domain record: `assets.edit`,
 * the key `updateVulnerabilityStatus` asserts (`assertCanEditAsset`) (#4465).
 */
export const PATCH = withApiErrorHandling(
    requirePermission<Params>('assets.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, UpdateSchema);
        const updated = await updateVulnerabilityStatus(ctx, params.id, body);
        return jsonResponse(updated);
    }),
);
