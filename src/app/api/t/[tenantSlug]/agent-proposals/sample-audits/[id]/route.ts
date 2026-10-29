import { NextRequest } from 'next/server';

import {
    recordSampleAuditOutcome,
    type RecordSampleAuditOutcomeInput,
} from '@/app-layer/usecases/agent-proposal-sample-audit';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { badRequest } from '@/lib/errors/types';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * POST /api/t/:tenantSlug/agent-proposals/sample-audits/:id — answer one
 * retrospective sample audit (OWASP ASI09).
 *
 * Body: `{ outcome: 'CONCURRED' | 'DISSENTED' | 'INDETERMINATE',
 *          dissentCodes?: string[] }`.
 *
 * Two layers. `admin.agent_registry` here, the gate its GET sibling and the
 * review-quality page take, as the middleware so a refusal writes
 * `AUTHZ_DENIED`; then the usecase's `assertCanWrite`, which ALSO refuses the
 * case that matters most here: the caller may not be the person who approved the
 * proposal under review. That refusal is a 403 with a hash-chained
 * `AUTHZ_DENIED` row — a self-review would drive the disagreement rate to zero
 * exactly in the tenants where rubber-stamping is worst, because there the
 * approver is the only person looking.
 *
 * The body is NOT parsed here beyond "is it an object": the usecase owns the
 * schema so every caller — this route, a script, a future SDK — is validated by
 * the same rules rather than by whichever boundary they happened to enter
 * through.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>(
        'admin.agent_registry',
        async (req: NextRequest, routeArgs, ctx) => {
            const params = await routeArgs.params;
            let body: unknown;
            try {
                body = await req.json();
            } catch {
                throw badRequest('A sample-audit outcome body is required');
            }
            const result = await recordSampleAuditOutcome(
                ctx,
                params.id,
                body as RecordSampleAuditOutcomeInput,
            );
            return jsonResponse(result);
        },
    ),
);
