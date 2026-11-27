/**
 * WHETHER EACH LLM EVALUATION NIGHTLY IS SWITCHED ON, FOR CI (owner decision
 * 2026-11-27).
 *
 *   GET /api/evals/nightly-switches
 *   Authorization: Bearer <EVALS_SWITCH_READ_TOKEN>
 *   → 200 { "garak": bool, "ragas": bool, "inspect": bool }
 *
 * The caller is a GitHub Actions runner: each scheduled run of `garak.yml`,
 * `rag-eval.yml` and `agent-evals.yml` asks this before it boots anything, and
 * stays off on any answer but `true` for its own key. It has no session, so the
 * path is a `MACHINE_CALLER_PREFIXES` entry in `src/lib/auth/guard.ts` and the
 * handler authenticates the caller itself:
 *
 *   - 503 when the deployment's token is unset or too short — the endpoint is
 *     off, and so is every nightly;
 *   - 401, terse, for a missing, malformed or wrong token, compared in constant
 *     time (`verifyEvalsSwitchReadToken`);
 *   - 200 with the three booleans and nothing else.
 *
 * Read-only: the only method exported is GET, and the matching above is
 * path-scoped, so a second method here would have to gate itself too. Every
 * answer is `Cache-Control: no-store`, so no proxy serves yesterday's switch.
 * Rate-limited per IP before the token is looked at.
 */
import { NextRequest, NextResponse } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { env } from '@/env';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';
import { enforceRateLimit, getClientIp, isRateLimitBypassed } from '@/lib/security/rate-limit-middleware';
import { verifyEvalsSwitchReadToken } from '@/lib/evals/eval-switch-token';
import { readEvalNightlySwitchesForCi } from '@/app-layer/usecases/eval-nightly-switches';

const NO_STORE = { 'cache-control': 'no-store' } as const;

function applySwitchReadRateLimit(req: NextRequest): NextResponse | null {
    if (isRateLimitBypassed()) return null;
    const enforcement = enforceRateLimit(req, {
        scope: 'evals-nightly-switches',
        config: API_READ_LIMIT,
        ip: getClientIp(req),
    });
    return enforcement.response ?? null;
}

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const limited = applySwitchReadRateLimit(req);
    if (limited) return limited;

    const verdict = verifyEvalsSwitchReadToken(req.headers.get('authorization'), env.EVALS_SWITCH_READ_TOKEN);
    if (verdict === 'NOT_CONFIGURED') {
        return NextResponse.json({ error: 'Not configured' }, { status: 503, headers: NO_STORE });
    }
    if (verdict !== 'OK') {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
    }

    const switches = await readEvalNightlySwitchesForCi();
    return NextResponse.json(
        { garak: switches.garak, ragas: switches.ragas, inspect: switches.inspect },
        { status: 200, headers: NO_STORE },
    );
});
