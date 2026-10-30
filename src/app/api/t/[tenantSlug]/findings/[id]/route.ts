import { NextRequest } from 'next/server';
import { getFinding, updateFinding } from '@/app-layer/usecases/finding';
import { parseJsonBody } from '@/lib/validation/route';
import { UpdateFindingSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/** One finding (#4535): `findings.view` to read it, `findings.edit` to change it. */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>('findings.view', async (_req: NextRequest, { params }, ctx) => {
        const { id } = await params;
        const finding = await getFinding(ctx, id);
        return jsonResponse(finding);
    }),
);

export const PUT = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>('findings.edit', async (req: NextRequest, { params }, ctx) => {
        const { id } = await params;
        const body = await parseJsonBody(req, UpdateFindingSchema);
        const finding = await updateFinding(ctx, id, body);
        return jsonResponse({ success: true, finding });
    }),
);
