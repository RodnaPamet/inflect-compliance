import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getSoA } from '@/app-layer/usecases/soa';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

// Report generation is long-running by nature, and the platform default
// cuts it off well before these finish — a run killed mid-flight leaves a
// ReportRun stranded in GENERATING with no worker to settle it.
// getSoA assembles the full Statement of Applicability.
export const maxDuration = 60;

const SoAQuerySchema = z.object({
    // Optional: when omitted, getSoA resolves the tenant's installed
    // framework (was hard-defaulted to ISO27001, which showed ISO's 93
    // requirements even for tenants on a different pack).
    framework: z.string().optional(),
    includeEvidence: z.enum(['true', 'false']).default('false'),
    includeTasks: z.enum(['true', 'false']).default('false'),
    includeTests: z.enum(['true', 'false']).default('false'),
}).strip();

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const query = SoAQuerySchema.parse(sp);

    const report = await getSoA(ctx, {
        framework: query.framework,
        includeEvidence: query.includeEvidence === 'true',
        includeTasks: query.includeTasks === 'true',
        includeTests: query.includeTests === 'true',
    });

    return jsonResponse(report);
});
