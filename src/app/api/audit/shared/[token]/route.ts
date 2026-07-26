import { NextRequest, NextResponse } from 'next/server';
import { getPackByShareToken, addShareComment } from '@/app-layer/usecases/audit-readiness';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';
import { enforceRateLimit, getClientIp, isRateLimitBypassed } from '@/lib/security/rate-limit-middleware';
import { z } from 'zod';

// PUBLIC unauthenticated GET — the token IS the auth, and it does an
// unbounded pack+items read per request. `withApiErrorHandling` only
// rate-limits mutation methods, so this read is unthrottled by default.
// Throttle it explicitly, keyed on (IP, token): the token in the scope
// namespace isolates each share while the IP bounds a single scraper.
function applyShareReadRateLimit(req: NextRequest, token: string): NextResponse | null {
    if (isRateLimitBypassed()) return null;
    const enforcement = enforceRateLimit(req, {
        scope: `audit-share-read:${token}`,
        config: API_READ_LIMIT,
        ip: getClientIp(req),
    });
    return enforcement.response ?? null;
}

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ token: string }> }) => {
    const params = await paramsPromise;
    const limitResponse = applyShareReadRateLimit(req, params.token);
    if (limitResponse) return limitResponse;

    const data = await getPackByShareToken(params.token);
    return jsonResponse(data);
});

// Return channel — the token-bearing external auditor sends a message
// back to the tenant (comment / request more evidence / raise a
// finding/question). PUBLIC endpoint: the token IS the auth. The default
// mutation rate-limit from withApiErrorHandling guards abuse; the usecase
// re-validates the token (not revoked, not expired) before any write.
const ShareCommentSchema = z.object({
    kind: z.enum(['COMMENT', 'EVIDENCE_REQUEST', 'FINDING', 'QUESTION']),
    body: z.string().min(1).max(10000),
    authorLabel: z.string().max(200).optional(),
    auditPackItemId: z.string().min(1).optional(),
}).strip();

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ token: string }> }) => {
    const params = await paramsPromise;
    const input = ShareCommentSchema.parse(await req.json());
    const created = await addShareComment(params.token, input);
    return jsonResponse(created, { status: 201 });
});
