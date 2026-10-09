/**
 * THE GRANT MCP ENDPOINT — two tools, one intended client, and it is us.
 *
 * `POST /api/mcp/entra-grant`
 *
 * An MCP server advertising exactly two tools: a time-bounded access-package
 * assignment and the prior-state read that pairs with it. Part of #3297.
 *
 * ═══ WHY THIS MOVED OFF `/api/t/:tenantSlug/admin/...` (#3323) ═══
 *
 * #3321 put it there, gated on `admin.tenant_lifecycle`, reached with an
 * `iflk_` API key. That cannot work. `scopesToPermissions`:
 *
 *     …they join `tenant_lifecycle` and `owner_management` — actions that need
 *     a real session and that no bearer token, however scoped, performs.
 *
 * So the endpoint was callable by a human in a browser and by nothing else,
 * which is the exact inverse of its purpose. The dispatch is a job.
 *
 * It had to leave `/api/t/**` as well, not just change its gate: the edge
 * admits only a session cookie or an `iflk_` bearer on that prefix, so a
 * per-connection token would be refused before the handler ran.
 *
 * ═══ THE TENANT IS STILL AUTHENTICATED, NOT ASSERTED ═══
 *
 * That was the property the tenant-in-the-path was protecting, and it survives
 * the move. The credential is `<connectionId>.<secret>`, and the CONNECTION ROW
 * carries the tenant — so the tenant arrives from a row found by a secret only
 * we hold, never from a caller-supplied argument. The rejected alternative (one
 * deployment secret plus a tenant argument) proves "it is us" and says nothing
 * about "for this tenant".
 *
 * Blast radius is narrower than the key design rather than wider: a leaked
 * token reaches one connection in one tenant, grants nothing else anywhere, and
 * is not a credential any human flow can present.
 *
 * ═══ WHY THERE IS NO `requirePermission` HERE, AND WHAT REPLACES ITS AUDIT ═══
 *
 * Nothing in the permission system can express "our own dispatch", so the gate
 * is the token. What `requirePermission` gave for free was the hash-chained
 * `AUTHZ_DENIED` row on refusal, and dropping that silently would be the real
 * loss — a refused grant attempt is exactly what an operator wants in the
 * trail. So every refusal that can be attributed to a tenant writes one.
 *
 * The ones that cannot are honest about it: a malformed token or an unknown
 * connection id identifies no tenant, `AuditLog` is tenant-scoped, and there is
 * no trail to write them to. Those are logged. `GrantAuthRefusal.attributable`
 * carries that distinction in the type so a new refusal kind has to decide
 * which it is.
 *
 * ═══ WHY IT STILL ADVERTISES EXACTLY TWO TOOLS ═══
 *
 * Discovery — listing a tenant's access packages so an operator can pick one —
 * is deliberately NOT here (#3329). The dispatch never needs it: it is handed a
 * resolved package id by a template a human approved. A compose form is a
 * different caller with different authority, and it reads through an admin
 * route under a session. Putting discovery here would widen the one surface
 * whose smallness is an asserted property.
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
    authenticateGrantCaller,
    describeGrantAuthRefusal,
    type GrantAuthRefusal,
} from '@/app-layer/usecases/entra-grant-auth';
import {
    grantTimeBoundedAccess,
    readAccessAssignments,
    MAX_GRANT_DAYS as MAX_DAYS,
} from '@/app-layer/usecases/entra-grant-dispatch';
import type { RequestContext } from '@/app-layer/types';

export const GRANT_TOOL = 'grant_time_bounded_access';
export const READ_TOOL = 'read_access_assignments';

/**
 * The catalogue. Two tools, and the descriptions are part of the contract.
 *
 * `tools/list` is where a description reaches a model's context, and it does its
 * work there whether or not the tool is called — which is why
 * `McpToolManifestPin` hashes these and refuses a definition rewritten since a
 * human accepted it. So the wording is pinned material: it names the bound an
 * operator approved rather than leaving a model to infer that a grant is
 * temporary.
 */
const TOOLS: readonly McpToolDescriptor[] = [
    {
        name: GRANT_TOOL,
        description:
            'Assign an Entra access package to one subject until a named end date. The end date ' +
            `is REQUIRED and may be at most ${MAX_DAYS} days out; the directory expires the ` +
            'assignment itself. A missing, past or longer end date is refused, not adjusted.',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['targetId', 'accessPackageId', 'assignmentPolicyId', 'endDateTime'],
            properties: {
                targetId: { type: 'string', description: "The subject's Entra object id (a GUID)." },
                accessPackageId: { type: 'string', description: 'The access package id.' },
                assignmentPolicyId: {
                    type: 'string',
                    description: 'The assignment policy the package is granted under.',
                },
                endDateTime: {
                    type: 'string',
                    description:
                        'ISO 8601 instant at which the directory must end the assignment. ' +
                        'Required — there is no permanent-assignment path through this tool.',
                },
                justification: {
                    type: 'string',
                    description: 'Recorded on the request for the audit trail.',
                },
            },
        },
        // EXPLICIT false. The read below MUST declare true, and a pair where one
        // side is explicit and the other relies on a default invites a tidy-up.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    {
        name: READ_TOOL,
        description:
            'What one subject already holds of one access package, with the end date and state ' +
            'of any existing assignment. This is the prior-state read paired with the grant: it ' +
            'reports the state the grant would replace. An assignment that has lapsed remains ' +
            'listed with state "expired" and is NOT a current holding.',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['targetId', 'accessPackageId'],
            properties: {
                targetId: { type: 'string', description: "The subject's Entra object id." },
                accessPackageId: { type: 'string', description: 'The access package id.' },
            },
        },
        // MUST be true: `setPriorStateRead` refuses a prior-state read that is
        // not declared read-only, because pairing a write there would send two
        // changes per dispatch with the first unjournalled.
        annotations: { readOnlyHint: true },
    },
];

function refusal(text: string): McpToolResult {
    return { content: [{ type: 'text', text }], isError: true };
}

function ok(payload: unknown): McpToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

/**
 * Record a refused call where it can be attributed, log it where it cannot.
 *
 * Best-effort, like `requirePermission`'s own: a failure to write the row must
 * not turn a 401 into a 500, because the refusal already happened and the
 * caller is owed its answer either way.
 *
 * The presented credential is NEVER included — not the secret, not its length.
 * Only the connection the token named and the reason it failed.
 */
async function recordRefusal(r: GrantAuthRefusal, connectionId: string | null): Promise<void> {
    if (!r.attributable) {
        logger.warn('grant endpoint refused an unattributable caller', {
            component: 'entra-grant-endpoint',
            reason: r.kind,
        });
        return;
    }
    try {
        await appendAuditEntryOrQueue({
            tenantId: r.tenantId,
            userId: null,
            actorType: 'SYSTEM',
            entity: 'IntegrationConnection',
            entityId: connectionId ?? 'unknown',
            action: 'AUTHZ_DENIED',
            detailsJson: { endpoint: 'entra-grant', reason: r.kind },
        });
    } catch (err) {
        logger.error('grant endpoint could not record a refusal', {
            component: 'entra-grant-endpoint',
            tenantId: r.tenantId,
            reason: r.kind,
            detail: err instanceof Error ? err.message : String(err),
        });
    }
}

async function callTool(
    ctx: RequestContext,
    name: string,
    rawArgs: unknown,
): Promise<McpToolResult> {
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    if (name === GRANT_TOOL) {
        const outcome = await grantTimeBoundedAccess(ctx, {
            targetId: str(args.targetId),
            accessPackageId: str(args.accessPackageId),
            assignmentPolicyId: str(args.assignmentPolicyId),
            // `new Date(<anything>)` rather than parse-or-throw, on purpose: an
            // unparseable value becomes an Invalid Date and `expiryRefusal`
            // refuses it BY NAME. Throwing would turn an operator's typo into a
            // 500 instead of a sentence telling them what to fix.
            endDateTime: new Date(str(args.endDateTime)),
            ...(typeof args.justification === 'string'
                ? { justification: args.justification }
                : {}),
        });
        return outcome.ok ? ok({ requestId: outcome.requestId }) : refusal(outcome.refused);
    }

    if (name === READ_TOOL) {
        const outcome = await readAccessAssignments(ctx, {
            targetId: str(args.targetId),
            accessPackageId: str(args.accessPackageId),
        });
        return outcome.ok ? ok({ assignments: outcome.assignments }) : refusal(outcome.refused);
    }

    // In-band, so a client's MCP session survives a typo, and it names nothing
    // about what else exists.
    return refusal(`Unknown tool: ${name}`);
}

export const POST = withApiErrorHandling(async (req: NextRequest) => {
    // TRANSPORT AUTH FIRST, before the body is even read. A caller that may not
    // be here must not have its payload parsed, and a refusal must cost the
    // same whatever it sent.
    const auth = await authenticateGrantCaller(req.headers.get('authorization'));
    if (!auth.ok) {
        const named = /^Bearer\s+([^.\s]+)\./i.exec(req.headers.get('authorization') ?? '');
        await recordRefusal(auth.refusal, named ? named[1] : null);
        // A single generic status and a reason that names no secret. The sentence
        // is safe to show: it distinguishes "no token" from "wrong token" from
        // "that connection is disabled", all of which an operator must be able
        // to tell apart, and none of which leaks the credential.
        throw unauthorized(describeGrantAuthRefusal(auth.refusal));
    }

    // SYSTEM, not delegated. The actor IS the machine — there is no User row
    // behind this call, and `buildSystemContext` is the builder that says so.
    // `context.ts`'s builders are unusable here for the reason that module
    // documents: they reach `@/lib/auth` -> `@/auth`.
    const ctx = buildSystemContext({
        tenantId: auth.tenantId,
        job: 'entra-grant-endpoint',
        discriminator: auth.connectionId,
    });

    let payload: unknown;
    try {
        payload = await req.json();
    } catch {
        return jsonResponse(rpcError(null, RpcErrorCode.ParseError, 'Invalid JSON'), {
            status: 400,
        });
    }

    const handlers: McpHandlers = {
        // UNFILTERED, unlike `/api/mcp`'s catalogue, and that is right here: the
        // agent-grant and manifest-pin filters belong to the agent-facing
        // server. The only caller is our own dispatch, which resolved what it
        // may send before opening a socket. A second filter would be a weaker
        // copy of a gate that already ran.
        listTools: () => [...TOOLS],
        callTool: (name, args) => callTool(ctx, name, args),
        // NO RESOURCES, stated rather than omitted. `McpHandlers` requires
        // these and `dispatchMcp`'s `initialize` advertises a resources
        // capability unconditionally, so this endpoint claims one either way.
        // Defaulting them to the agent-facing server's would be far worse:
        // `listMcpResources` reaches this tenant's compliance data and has
        // nothing to do with a grant.
        listResources: () => [],
        readResource: () => {
            throw notFound('This endpoint exposes tools only; it has no resources.');
        },
    };

    const requests = Array.isArray(payload) ? payload : [payload];
    const responses: JsonRpcResponse[] = [];
    for (const raw of requests) {
        const response = await dispatchMcp(raw as JsonRpcRequest, handlers);
        // `null` is a NOTIFICATION — no id, no reply. Dropped rather than
        // answered, which is what the protocol requires.
        if (response !== null) responses.push(response);
    }

    // A batch of only notifications gets 202 and no body. Answering it with `[]`
    // would be a response to requests that carried no ids.
    if (responses.length === 0) return new Response(null, { status: 202 });

    return jsonResponse(Array.isArray(payload) ? responses : responses[0]);
});
