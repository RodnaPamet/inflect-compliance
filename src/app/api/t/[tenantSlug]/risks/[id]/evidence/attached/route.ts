import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getRiskEvidenceTab, linkRiskEvidence } from '@/app-layer/usecases/risk';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { LinkRiskEvidenceSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

// GET — attached-evidence payload `{ links, evidence }` (direct evidence
// via Evidence.riskId), rendered by the shared <EvidenceSubTable>.
// The inherited-from-controls evidence lives at the sibling /evidence route.
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const data = await getRiskEvidenceTab(ctx, params.id);
    return jsonResponse(data);
});

// POST — attach a URL as evidence. File uploads go through /evidence/uploads.
// `risks.edit`, the key its DELETE twin takes.
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>('risks.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, LinkRiskEvidenceSchema);
        const evidence = await linkRiskEvidence(ctx, params.id, body);
        return jsonResponse(evidence, { status: 201 });
    }),
);
