/**
 * GET /.well-known/http-message-signatures-directory — the deployment's Web
 * Bot Auth key directory (docs/ai-architecture/web-bot-auth.md Phase 1).
 *
 * Public and anonymous by design: a verifier fetches it to learn the keys
 * Inflect's crawler signs with. It publishes PUBLIC keys only and reads no
 * tenant data — it takes no context at all, because the signing identity is
 * the deployment's (D-L1-5). The edge lets it through by its exact path
 * (`PUBLIC_PATH_EXACT` in `src/lib/auth/guard.ts`); the per-IP read budget is
 * charged here, in the handler, so the edge middleware is unchanged.
 *
 * Unconfigured (no `WEB_BOT_AUTH_SIGNING_KEY`, or no bare https `APP_URL`)
 * it answers 404 before anything else: absent configuration serves nothing
 * and charges no rate-limit bucket (G9). GET only — Next answers 405 to the
 * rest.
 *
 * Nothing here signs an outbound request; that is Phase 2.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { enforceRateLimit } from '@/lib/security/rate-limit-middleware';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';
import { webBotAuthDirectoryConfig } from '@/lib/web-bot-auth/config';
import { signedDirectoryResponse } from '@/lib/web-bot-auth/directory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
    const config = webBotAuthDirectoryConfig();
    if (!config) {
        return new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }

    const limited = enforceRateLimit(req, { scope: 'web-bot-auth-directory', config: API_READ_LIMIT });
    if (limited.response) return limited.response;

    const signed = signedDirectoryResponse(config.keys, config.authority, Date.now() / 1000);
    return new NextResponse(signed.body, { status: 200, headers: { ...signed.headers } });
}
