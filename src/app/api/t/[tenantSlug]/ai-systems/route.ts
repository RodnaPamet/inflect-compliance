import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { listAiSystems, createAiSystem } from '@/app-layer/usecases/ai-system';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * GET /api/t/:tenantSlug/ai-systems — the AI-System Registry list. Read-gated by
 * the usecase (`assertCanRead`), tenant-scoped by RLS. Optional `?riskTier=` /
 * `?status=` filters.
 */
export const GET = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    // Both stay raw strings — the repository validates them against the real
    // enum and 400s on an unknown member. The `as AiRiskTier` cast that used
    // to live here silenced the compiler and left Prisma to 500 on a
    // comma-joined multi-select or a tier from another entity's enum.
    const riskTier = req.nextUrl.searchParams.get('riskTier') ?? undefined;
    const status = req.nextUrl.searchParams.get('status') ?? undefined;
    const systems = await listAiSystems(ctx, { riskTier, status });
    return jsonResponse(systems);
});

/**
 * POST /api/t/:tenantSlug/ai-systems — register an AI system. The usecase runs
 * the deterministic EU AI Act classifier and links the tier's obligations; the
 * client cannot set the tier.
 */
export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const body = await req.json();
    const result = await createAiSystem(ctx, body);
    return jsonResponse(result, { status: 201 });
});
