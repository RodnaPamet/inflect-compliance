/**
 * THE GRANT MCP ENDPOINT — two tools, one intended client, and it is us.
 *
 * `POST /api/t/:tenantSlug/admin/mcp/entra-grant`
 *
 * An MCP server advertising exactly two tools: a time-bounded access-package
 * assignment and the prior-state read that pairs with it. Part of #3297. Owner
 * decision 2026-10-09 on the authentication, recorded below.
 *
 * ═══ WHY THIS IS NOT `/api/mcp` — THE NEAR MISS WORTH RECORDING ═══
 *
 * `src/lib/mcp/` is the AGENT-FACING server, and `src/lib/mcp/tools/` is where a
 * grant tool most obviously belongs: the directory name matches the sentence
 * "our own MCP server with a grant tool". Putting it there would have been a
 * mistake of exactly the kind that is invisible in review.
 *
 * An agent authenticated to `/api/mcp` calls `tools/call` and the tool EXECUTES.
 * The rails the owner chose this path for — the template and its bounds approved
 * by a human, the target population re-resolved at send rather than at approval,
 * the `PENDING` journal row, the prior-state pairing — all live on the OUTBOUND
 * path in `external-write-dispatch`, not on the inbound server. A grant tool on
 * the agent-facing server is therefore a grant tool with the rails stripped off,
 * reached by putting the code in the directory whose name fits.
 *
 * So the tools live here, behind a credential, and an agent reaches them ONLY
 * through the external-tools funnel: `external-tools.ts` offers an external
 * tool only if the agent is GRANTED it, a pin is ON FILE, the live definition
 * MATCHES that pin, and the connection is enabled — and then the dispatch adds
 * the connection's rung, the row's own rung, the pairing and the drift check
 * before anything is sent. The agent cannot shortcut to the grant, because the
 * only door is the one with the approval machinery behind it.
 *
 * ═══ WHY THE PATH CARRIES THE TENANT, AND WHY IT SITS UNDER `admin/` ═══
 *
 * The dispatch reaches this over HTTPS — `safeFetch` blocks loopback and RFC1918
 * by design, so an in-process call is not available without rewriting four
 * components that all assume the far end is external. It therefore has to prove
 * two things: that the caller is us, and WHICH tenant's directory to write in.
 *
 * The tenant is in the PATH rather than in the tool arguments, and that is the
 * load-bearing half. A tenant arriving as an argument is caller-asserted; a
 * tenant in the path is authenticated, because `getTenantCtx` resolves it from
 * the credential and refuses a key whose tenant is not the slug in the URL
 * (#2224). The alternative — one deployment secret plus a tenant argument —
 * proves "it is us" and says nothing about "for this tenant".
 *
 * `admin/` is not decoration either. `api-permission-coverage`'s
 * `PRIVILEGED_ROOTS` includes `src/app/api/t/[tenantSlug]/admin`, so a route
 * placed here is in the guarded population automatically and a literal
 * `requirePermission` is ENFORCED rather than remembered. Only a literal counts
 * there, and deliberately: a `requirePermission` denial writes a hash-chained
 * `AUTHZ_DENIED` row where an `assertCanAdmin` denial writes nothing.
 *
 * `admin.tenant_lifecycle` is the key — OWNER-only; ADMIN does not hold it. The
 * same key the rung and the prior-state pairing use, on their reasoning:
 * *"deciding what gets called against a customer's system immediately before it
 * is changed is authority of that class."* Assigning access in a customer's
 * directory is not a lesser act than nominating the read before it.
 *
 * ═══ THE EXPOSURE, STATED RATHER THAN DISCOVERED LATER ═══
 *
 * This is a publicly reachable origin, so its authentication is load-bearing in
 * a way an in-process call's would not be. That is the cost of the rails and it
 * is worth naming: the endpoint is not an open grant button, but it is reachable
 * by anything that can present a valid key for this tenant holding
 * `admin.tenant_lifecycle`. A key that can reach a grant therefore exists, is
 * revocable at `/admin/api-keys`, and should be scoped to nothing else.
 *
 * ═══ WHY `readOnlyHint` IS EXPLICIT ON BOTH TOOLS ═══
 *
 * `declaresWrite` treats an absent annotation as a WRITE, so the grant would be
 * classified correctly by saying nothing. It says `readOnlyHint: false` anyway,
 * because the read MUST say `true` — `setPriorStateRead` refuses a prior-state
 * read that is not declared read-only — and a pair where one side is explicit
 * and the other relies on a default invites someone to "tidy" the explicit one
 * away. Both declare, so neither reads as accidental.
 */
import { NextRequest } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { notFound } from '@/lib/errors/types';
import { requirePermission } from '@/lib/security/permission-middleware';
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
    grantTimeBoundedAccess,
    readAccessAssignments,
    MAX_GRANT_DAYS as MAX_DAYS,
} from '@/app-layer/usecases/entra-grant-dispatch';
import type { RequestContext } from '@/app-layer/types';

type GrantParams = { tenantSlug: string };

export const GRANT_TOOL = 'grant_time_bounded_access';
export const READ_TOOL = 'read_access_assignments';

/**
 * The catalogue. Two tools, and the descriptions are part of the contract.
 *
 * `tools/list` is where a description is delivered into a model's context, and
 * it does its work there whether or not the tool is ever called — which is why
 * `McpToolManifestPin` hashes these and refuses a definition rewritten since a
 * human accepted it. So the wording below is pinned material, not prose: it
 * names the bound an operator approved rather than leaving the model to infer
 * that a grant is temporary.
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
                targetId: {
                    type: 'string',
                    description: "The subject's Entra object id (a GUID).",
                },
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
        // EXPLICIT false. See the header on why both tools declare.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    {
        name: READ_TOOL,
        description:
            'What one subject already holds of one access package, with the end date of any ' +
            'existing assignment. This is the prior-state read paired with the grant: it reports ' +
            'the state the grant would replace.',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['targetId', 'accessPackageId'],
            properties: {
                targetId: { type: 'string', description: "The subject's Entra object id." },
                accessPackageId: { type: 'string', description: 'The access package id.' },
            },
        },
        // MUST be true: `setPriorStateRead` refuses a read that is not declared
        // read-only, because pairing a write as the prior-state read would send
        // two changes per dispatch, the first of them unjournalled.
        annotations: { readOnlyHint: true },
    },
];

/** A refusal is an MCP result with `isError`, never a thrown 500. */
function refusal(text: string): McpToolResult {
    return { content: [{ type: 'text', text }], isError: true };
}

function ok(payload: unknown): McpToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : '';
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
            // `new Date(<anything>)` rather than a parse-or-throw, on purpose:
            // an unparseable value becomes an Invalid Date, and `expiryRefusal`
            // refuses that by name. Throwing here would turn an operator's typo
            // into a 500 instead of a sentence telling them what to fix.
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

    // An unknown name is an in-band refusal rather than a 404, so a client's MCP
    // session survives a typo. It also names nothing about what else exists.
    return refusal(`Unknown tool: ${name}`);
}

export const POST = withApiErrorHandling(
    requirePermission<GrantParams>('admin.tenant_lifecycle', async (req: NextRequest, _args, ctx) => {
        let payload: unknown;
        try {
            payload = await req.json();
        } catch {
            return jsonResponse(rpcError(null, RpcErrorCode.ParseError, 'Invalid JSON'), {
                status: 400,
            });
        }

        const handlers: McpHandlers = {
            // UNFILTERED, unlike `/api/mcp`'s catalogue, and that is correct
            // here: the agent-grant and manifest-pin filters belong to the
            // agent-facing server. The only caller of this endpoint is our own
            // dispatch, which has already resolved what it is allowed to send
            // before it opens a socket. A second catalogue filter here would be
            // a weaker copy of a gate that already ran.
            listTools: () => [...TOOLS],
            callTool: (name, args) => callTool(ctx, name, args),
            // NO RESOURCES, stated rather than omitted.
            //
            // `McpHandlers` requires these, and that turns out to be the right
            // shape: `dispatchMcp`'s `initialize` answers
            // `capabilities: { tools: {}, resources: {} }` unconditionally, so
            // this endpoint advertises a resources capability whether or not it
            // has one. Omitting the handlers was not available (it is a type
            // error), and defaulting them to the agent-facing server's would
            // have been much worse — `listMcpResources` reaches this tenant's
            // compliance data, which has nothing to do with a grant.
            //
            // So: an empty list, and a read that refuses by name. An empty list
            // is the honest answer to `resources/list`; the refusal is the
            // honest answer to a `resources/read` that should never arrive,
            // and it names the endpoint rather than the uri so a caller learns
            // nothing about what might exist elsewhere.
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

        // A batch of only notifications gets 202 and no body. Answering it with
        // `[]` would be a response to requests that carried no ids.
        if (responses.length === 0) return new Response(null, { status: 202 });

        return jsonResponse(Array.isArray(payload) ? responses : responses[0]);
    }),
);
