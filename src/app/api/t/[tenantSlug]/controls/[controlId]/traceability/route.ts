import { getControlTraceability } from '@/app-layer/usecases/traceability';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * Reading this panel takes the ANCHOR entity's view key — the key its own
 * detail read takes — so a refusal is a 403 with an `AUTHZ_DENIED` row (#5376,
 * owner decision 2026-11-12). The usecase refuses the same anchor again and
 * omits each linked kind the caller may not view.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; controlId: string }>('controls.view', async (_req, { params }, ctx) =>
        jsonResponse(await getControlTraceability(ctx, params.controlId)),
    ),
);
