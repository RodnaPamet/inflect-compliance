/**
 * THE TENANT'S PUBLISHED A2A AGENT CARD (#3742; threat-model R19).
 *
 *   GET /api/a2a/:tenantSlug/agent-card.json
 *
 * The card's URL is the tenant's A2A identity: what it signs as, and what a
 * peer must address. It names the per-tenant endpoint, the receipt format, and
 * the public key the tenant signs with — plus, during a rotation's grace
 * period, the one it signed with before — and it is signed by the key in force.
 *
 * ## Public by necessity
 *
 * A peer fetches the card to pin it, before it holds any credential, so there
 * is no credential to check. That is safe because the card names only what an
 * operator would otherwise hand the peer out of band: no agent list, no tenant
 * name, no workflow. `own-card.ts` holds the member set, and a test asserts it
 * over the whole document. Triaged `PUBLIC_UNAUTHENTICATED` in
 * `tests/guardrails/api-route-has-some-authorization.test.ts`.
 *
 * Every reason there is no card answers the same 404 — an unknown or deleted
 * tenant, no signing key, no public origin — so the route says nothing about
 * which slugs exist or which tenants have set up A2A. `withApiErrorHandling`
 * rate-limits only mutations, so this read is throttled here, by IP.
 */
import { NextRequest, NextResponse } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';
import { enforceRateLimit, getClientIp, isRateLimitBypassed } from '@/lib/security/rate-limit-middleware';
import { getTenantA2aAgentCard } from '@/app-layer/usecases/a2a-agent-card';

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
        const card = await getTenantA2aAgentCard({
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
