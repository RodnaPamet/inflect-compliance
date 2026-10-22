import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { readAdHocQuestionResult } from '@/app-layer/usecases/ad-hoc-question-result';

/**
 * WHAT CAME BACK FROM A QUESTION (#3869).
 *
 * `controls.view` for the same reason the POST beside it takes that key, and
 * the route gate is deliberately NOT the whole gate: `readAdHocQuestionResult`
 * narrows further, to the asker's own directly-started question runs unless the
 * caller holds the agent-inventory key.
 *
 * That split is on purpose. A route-level key cannot express "your own row" —
 * it decides whether a caller may reach the handler, not which rows they may
 * see — so the row-level rule lives in the usecase, in the WHERE clause, where
 * a row the caller may not see is never fetched at all.
 *
 * The usecase answers "no such run" and "not yours" with ONE refusal, so a
 * caller cannot enumerate run ids by comparing the two.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; runId: string }>(
        'controls.view',
        async (_req, routeArgs, ctx) => {
            // Awaited: Next 15+ types route params as a promise, and every
            // handler in this repo awaits them itself.
            const { runId } = await routeArgs.params;
            const result = await readAdHocQuestionResult(ctx, runId);
            return jsonResponse(result);
        },
    ),
);
