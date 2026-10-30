import { NextRequest } from 'next/server';
import { getLegacyCtx } from '@/app-layer/context';
import { getFinding, updateFinding } from '@/app-layer/usecases/finding';
import { withValidatedBody } from '@/lib/validation/route';
import { UpdateFindingSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertPermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

// The flat twin of `/api/t/{slug}/findings/{id}`, asking the same keys of the
// legacy context (#4535) — see `../route.ts`.
const meta = (req: NextRequest) => ({ method: req.method, path: req.nextUrl.pathname });

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ id: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getLegacyCtx(req);
    await assertPermission(ctx, 'findings.view', meta(req));
    const finding = await getFinding(ctx, params.id);
    return jsonResponse(finding);
});

export const PUT = withApiErrorHandling(withValidatedBody(UpdateFindingSchema, async (req, { params: paramsPromise }: { params: Promise<{ id: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getLegacyCtx(req);
    await assertPermission(ctx, 'findings.edit', meta(req));
    const finding = await updateFinding(ctx, params.id, body);
    return jsonResponse({ success: true, finding });
}));
