/**
 * THE HOST-CONSUMER AGENT CARD, at the path SAP's Joule toolkit asks for (#3862).
 *
 *   GET /api/a2a/:tenantSlug/.well-known/agent.json
 *
 * `agent.json` is the PRE-0.3 filename. SAP's toolkit composes "destination
 * base URL" + `/.well-known/agent.json` despite targeting A2A v0.3.0 —
 * confirmed from `skills/joule-a2a-agent/SKILL.md:311` ("must be served at") in
 * `SAP-samples/joule-a2a-agent-toolkit`. The v0.3/v1.0 spelling is served by the
 * sibling `agent-card.json` route, with the same bytes, so a host following
 * either the toolkit or the current spec finds the card.
 *
 * The per-tenant base is the right one to hang these off: the toolkit appends
 * the suffix to the destination's base URL (`references/joule-capability.md:323`),
 * and `/api/a2a/{slug}` is a base.
 *
 * ## Public by necessity, like the peer card
 *
 * A host fetches this before it holds anything, so there is no credential to
 * check. Triaged `PUBLIC_UNAUTHENTICATED` in
 * `tests/guardrails/api-route-has-some-authorization.test.ts`. What it may
 * disclose is bounded by `host-card-skills.ts`: the skills are the workflows
 * carrying reviewed public copy, the same list for every tenant, so this route
 * reveals no tenant fact beyond the one its own 404 already reveals.
 *
 * Every reason there is no card answers the SAME 404 — unknown or deleted
 * tenant, no signing key, no public origin, host consumers not enabled — so the
 * route is not an oracle for which tenants have set this up.
 *
 * Rate-limited under the existing `a2a-agent-card` scope, by IP: all card reads
 * share one bucket because they are one resource class, and
 * `withApiErrorHandling` throttles only mutations.
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
