/**
 * THE PER-PEER INBOUND A2A ENDPOINT (#3679, step 4b): where one pinned peer sends
 * this tenant a task, or asks after one it sent.
 *
 *   POST /api/a2a/:tenantSlug/peers/:peerId
 *   Authorization: Bearer iflp_…            the peer's own inbound credential
 *   x-inflect-a2a-receipt: …                the peer's signature over this body
 *   { "jsonrpc": "2.0", "method": "message/send" | "tasks/get", … }
 *
 * Kept for peers already given it (owner decision 2026-10-20, #3742). The card
 * names the per-tenant endpoint, `POST /api/a2a/:tenantSlug`, which finds the
 * peer from its credential; this one names the peer in the path and requires
 * the credential to be that peer's. Both admit through `handleInboundA2a`, in
 * the same order and with the same refusals.
 *
 * ## Why it is not under /api/t/**, and has no `requirePermission`
 *
 * The caller is another organisation's agent. No session or role stands behind
 * it, so nothing `requirePermission` resolves can say who it is, and under
 * `/api/t/**` the edge would refuse it for want of a cookie — or, worse, widen
 * the `iflk_` carve-out that skips the admin-role and MFA gates. So this path
 * has its own entry in `MACHINE_CALLER_PREFIXES`, the edge lets it through
 * WITHOUT deciding anything, and the handler decides everything: the tenant,
 * the peer, the kill, the credential, the signature, the card, the quota and
 * the caps, in that order, in `handleInboundA2a`. Every refusal attributable to
 * a tenant writes the `AUTHZ_DENIED` row `requirePermission` would have.
 * Triaged `PROTOCOL_CREDENTIAL` in
 * `tests/guardrails/api-route-has-some-authorization.test.ts`.
 *
 * ## The body is capped before it is read into a string
 *
 * `readA2aBody` (I1 D). The mutation rate limit of `withApiErrorHandling`
 * applies by IP on top of the per-peer quota inside.
 */
import { NextRequest, NextResponse } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { a2aRefusal } from '@/lib/agentic/a2a/protocol';
import { A2A_RECEIPT_HEADER } from '@/lib/agentic/a2a/receipt';
import { A2A_VERSION_HEADER } from '@/lib/agentic/a2a/version';
import { readA2aBody } from '@/lib/agentic/a2a/body';
import { handleInboundA2a } from '@/app-layer/usecases/a2a-inbound';

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ tenantSlug: string; peerId: string }> }) => {
        const { tenantSlug, peerId } = await params;
        const read = await readA2aBody(req);
        if (!read.ok) {
            return new NextResponse(a2aRefusal(null), { status: 413, headers: { 'content-type': 'application/json' } });
        }
        const res = await handleInboundA2a({
            tenantSlug,
            peerId,
            authorization: req.headers.get('authorization'),
            receiptHeader: req.headers.get(A2A_RECEIPT_HEADER),
            protocolVersion: req.headers.get(A2A_VERSION_HEADER),
            body: read.body,
            requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
        });
        return new NextResponse(res.body, { status: res.status, headers: res.headers });
    },
);
