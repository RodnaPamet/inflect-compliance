import { NextRequest } from 'next/server';
import { generateRiskSuggestions } from '@/app-layer/usecases/risk-suggestions';
import { withApiErrorHandling } from '@/lib/errors/api';
import { parseJsonBody } from '@/lib/validation/route';
import { RiskAssessmentInputSchema } from '@/app-layer/ai/risk-assessment/schemas';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * Generating suggestions is the first step of creating risks with AI Assist:
 * a session exists only to be applied, which creates them. So it takes
 * `risks.create`, like the apply route (#4327). A caller who could generate
 * but not apply would spend the tenant's AI quota on suggestions nobody can
 * use. `generateRiskSuggestions` still asserts the AI feature gate and the
 * coarse write tier.
 *
 * The body is parsed inline rather than through `withValidatedBody`: that
 * wrapper and `requirePermission` both claim the handler's third argument.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'risks.create',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = await parseJsonBody(req, RiskAssessmentInputSchema);
            const input = { frameworks: body.frameworks ?? [], assetIds: body.assetIds ?? [], context: body.context };
            const result = await generateRiskSuggestions(ctx, input);
            return jsonResponse(result, { status: 201 });
        },
    ),
);
