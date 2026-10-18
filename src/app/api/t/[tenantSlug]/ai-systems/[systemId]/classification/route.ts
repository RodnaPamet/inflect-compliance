import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { classifyAiSystemEntry } from '@/app-layer/usecases/ai-system';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/:tenantSlug/ai-systems/:systemId/classification — classify a
 * PROVISIONAL (UNCLASSIFIED) entry by answering the EU AI Act questionnaire in
 * full (#3669). The usecase runs the deterministic classifier and links the
 * tier's obligations; the client cannot state a tier. Write-gated by the
 * usecase (`assertCanWrite`), the same gate as registering an entry, and
 * tenant-scoped by RLS. An entry that is already classified is a 409.
 */
export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string; systemId: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx({ tenantSlug: params.tenantSlug }, req);
    const result = await classifyAiSystemEntry(ctx, params.systemId, await req.json());
    return jsonResponse(result);
});
