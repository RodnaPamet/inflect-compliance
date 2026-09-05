/**
 * `POST /api/mcp/token` — RFC 8693 token exchange for the MCP surface.
 *
 * Takes a long-lived `TenantApiKey` as the SUBJECT TOKEN and returns a
 * short-lived ACCESS TOKEN scoped to a named audience: a set of MCP tool names,
 * or `mcp:resources`. `/api/mcp` then refuses that token at anything outside its
 * audience — the binding is enforced at the tool boundary, not recorded.
 *
 * ## Authorization
 *
 * The subject token IS the credential, so there is no session and no
 * `requirePermission` here — the same shape as `/api/mcp` itself, and it carries
 * the same `PROTOCOL_CREDENTIAL` classification in
 * `tests/guardrails/api-route-has-some-authorization.test.ts`. `exchangeMcpToken`
 * runs the full chain the tool surface runs: `verifyApiKey`, the MCP capability
 * scope, the agent-registration gate, principal resolution, and the
 * deny-by-default tool allowlist. A token can therefore never be minted for a
 * tool the agent could not have called, which is what makes exchange a
 * NARROWING and never a widening.
 *
 * ## Rate limit
 *
 * `API_KEY_CREATE_LIMIT` — the same tight budget minting a key gets, and for the
 * same reason: this endpoint turns one credential into another, so it is the
 * amplification surface. It is deliberately NOT the default mutation tier, which
 * would let a stolen key mint hundreds of audience-scoped children a minute.
 *
 * The response follows RFC 8693 §2.2.1 (`access_token`, `issued_token_type`,
 * `token_type`, `expires_in`) plus `audience`, which is not in the RFC's response
 * but is the one thing a client needs to know it got what it asked for.
 */
import { NextRequest } from 'next/server';

import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { exchangeMcpToken } from '@/lib/mcp/auth';
import { ACCESS_TOKEN_TYPE } from '@/lib/mcp/token-exchange';
import { McpTokenExchangeRequestSchema } from '@/app-layer/schemas/mcp-token-exchange.schemas';
import { API_KEY_CREATE_LIMIT } from '@/lib/security/rate-limit-middleware';

export const runtime = 'nodejs';

export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            throw badRequest('Invalid JSON body');
        }

        const parsed = McpTokenExchangeRequestSchema.parse(body);

        const clientIp =
            req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
            req.headers.get('x-real-ip') ??
            null;

        const minted = await exchangeMcpToken(
            parsed.subjectToken,
            { audience: parsed.audience, expiresIn: parsed.expiresIn },
            { method: 'POST', path: '/api/mcp/token' },
            { clientIp },
        );

        // No `Cache-Control: no-store`-worthy secret goes anywhere but the body,
        // and the body is the token — so say so explicitly rather than relying
        // on a default. A cached exchange response is a shared credential.
        return jsonResponse(
            {
                access_token: minted.token,
                issued_token_type: ACCESS_TOKEN_TYPE,
                token_type: 'Bearer',
                expires_in: minted.expiresInSeconds,
                audience: minted.audience,
                agent_id: minted.agentId,
            },
            { status: 201, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
        );
    },
    { rateLimit: { config: API_KEY_CREATE_LIMIT, scope: 'mcp-token-exchange' } },
);
