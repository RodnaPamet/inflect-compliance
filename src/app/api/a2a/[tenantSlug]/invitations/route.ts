/**
 * WHERE AN A2A PEER INVITATION IS ACCEPTED (#3752; owner decisions 2026-11-11).
 *
 *   POST /api/a2a/:tenantSlug/invitations
 *   x-inflect-invitation-signature: <hex>    the acceptor's Ed25519 signature over this body
 *   { "v": "inflect-a2a-invitation-accept/1", "code": "iflinv_…", "cardUrl": …, "token": "iflp_…", "issuedAt": … }
 *
 * The accepting workspace sends this when a person there accepts the code this
 * tenant issued. No session stands behind it: the single-use code, its expiry,
 * a signature by the key the acceptor's OWN card names, and the inviting
 * person's standing when it arrives decide everything
 * (`acceptPeerInvitationAtInviter`). It registers the acceptor UNPINNED; a
 * person here approves its card before anything flows.
 *
 * Under `/api/a2a`, so the edge decides nothing (`MACHINE_CALLER_PREFIXES`).
 * Triaged `PROTOCOL_CREDENTIAL` in
 * `tests/guardrails/api-route-has-some-authorization.test.ts`. The body is
 * capped by `readA2aBody`, and the mutation rate limit of
 * `withApiErrorHandling` applies by IP. A refusal names no reason to the
 * caller; the reason goes to the log.
 */
import { NextRequest, NextResponse } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { readA2aBody } from '@/lib/agentic/a2a/body';
import { PEER_INVITATION_SIGNATURE_HEADER } from '@/lib/agentic/a2a/invitation';
import { acceptPeerInvitationAtInviter } from '@/app-layer/usecases/peer-invitations';

/** An acceptance is one small JSON object. */
const ACCEPTANCE_MAX_BYTES = 8 * 1024;

const json = { 'content-type': 'application/json' };

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ tenantSlug: string }> }) => {
        const { tenantSlug } = await params;
        const read = await readA2aBody(req, ACCEPTANCE_MAX_BYTES);
        if (!read.ok) return new NextResponse(JSON.stringify({ error: 'refused' }), { status: 413, headers: json });
        const out = await acceptPeerInvitationAtInviter({
            tenantSlug,
            body: read.body,
            signature: req.headers.get(PEER_INVITATION_SIGNATURE_HEADER),
            requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
        });
        if (!out.ok) return new NextResponse(JSON.stringify({ error: 'refused' }), { status: out.status, headers: json });
        return new NextResponse(out.answer, { status: 200, headers: json });
    },
);
