import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { listTemplates, listReports, generateReport } from '@/app-layer/usecases/risk-report';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { requireFeature } from '@/lib/entitlements-server';
import { FEATURES } from '@/lib/entitlements';
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
        // ─── Plan check: rendered documents require TRIAL+ ───
        //
        // `reports/pdf/generate` has enforced this since #1697, but the risk-report
        // engine — Portfolio Summary, Deep Dive and BIA, in PDF and PPTX — never
        // did. The hub renders a locked, pointer-events-none PDF button for a FREE
        // tenant while this route, one click away on /risks/reports, minted
        // unlimited documents. A paywall enforced only in the client is not a
        // paywall.
        //
        // CSV is deliberately NOT gated: it is a data extract rather than a
        // rendered artefact, PDF_EXPORTS is the flag that exists, and the hub
        // does not gate CSV either (it renders it inside `{isIso && …}`, not
        // inside an UpgradeGate). Gating it here would invent an entitlement the
        // product does not sell.
        if (body.format === 'PDF' || body.format === 'PPTX') {
            await requireFeature(ctx.tenantId, FEATURES.PDF_EXPORTS);
        }
        const run = await generateReport(ctx, body.templateId, body.parameters ?? {}, body.format);
        return jsonResponse({ success: true, run });
    }),
);
