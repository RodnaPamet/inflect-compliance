import { NextRequest } from 'next/server';
import { dismissSession } from '@/app-layer/usecases/risk-suggestions';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * Dismissing a session takes `risks.create`, the key its sibling generate and
 * apply routes take (owner decision, 2026-11-14, #5303 item 11). #4327 left
 * this route ungated because a dismissal creates nothing; that decision was
 * reversed. A dismissal is the other answer to the question apply answers —
 * it records the human's Art 14 outcome on the session and closes it — so the
 * person who may not apply suggestions may not decide them the other way
 * either, and a refusal writes the hash-chained AUTHZ_DENIED row a usecase
 * throw does not. `dismissSession` still asserts the AI feature gate, the
 * coarse write tier and that the session is undecided (#5596).
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; sessionId: string }>(
        'risks.create',
        async (_req: NextRequest, { params }, ctx) => {
            const result = await dismissSession(ctx, params.sessionId);
            return jsonResponse(result);
        },
    ),
);
