import { NextRequest } from 'next/server';
import { applySession } from '@/app-layer/usecases/risk-suggestions';
import { withApiErrorHandling } from '@/lib/errors/api';
import { parseJsonBody } from '@/lib/validation/route';
import { ApplySessionSchema } from '@/app-layer/ai/risk-assessment/schemas';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * Applying a session creates real risks, one per accepted suggestion, so it
 * takes `risks.create` — the key the Risk button (`POST /risks`) and the
 * import (`POST /risks/bulk/import`) take (#4327). `applySession` still
 * asserts the AI feature gate and the coarse write tier; this gate is the one
 * a custom role can switch off, and its refusal writes an AUTHZ_DENIED row,
 * which a usecase throw does not.
 *
 * The body is parsed inline rather than through `withValidatedBody`: that
 * wrapper and `requirePermission` both claim the handler's third argument.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; sessionId: string }>(
        'risks.create',
        async (req: NextRequest, { params }, ctx) => {
            const body = await parseJsonBody(req, ApplySessionSchema);
            const result = await applySession(ctx, params.sessionId, body);
            return jsonResponse(result);
        },
    ),
);
