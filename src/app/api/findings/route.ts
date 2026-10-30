import { NextRequest } from 'next/server';
import { getLegacyCtx } from '@/app-layer/context';
import { listFindings, createFinding } from '@/app-layer/usecases/finding';
import { withValidatedBody } from '@/lib/validation/route';
import { CreateFindingSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertPermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

// The flat twin of `/api/t/{slug}/findings`. `requirePermission` resolves the
// tenant from the URL's slug, which this path does not carry, so the same key
// is asked of the legacy context directly — same refusal, same `AUTHZ_DENIED`
// row (#4535). Without it this route would read and write findings for a
// custom role the tenant route refuses.
const meta = (req: NextRequest) => ({ method: req.method, path: req.nextUrl.pathname });

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getLegacyCtx(req);
    await assertPermission(ctx, 'findings.view', meta(req));
    const findings = await listFindings(ctx);
    return jsonResponse(findings);
});

export const POST = withApiErrorHandling(withValidatedBody(CreateFindingSchema, async (req, _ctx, body) => {
    const ctx = await getLegacyCtx(req);
    await assertPermission(ctx, 'findings.create', meta(req));
    const finding = await createFinding(ctx, body);
    return jsonResponse(finding, { status: 201 });
}));
