import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { generateReadinessReport } from '@/app-layer/usecases/framework/coverage';
import { resolveInstalledFrameworkKey } from '@/app-layer/usecases/soa';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

// Report generation is long-running by nature, and the platform default
// cuts it off well before these finish — a run killed mid-flight leaves a
// ReportRun stranded in GENERATING with no worker to settle it.
// generateReadinessReport walks the requirement -> link -> control graph;
// on a large framework that is the slowest read in the product.
export const maxDuration = 60;

/**
 * PR-G — per-framework Coverage/Readiness report for the Reports catalog. The
 * framework selector re-fetches this when the user switches frameworks.
 * `?framework=<key>` scopes the report; absent → the resolved installed default.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const requested = new URL(req.url).searchParams.get('framework');
        const frameworkKey =
            requested && requested.length > 0
                ? requested
                : await resolveInstalledFrameworkKey(ctx);
        const report = await generateReadinessReport(ctx, frameworkKey);
        return jsonResponse(report);
    },
);
