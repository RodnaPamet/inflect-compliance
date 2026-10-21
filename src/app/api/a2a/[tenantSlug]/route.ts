/**
 * THE PER-TENANT INBOUND A2A ENDPOINT (#3742; owner decision 2026-10-20): the
 * endpoint the tenant's published agent card names.
 *
 *   POST /api/a2a/:tenantSlug
 *   Authorization: Bearer iflp_…            the peer's own inbound credential
 *   x-inflect-a2a-receipt: …                the peer's signature over this body
 *   { "jsonrpc": "2.0", "method": "message/send" | "tasks/get", … }
 *
 * One URL per tenant, so a card can name it before the tenant has registered
 * the peer that will read it. The peer is found from its own `iflp_`
 * credential, through the unique index on the credential's hash; from there
 * `handleInboundA2a` admits the message exactly as the per-peer route does, in
 * the same order and with the same refusals.
 *
 * No session or role stands behind the caller, so the handler decides
 * everything and the edge nothing (`MACHINE_CALLER_PREFIXES`, `/api/a2a`).
 * Triaged `PROTOCOL_CREDENTIAL` in
 * `tests/guardrails/api-route-has-some-authorization.test.ts`. The body is
 * capped by `readA2aBody`, and the mutation rate limit of
 * `withApiErrorHandling` applies by IP on top of the per-peer quota inside.
 */
import { NextRequest, NextResponse } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { a2aRefusal } from '@/lib/agentic/a2a/protocol';
import { A2A_RECEIPT_HEADER } from '@/lib/agentic/a2a/receipt';
import { A2A_VERSION_HEADER } from '@/lib/agentic/a2a/version';
import { readA2aBody } from '@/lib/agentic/a2a/body';
import { handleInboundA2a } from '@/app-layer/usecases/a2a-inbound';

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ tenantSlug: string }> }) => {
        const { tenantSlug } = await params;
        const read = await readA2aBody(req);
        if (!read.ok) {
            return new NextResponse(a2aRefusal(null), { status: 413, headers: { 'content-type': 'application/json' } });
        }
        const res = await handleInboundA2a({
            tenantSlug,
            authorization: req.headers.get('authorization'),
            receiptHeader: req.headers.get(A2A_RECEIPT_HEADER),
            protocolVersion: req.headers.get(A2A_VERSION_HEADER),
            body: read.body,
            requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
        });
        return new NextResponse(res.body, { status: res.status, headers: res.headers });
    },
);
