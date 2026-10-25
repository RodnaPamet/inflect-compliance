import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listFrameworks, listFrameworksInUse } from '@/app-layer/usecases/framework';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    // `?inUse=true` narrows the catalogue to the frameworks this workspace
    // uses (at least one control mapped to one of its requirements) — the
    // audit-cycle form's picker, which may offer nothing else (#4129).
    const inUse = new URL(req.url).searchParams.get('inUse') === 'true';
    const frameworks = inUse ? await listFrameworksInUse(ctx) : await listFrameworks(ctx);
    return jsonResponse(frameworks);
});
