/**
 * THE HOST-CONSUMER AGENT CARD, at the A2A v0.3/v1.0 filename (#3862).
 *
 *   GET /api/a2a/:tenantSlug/.well-known/agent-card.json
 *
 * The protocol renamed the well-known file to `agent-card.json`; SAP's Joule
 * toolkit still composes the pre-0.3 `agent.json`. Both are served, with the
 * SAME bytes, so a host following either finds the card. The sibling
 * `agent.json` route carries the full reasoning and the toolkit citation.
 *
 * This is a second PATH to one document, not a second document — a test asserts
 * the two responses are byte-identical, because two thin handlers are exactly
 * the kind of pair that drifts.
 *
 * Public by necessity and triaged `PUBLIC_UNAUTHENTICATED`, same single 404 for
 * every reason there is no card, same `a2a-agent-card` rate-limit bucket.
 */
import { NextRequest, NextResponse } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';
import { enforceRateLimit, getClientIp, isRateLimitBypassed } from '@/lib/security/rate-limit-middleware';
import { getTenantA2aHostConsumerCard } from '@/app-layer/usecases/a2a-agent-card';

function applyCardReadRateLimit(req: NextRequest): NextResponse | null {
    if (isRateLimitBypassed()) return null;
    const enforcement = enforceRateLimit(req, {
        scope: 'a2a-agent-card',
        config: API_READ_LIMIT,
        ip: getClientIp(req),
    });
    return enforcement.response ?? null;
}

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ tenantSlug: string }> }) => {
        const limited = applyCardReadRateLimit(req);
        if (limited) return limited;
        const { tenantSlug } = await params;
        const card = await getTenantA2aHostConsumerCard({
            tenantSlug,
            requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
        });
        if (!card) {
            return NextResponse.json(
                { error: { code: 'NOT_FOUND', message: 'No agent card.' } },
                { status: 404, headers: { 'cache-control': 'no-store' } },
            );
        }
        return NextResponse.json(card, { status: 200, headers: { 'cache-control': 'public, max-age=300' } });
    },
);
