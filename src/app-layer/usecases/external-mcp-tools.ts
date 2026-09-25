/**
 * The catalogue of tools an EXTERNAL MCP server advertises, with its pin state.
 *
 * ## Why this is a separate usecase and not a branch of `listToolManifests`
 *
 * That one is driven by `allToolDefinitions()` — a build-time constant, free to
 * read, identical for every tenant. This one is driven by a NETWORK CALL to a
 * server the tenant configured, using the tenant's credential, and its answer
 * is true only at the moment it is asked. They share the verdict (via
 * `manifestStateOf`) and nothing else.
 *
 * ## The pin matters MORE here, not less
 *
 * A description is instruction text delivered straight to the model. For our
 * own tools that text changes only when we deploy. For an external server it
 * can change between two calls, with no deploy, entirely under the control of
 * whoever runs it — which is the exact scenario `McpToolManifestPin` exists
 * for. So an external tool is baselined on first sight and refused on drift
 * until a human accepts the new text, by the same rule and the same verdict as
 * a built-in.
 *
 * ## What this does NOT do
 *
 * It does not write pins, and it does not make anything callable. Listing is a
 * read; baselining is a write with an approver's name on it, and granting is a
 * separate deny-by-default act on the agent. Keeping them apart is what stops
 * "an admin opened the catalogue page" from becoming "the agent may now call
 * whatever that server advertises".
 *
 * Nothing here writes a description to an audit row, a log line or a
 * notification — the rule `mcp-tool-manifest.ts` states, for the same reason,
 * and more sharply because this text is not ours.
 */
import { decryptField } from '@/lib/security/encryption';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { listTools } from '@/app-layer/integrations/mcp/client';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import { externalToolName, EXTERNAL_TOOL_PREFIX } from '@/lib/mcp/external-tool-name';
import type { ApprovedToolManifest } from '@/lib/mcp/tool-manifest';

import { assertCanAdmin } from '../policies/common';
import { manifestStateOf, type ToolManifestState } from './mcp-tool-manifest';
import type { RequestContext } from '../types';

/**
 * How many advertised tools this will consider.
 *
 * The transport already bounds the RESPONSE in bytes, which stops a server
 * exhausting memory, but a server that advertises ten thousand small tools
 * would still produce ten thousand pin comparisons and a page nobody can read.
 * A catalogue longer than this is not a catalogue an operator can meaningfully
 * approve, so it is truncated and the caller is told.
 */
export const MAX_EXTERNAL_TOOLS = 250;

export interface ExternalToolCatalogue {
    connectionId: string;
    /** The tools, qualified and verdicted, in the order the server listed them. */
    tools: ExternalToolManifestState[];
    /** How many the server advertised, which may exceed what `tools` holds. */
    advertised: number;
    /** True when `advertised` exceeded the cap and `tools` is a prefix. */
    truncated: boolean;
}

export interface ExternalToolManifestState extends ToolManifestState {
    connectionId: string;
    /** The name the server used. `toolName` is the qualified name we key on. */
    advertisedName: string;
}

/**
 * Read one external server's catalogue.
 *
 * ADMIN, deliberately stricter than the built-in equivalent's `assertCanRead`:
 * this reaches out of the deployment on request, using a stored credential, to
 * an address a tenant chose. That is an outbound action with a side effect on
 * somebody else's system (their logs, their rate limits), and it returns
 * instruction text from a third party. None of that is a plain read.
 */
export async function listExternalMcpTools(
    ctx: RequestContext,
    connectionId: string,
): Promise<ExternalToolCatalogue> {
    assertCanAdmin(ctx);

    const connection = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: {
                id: connectionId,
                tenantId: ctx.tenantId,
                provider: MCP_SERVER_PROVIDER_ID,
                isEnabled: true,
            },
            select: { id: true, configJson: true, secretEncrypted: true },
        }),
    );
    if (!connection) throw notFound('MCP server connection not found');

    const config = (connection.configJson ?? {}) as { url?: unknown };
    const url = typeof config.url === 'string' ? config.url.trim() : '';
    if (!url) throw notFound('MCP server connection has no URL configured');

    const secrets = connection.secretEncrypted
        ? (JSON.parse(decryptField(connection.secretEncrypted)) as Record<string, unknown>)
        : {};
    const authorization =
        typeof secrets.authorization === 'string' && secrets.authorization.trim()
            ? secrets.authorization.trim()
            : undefined;

    const advertised = await listTools({ url, authorization });
    const considered = advertised.slice(0, MAX_EXTERNAL_TOOLS);

    // One query for every pin this connection owns, rather than one per tool.
    // Scoped by the qualified PREFIX so another connection's pins — same tool
    // names, different server — cannot be read as this one's.
    const pins = await runInTenantContext(ctx, (db) =>
        db.mcpToolManifestPin.findMany({
            where: {
                tenantId: ctx.tenantId,
                toolName: { startsWith: `${EXTERNAL_TOOL_PREFIX}${connectionId}__` },
            },
            take: MAX_EXTERNAL_TOOLS,
            select: {
                toolName: true,
                descriptionHash: true,
                schemaHash: true,
                manifestHash: true,
                revision: true,
                approvedByUserId: true,
                approvalSource: true,
                approvedAt: true,
            },
        }),
    );
    const byName = new Map(pins.map((p) => [p.toolName, p]));

    const tools = considered.map((t) => {
        const qualified = externalToolName(connectionId, t.name);
        // Hashed under the name the SERVER used: the attestation is about what
        // the far end said, not about our naming scheme. Keyed, and therefore
        // pinned and granted, under the qualified name.
        const def = {
            name: t.name,
            description: t.description ?? '',
            inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
        };
        const pin = (byName.get(qualified) ?? null) as ApprovedToolManifest | null;
        return {
            ...manifestStateOf(def, pin, qualified),
            connectionId,
            advertisedName: t.name,
        };
    });

    return {
        connectionId,
        tools,
        advertised: advertised.length,
        truncated: advertised.length > considered.length,
    };
}
