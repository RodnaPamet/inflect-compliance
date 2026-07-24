import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { listTemplates, listReports, generateReport } from '@/app-layer/usecases/risk-report';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/** RQ-10 — reports: GET templates + recent runs, POST to generate. */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const [templates, reports] = await Promise.all([listTemplates(ctx), listReports(ctx, { limit: 50 })]);
        return jsonResponse({ templates, reports });
    },
);

const GenSchema = z.object({
    templateId: z.string().min(1),
    format: z.enum(['PDF', 'CSV', 'PPTX']),
    parameters: z.object({ confidenceLevel: z.number().optional(), riskId: z.string().optional() }).optional(),
});

// Report generation is an export action — gate on reports.export (READER is
// denied; EDITOR/AUDITOR/ADMIN/OWNER allowed). The GET (list templates + runs)
// stays open to any tenant member.
export const POST = withApiErrorHandling(
    requirePermission('reports.export', async (req: NextRequest, _routeArgs, ctx) => {
        const body = GenSchema.parse(await req.json());
        const run = await generateReport(ctx, body.templateId, body.parameters ?? {}, body.format);
        return jsonResponse({ success: true, run });
    }),
);
