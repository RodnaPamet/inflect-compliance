import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { getRunStepFeed } from '@/app-layer/usecases/workflow-run-steps';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

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
 * Authorization is the sibling route's, which is the usecase's `assertCanRead`
 * reached through `getTenantCtx` — the same gate serving the same rows to the
 * same readers. A narrower key here would be a gate on the PAGED view of data
 * the unpaged view already hands out.
 */
export const GET = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
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
});
