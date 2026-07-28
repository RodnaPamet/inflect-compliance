/**
 * GET /api/vendor-assessment/[assessmentId]?t=<rawToken>
 *
 * Public, token-gated. Loads the assessment + template tree for an
 * external respondent. No NextAuth session is required — middleware
 * skips JWT verification for this path (see PUBLIC_PATH_PREFIXES in
 * `src/lib/auth/guard.ts`).
 *
 * The token comes ONLY from the URL `?t=...`. We never accept it from
 * a header or cookie because the email link is the canonical surface;
 * accepting alternative carriers would create a phishing surface.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
    loadResponseByToken,
    ExternalAccessDenied,
} from '@/app-layer/usecases/vendor-assessment-response';

export async function GET(
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ assessmentId: string }> },
) {
    const params = await paramsPromise;
    const url = new URL(req.url);
    const rawToken = url.searchParams.get('t');

    try {
        const data = await loadResponseByToken(rawToken, params.assessmentId);
        return NextResponse.json(data);
    } catch (err) {
        if (err instanceof ExternalAccessDenied) {
            // Map the three "link is dead" reasons — expired, revoked,
            // wrong_status — to 410 Gone so the UI can show a single
            // "this link is no longer active" message without
            // distinguishing which gate tripped. Everything else is 401.
            const statusCode =
                err.reason === 'expired' ||
                err.reason === 'revoked' ||
                err.reason === 'wrong_status'
                    ? 410
                    : 401;
            return NextResponse.json(
                {
                    error: 'access_denied',
                    // The reason is included for the UI to render a
                    // friendlier message; it never reveals which
                    // assessment failed.
                    reason: err.reason,
                },
                { status: statusCode },
            );
        }
        throw err;
    }
}
