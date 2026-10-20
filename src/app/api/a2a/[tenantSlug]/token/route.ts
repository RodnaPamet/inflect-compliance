/**
 * THE HOST-CONSUMER TOKEN ENDPOINT (#3861).
 *
 *   POST /api/a2a/:tenantSlug/token
 *   Content-Type: application/x-www-form-urlencoded
 *   grant_type=client_credentials&client_id=ifhc_…&client_secret=…
 *
 *   → 200 { "access_token": "…", "token_type": "Bearer", "expires_in": 900 }
 *   → 4xx { "error": "invalid_client" }   — one shape for every failure
 *
 * This is what SAP's BTP destination calls when configured
 * `OAuth2ClientCredentials`: it exchanges the client id and secret for an
 * access token before calling the agent, using the destination's
 * `tokenServiceURL`.
 *
 * BOTH CREDENTIAL CARRIAGE FORMS ARE ACCEPTED, and that is deliberate rather
 * than generous. RFC 6749 allows the client id and secret either in the form
 * body (§2.3.1) or as HTTP Basic (§2.3.1, and it says servers "MUST support"
 * Basic). I have not been able to confirm which BTP sends — the toolkit
 * documents the destination's shape, not its wire format — so refusing one
 * would be a coin flip on an integration I cannot test from here. J5's pilot
 * should record which one Joule actually used; until then supporting both is
 * the honest reading of the spec, not a guess about the client.
 *
 * No session stands behind the caller: the client credentials ARE the
 * authentication, and everything is decided in `issueHostConsumerToken`.
 * Triaged `PROTOCOL_CREDENTIAL` in
 * `tests/guardrails/api-route-has-some-authorization.test.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { issueHostConsumerToken } from '@/app-layer/usecases/a2a-host-consumer-token';

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' } as const;

/** 8 KiB. A token request is a handful of short fields; anything larger is not one. */
const MAX_BODY_BYTES = 8 * 1024;

function credentialsFromBasic(authorization: string | null): { id: string; secret: string } | null {
    if (!authorization) return null;
    const m = /^Basic\s+(.+)$/i.exec(authorization.trim());
    if (!m) return null;
    let decoded: string;
    try {
        decoded = Buffer.from(m[1], 'base64').toString('utf8');
    } catch {
        return null;
    }
    // RFC 6749 §2.3.1: the id and secret are form-urlencoded before being
    // joined, so a secret containing ':' round-trips. Split on the FIRST colon.
    const at = decoded.indexOf(':');
    if (at < 0) return null;
    return {
        id: decodeURIComponent(decoded.slice(0, at)),
        secret: decodeURIComponent(decoded.slice(at + 1)),
    };
}

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ tenantSlug: string }> }) => {
        const { tenantSlug } = await params;

        const raw = await req.text();
        if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
            return new NextResponse(JSON.stringify({ error: 'invalid_request' }), {
                status: 413,
                headers: { ...JSON_HEADERS },
            });
        }
        const form = new URLSearchParams(raw);
        const basic = credentialsFromBasic(req.headers.get('authorization'));

        const result = await issueHostConsumerToken({
            tenantSlug,
            grantType: form.get('grant_type'),
            // The body wins when both are present: a client that sent the
            // fields meant them, and silently preferring a header it may not
            // know it inherited from a proxy would be the surprising way round.
            clientId: form.get('client_id') ?? basic?.id ?? null,
            clientSecret: form.get('client_secret') ?? basic?.secret ?? null,
        });

        if (!result.ok) {
            // ONE shape for every failure. Which one it was is in the audit
            // row — telling an unknown client id from a wrong secret out here
            // would be a client-id oracle.
            return new NextResponse(
                JSON.stringify({ error: result.reason === 'UNSUPPORTED_GRANT_TYPE' ? 'unsupported_grant_type' : 'invalid_client' }),
                { status: result.httpStatus, headers: { ...JSON_HEADERS } },
            );
        }

        return new NextResponse(
            JSON.stringify({
                access_token: result.accessToken,
                token_type: result.tokenType,
                expires_in: result.expiresIn,
            }),
            { status: 200, headers: { ...JSON_HEADERS } },
        );
    },
);
