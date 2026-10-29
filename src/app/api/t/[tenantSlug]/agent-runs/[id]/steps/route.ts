import { NextRequest } from 'next/server';

import { getRunStepFeed } from '@/app-layer/usecases/workflow-run-steps';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * GET — ONE BOUNDED PAGE of a run's ordered steps (#3472, plan point 08).
 *
 * The sibling `GET /agent-runs/:id` returns the run with EVERY step, which is
 * what the server-rendered timeline wants and what a canvas scrubber must not
 * ask for: "never stream unbounded history". This route pages instead.
 *
 * `?sinceSeq=` is an EXCLUSIVE cursor and `?take=` is clamped in the usecase —
 * a query string is not a bound. Because `WorkflowStep` is append-only and
 * ordered, paging by `seq` is exact rather than approximate: nothing can be
 * inserted behind the cursor, so a client misses no step and re-reads none.
 *
 * Authorization is the sibling routes': `admin.view` OR `admin.agent_registry_view`
 * (#3710), the gate the unpaged `GET /agent-runs/:id`, the live `/stream` and
 * the run detail page all apply (`mayReadAgentActivity`) — the same gate serving
 * the same rows to the same readers. It was the usecase's `assertCanRead`
 * alone, which handed every step's input and output to every member of the
 * workspace; spelled as the middleware, a denial writes `AUTHZ_DENIED`.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>(
        { keys: ['admin.view', 'admin.agent_registry_view'], mode: 'any' },
        async (req: NextRequest, routeArgs, ctx) => {
            const params = await routeArgs.params;
            const sp = req.nextUrl.searchParams;
            // Parsed, never trusted: a non-numeric `?take=lots` must not reach Prisma
            // as NaN, and `Number('')` is 0, which would clamp to the minimum rather
            // than fall back to the default.
            const num = (key: string): number | undefined => {
                const raw = sp.get(key);
                if (raw === null || raw.trim() === '') return undefined;
                const n = Number(raw);
                return Number.isFinite(n) ? n : undefined;
            };
            return jsonResponse(
                await getRunStepFeed(ctx, params.id, {
                    sinceSeq: num('sinceSeq'),
                    take: num('take'),
                }),
            );
        },
    ),
);
