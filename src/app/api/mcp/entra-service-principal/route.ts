/**
 * THE SERVICE-PRINCIPAL MCP ENDPOINT — two tools, one intended client, and it
 * is us (#3671, step 2c of the agentic IAM roadmap).
 *
 * `POST /api/mcp/entra-service-principal`
 *
 * An MCP server advertising exactly two tools: `disable_service_principal` and
 * the prior-state read that pairs with it, `read_service_principal_state`.
 *
 * ═══ OUTBOUND, NEVER AGENT-FACING ═══
 *
 * `src/lib/mcp/` is the server an AGENT speaks to: a `tools/call` there
 * executes. Every rail this write is governed by — the connection's rung, the
 * prior-state pairing, the `PENDING` journal row carrying what was replaced,
 * the template and population re-checked at send — lives on the outbound path
 * in `external-write-dispatch`. A disable tool on the agent-facing server
 * would be the write with the rails stripped off, which is the near miss
 * `docs/implementation-notes/2026-10-09-grant-mcp-endpoint.md` records for the
 * grant. So this route is a SIBLING of `/api/mcp/entra-grant`, reached only by
 * our own dispatch over HTTPS through a connection, and nothing under
 * `src/lib/mcp/` imports it or its usecase
 * (`tests/guards/service-principal-disable-graph-seam.test.ts`).
 *
 * ═══ WHY A SIBLING AND NOT TWO MORE TOOLS ON THE GRANT ENDPOINT ═══
 *
 * The rung is per CONNECTION. On the grant endpoint, a tenant at `AUTOMATIC`
 * for time-bounded grants would be at `AUTOMATIC` for disabling principals in
 * the same breath, with the grant's seven days of evidence standing in for the
 * disable's. As a sibling, the disable is reached through its OWN connection,
 * which climbs its own ladder from `DISABLED`; and `endpointBindingRefusal`
 * refuses a token whose connection names a different endpoint, so the grant
 * connection's credential cannot reach this one.
 *
 * ═══ THE GATE IS THE TOKEN, AS ON THE GRANT ENDPOINT ═══
 *
 * Nothing in the permission system can express "our own dispatch", so there is
 * no `requirePermission` here (`docs/agentic-iam-roadmap.md`, "Token-gated
 * endpoints"). The credential is `<connectionId>.<secret>`, authenticated by
 * the same `authenticateGrantCaller`, and the tenant comes from the connection
 * row it names — authenticated, never asserted. Every refusal that can be
 * attributed to a tenant writes the `AUTHZ_DENIED` row `requirePermission`
 * would have written; the ones that cannot are logged.
 *
 * ═══ THE GRAPH PERMISSION THE CONNECTION'S APP NEEDS ═══
 *
 * `Application.Read.All` (the prior-state read) + `Application.ReadWrite.OwnedBy`
 * (the disable) — owner decision, 2026-10-18; never `Application.ReadWrite.All`.
 * `OwnedBy` writes only principals whose application Inflect's app owns, so a
 * principal it does NOT own reads fine and then fails the PATCH with 403
 * `Authorization_RequestDenied`: the tool call becomes a protocol error and the
 * dispatch settles the journal row `INDETERMINATE` for a human to finish in the
 * customer's directory. That is the designed outcome, not a fault to retry.
 * `providers/entra-id/service-principal.ts` carries the reasoning.
 */
import { NextRequest } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { notFound, unauthorized } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { appendAuditEntryOrQueue } from '@/lib/audit';
import { buildSystemContext } from '@/app-layer/context-system';
import {
    dispatchMcp,
    rpcError,
    RpcErrorCode,
    type JsonRpcRequest,
    type JsonRpcResponse,
    type McpHandlers,
    type McpToolDescriptor,
    type McpToolResult,
} from '@/lib/mcp/protocol';
import {
    SERVICE_PRINCIPAL_DISABLE_TOOL,
    SERVICE_PRINCIPAL_READ_TOOL,
} from '@/lib/agentic/service-principal-disable';
import {
    authenticateGrantCaller,
    describeGrantAuthRefusal,
} from '@/app-layer/usecases/entra-grant-auth';
import {
    disableServicePrincipal,
    endpointBindingRefusal,
    readServicePrincipalState,
} from '@/app-layer/usecases/entra-service-principal-dispatch';
import type { RequestContext } from '@/app-layer/types';

export const DISABLE_TOOL = SERVICE_PRINCIPAL_DISABLE_TOOL;
export const READ_TOOL = SERVICE_PRINCIPAL_READ_TOOL;

/**
 * The catalogue. Two tools, and the descriptions are part of the contract —
 * `McpToolManifestPin` hashes them and a human accepts the pin.
 *
 * EXPORTED so a test can assert against the real object rather than grep this
 * file.
 */
export const TOOLS: readonly McpToolDescriptor[] = [
    {
        name: DISABLE_TOOL,
        description:
            'Disable one Entra service principal so it can no longer obtain tokens. Sets '
            + 'accountEnabled to false and changes nothing else; it is undone by setting the same '
            + 'field back. Refused, and nothing is sent, when the principal is already disabled, '
            + 'is the principal this connection authenticates as, or belongs to a Microsoft '
            + 'first-party application.',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['servicePrincipalId'],
            properties: {
                servicePrincipalId: {
                    type: 'string',
                    description: "The service principal's directory object id (a GUID).",
                },
            },
        },
        // EXPLICIT false, and `destructiveHint: true`: this REMOVES a
        // principal's ability to authenticate. `idempotentHint: true` — a
        // second disable is refused rather than repeated.
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    {
        name: READ_TOOL,
        description:
            'Whether one Entra service principal is enabled, with its application id, display '
            + 'name, type and owning organisation. This is the prior-state read paired with the '
            + 'disable: it reports the state the disable would replace.',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['servicePrincipalId'],
            properties: {
                servicePrincipalId: {
                    type: 'string',
                    description: "The service principal's directory object id (a GUID).",
                },
            },
        },
        // MUST be true: `setPriorStateRead` refuses a prior-state read that is
        // not declared read-only.
        annotations: { readOnlyHint: true },
    },
];

function refusal(text: string): McpToolResult {
    return { content: [{ type: 'text', text }], isError: true };
}

function ok(payload: unknown): McpToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * Record a refused call where it can be attributed, log it where it cannot.
 * Best-effort: a failure to write the row must not turn a 401 into a 500.
 * The presented credential is NEVER included — only the connection the token
 * named and the reason it failed.
 */
async function recordRefusal(refused: {
    readonly tenantId: string | null;
    readonly kind: string;
    readonly connectionId: string | null;
}): Promise<void> {
    if (refused.tenantId === null) {
        logger.warn('service principal endpoint refused an unattributable caller', {
            component: 'entra-service-principal-endpoint',
            reason: refused.kind,
        });
        return;
    }
    try {
        await appendAuditEntryOrQueue({
            tenantId: refused.tenantId,
            userId: null,
            actorType: 'SYSTEM',
            entity: 'IntegrationConnection',
            entityId: refused.connectionId ?? 'unknown',
            action: 'AUTHZ_DENIED',
            detailsJson: { endpoint: 'entra-service-principal', reason: refused.kind },
        });
    } catch {
        logger.error('service principal endpoint could not record a refusal', {
            component: 'entra-service-principal-endpoint',
            tenantId: refused.tenantId,
            reason: refused.kind,
        });
    }
}

async function callTool(
    ctx: RequestContext,
    name: string,
    rawArgs: unknown,
): Promise<McpToolResult> {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const servicePrincipalId =
        typeof args.servicePrincipalId === 'string' ? args.servicePrincipalId.trim() : '';

    if (name === DISABLE_TOOL) {
        const outcome = await disableServicePrincipal(ctx, { servicePrincipalId });
        return outcome.ok ? ok({ disabled: true }) : refusal(outcome.refused);
    }

    if (name === READ_TOOL) {
        const outcome = await readServicePrincipalState(ctx, { servicePrincipalId });
        return outcome.ok
            ? ok({ servicePrincipal: outcome.servicePrincipal })
            : refusal(outcome.refused);
    }

    // In-band, so a client's MCP session survives a typo, and it names nothing
    // about what else exists.
    return refusal(`Unknown tool: ${name}`);
}

export const POST = withApiErrorHandling(async (req: NextRequest) => {
    // TRANSPORT AUTH FIRST, before the body is read.
    const header = req.headers.get('authorization');
    const named = /^Bearer\s+([^.\s]+)\./i.exec(header ?? '');
    const auth = await authenticateGrantCaller(header);
    if (!auth.ok) {
        await recordRefusal({
            tenantId: auth.refusal.attributable ? auth.refusal.tenantId : null,
            kind: auth.refusal.kind,
            connectionId: named ? named[1] : null,
        });
        throw unauthorized(describeGrantAuthRefusal(auth.refusal));
    }

    // SYSTEM, not delegated: there is no User row behind this call.
    const ctx = buildSystemContext({
        tenantId: auth.tenantId,
        job: 'entra-service-principal-endpoint',
        discriminator: auth.connectionId,
    });

    // THE CONNECTION MUST NAME THIS ENDPOINT, still before the body is read.
    const binding = await endpointBindingRefusal(ctx, auth.connectionId);
    if (binding) {
        await recordRefusal({
            tenantId: auth.tenantId,
            kind: 'wrong_endpoint',
            connectionId: auth.connectionId,
        });
        throw unauthorized(binding);
    }

    let payload: unknown;
    try {
        payload = await req.json();
    } catch {
        return jsonResponse(rpcError(null, RpcErrorCode.ParseError, 'Invalid JSON'), {
            status: 400,
        });
    }

    const handlers: McpHandlers = {
        // UNFILTERED: the only caller is our own dispatch, which resolved what
        // it may send before opening a socket.
        listTools: () => [...TOOLS],
        callTool: (name, args) => callTool(ctx, name, args),
        // NO RESOURCES, stated rather than omitted — see the grant endpoint.
        listResources: () => [],
        readResource: () => {
            throw notFound('This endpoint exposes tools only; it has no resources.');
        },
    };

    const requests = Array.isArray(payload) ? payload : [payload];
    const responses: JsonRpcResponse[] = [];
    for (const raw of requests) {
        const response = await dispatchMcp(raw as JsonRpcRequest, handlers);
        if (response !== null) responses.push(response);
    }

    if (responses.length === 0) return new Response(null, { status: 202 });

    return jsonResponse(Array.isArray(payload) ? responses : responses[0]);
});
