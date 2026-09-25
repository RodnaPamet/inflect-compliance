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
import { z } from 'zod';

import { decryptField } from '@/lib/security/encryption';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import { listTools } from '@/app-layer/integrations/mcp/client';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import { logger } from '@/lib/observability/logger';
import {
    externalToolName,
    EXTERNAL_TOOL_PREFIX,
    parseExternalToolName,
} from '@/lib/mcp/external-tool-name';
import { verifyToolManifest, type ApprovedToolManifest } from '@/lib/mcp/tool-manifest';

import { assertCanAdmin } from '../policies/common';
import {
    manifestStateOf,
    writeToolManifestPin,
    type ApproveToolManifestResult,
    type ToolManifestState,
} from './mcp-tool-manifest';
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

// ── Approve ─────────────────────────────────────────────────────────────────

export const ApproveExternalToolSchema = z
    .object({
        connectionId: z.string().min(1),
        /** The name the SERVER advertises, not the qualified one. */
        toolName: z.string().min(1),
        /**
         * The hash the operator reviewed. Required for the reason the built-in
         * path requires it: an endpoint taking only a name would approve
         * whatever the server says at the moment the request lands, including a
         * definition that changed between the operator reading it and clicking.
         *
         * The argument is STRONGER here. For a built-in, the window is a
         * deploy. For an external server, the text can change between the two
         * calls this request itself makes, at the choosing of whoever runs it.
         */
        expectedManifestHash: z.string().min(1),
    })
    .strict();

export type ApproveExternalToolInput = z.infer<typeof ApproveExternalToolSchema>;

/**
 * Accept an external tool's CURRENT definition — baseline, or re-approval after
 * drift.
 *
 * Re-reads the catalogue rather than trusting anything the caller sent beyond
 * the hash: the definition being pinned has to be one this deployment observed
 * itself, or the pin attests a description nobody here ever saw.
 *
 * The pin is written by `writeToolManifestPin`, the same function the built-in
 * path uses, under the QUALIFIED name. That is deliberate — a second write path
 * for external tools would be a second, quieter way to clear a refusal.
 */
export async function approveExternalToolManifest(
    ctx: RequestContext,
    input: unknown,
): Promise<ApproveToolManifestResult> {
    assertCanAdmin(ctx);

    const parsed = ApproveExternalToolSchema.safeParse(input);
    if (!parsed.success) {
        throw badRequest('Invalid external tool approval', parsed.error.flatten());
    }
    const { connectionId, toolName, expectedManifestHash } = parsed.data;

    // `userId` is what the accountability column exists for. Unreachable
    // through the route, checked anyway: the column's whole value is that it is
    // never null on an APPROVED row.
    if (!ctx.userId) {
        throw badRequest('An approving user is required');
    }

    const { tools, truncated } = await listExternalMcpTools(ctx, connectionId);
    const tool = tools.find((t) => t.advertisedName === toolName);
    if (!tool) {
        // Either the server stopped advertising it, or it sits past the cap. The
        // two are told apart because "approve something you cannot see" and
        // "approve something that is gone" call for different actions.
        throw notFound(
            truncated
                ? `"${toolName}" is not among the first ${MAX_EXTERNAL_TOOLS} tools this ` +
                  'server advertises, so it cannot be reviewed or approved here.'
                : `The server no longer advertises a tool named "${toolName}"`,
        );
    }

    if (tool.liveManifestHash !== expectedManifestHash) {
        throw badRequest(
            'The tool definition changed since it was reviewed. Re-read the current ' +
                'definition and approve that hash.',
        );
    }

    return runInTenantContext(ctx, (db) =>
        writeToolManifestPin(
            db,
            ctx,
            tool.toolName,
            {
                descriptionHash: tool.liveDescriptionHash,
                schemaHash: tool.liveSchemaHash,
                manifestHash: tool.liveManifestHash,
            },
            ctx.userId as string,
        ),
    );
}

// ── Runtime resolution ──────────────────────────────────────────────────────

/**
 * One external tool an agent may actually load: the definition the server is
 * serving RIGHT NOW, already checked against the pin a human approved, with the
 * transport to reach it.
 *
 * Definitions rather than tools, deliberately. The data access lives here
 * because `tests/guardrails/mcp-server-coverage.test.ts` holds the MCP surface
 * to one rule — a tool file goes through a usecase and never touches Prisma —
 * and that rule is the cross-tenant-leak lock, not a style preference. The
 * `McpReadTool` shape is assembled next door in `lib/mcp/tools/external-tools.ts`
 * from what this returns.
 */
export interface GrantedExternalTool {
    /** `mcp__<connectionId>__<toolName>` — our key for grants and pins. */
    qualified: string;
    /** Exactly what the server advertised, under the name IT used. */
    def: { name: string; description: string; inputSchema: Record<string, unknown> };
    transport: { url: string; authorization?: string };
    /**
     * The tenant's APPROVED parameter sets for this tool, if any.
     *
     * Only what is in force — a pending edit is not here, because the agent
     * keeps dispatching what a human accepted until somebody accepts the
     * change. Empty means the tenant has saved nothing and the model supplies
     * arguments itself, which is every external tool until somebody saves one.
     */
    parameterSets: ReadonlyArray<{ label: string; parameters: Record<string, unknown> }>;
}

/** Upper bound on tools considered per connection, mirroring the catalogue's. */
const MAX_TOOLS_PER_CONNECTION = 250;

interface ConnectionRow {
    id: string;
    configJson: unknown;
    secretEncrypted: string | null;
}

/**
 * Build the external read tools this invocation may load.
 *
 * Returns `[]` — with no query and no network — when the agent holds no
 * external grants, which is every invocation today and most of them after.
 */
export async function resolveGrantedExternalTools(
    ctx: RequestContext,
    grantedTools: ReadonlySet<string> | null,
): Promise<GrantedExternalTool[]> {
    if (!grantedTools || grantedTools.size === 0) return [];

    const wanted = new Map<string, Set<string>>();
    for (const name of grantedTools) {
        const ref = parseExternalToolName(name);
        if (!ref) continue;
        const forConn = wanted.get(ref.connectionId) ?? new Set<string>();
        forConn.add(ref.toolName);
        wanted.set(ref.connectionId, forConn);
    }
    if (wanted.size === 0) return [];

    const connectionIds = [...wanted.keys()];
    const { connections, pins, parameterSets } = await runInTenantContext(ctx, async (db) => ({
        connections: (await db.integrationConnection.findMany({
            where: {
                id: { in: connectionIds },
                tenantId: ctx.tenantId,
                provider: MCP_SERVER_PROVIDER_ID,
                isEnabled: true,
            },
            select: { id: true, configJson: true, secretEncrypted: true },
        })) as ConnectionRow[],
        // The approved sets for the granted tools. `parameters` only — the
        // pending columns are deliberately NOT selected, so a proposal cannot
        // reach a run even by accident.
        parameterSets: await db.externalToolParameterSet.findMany({
            where: { tenantId: ctx.tenantId, toolName: { in: [...grantedTools] } },
            orderBy: { label: 'asc' },
            take: 500,
            select: { toolName: true, label: true, parameters: true },
        }),
        pins: await db.mcpToolManifestPin.findMany({
            where: { tenantId: ctx.tenantId, toolName: { in: [...grantedTools] } },
            select: {
                toolName: true,
                descriptionHash: true,
                schemaHash: true,
                manifestHash: true,
                revision: true,
                approvedByUserId: true,
                approvalSource: true,
            },
        }),
    }));

    const pinByName = new Map(pins.map((p) => [p.toolName, p as ApprovedToolManifest]));
    const setsByTool = new Map<string, { label: string; parameters: Record<string, unknown> }[]>();
    for (const row of parameterSets) {
        const list = setsByTool.get(row.toolName) ?? [];
        list.push({ label: row.label, parameters: (row.parameters ?? {}) as Record<string, unknown> });
        setsByTool.set(row.toolName, list);
    }
    const out: GrantedExternalTool[] = [];

    for (const connection of connections) {
        const config = (connection.configJson ?? {}) as { url?: unknown };
        const url = typeof config.url === 'string' ? config.url.trim() : '';
        if (!url) continue;

        const secrets = connection.secretEncrypted
            ? (JSON.parse(decryptField(connection.secretEncrypted)) as Record<string, unknown>)
            : {};
        const authorization =
            typeof secrets.authorization === 'string' && secrets.authorization.trim()
                ? secrets.authorization.trim()
                : undefined;

        let advertised;
        try {
            advertised = await listTools({ url, authorization });
        } catch (err) {
            // Named, never quoted: an error from somebody else's server is text
            // we did not write, and this line is read by operators.
            logger.warn('mcp.external_catalogue_unreachable', {
                connectionId: connection.id,
                error: err instanceof Error ? err.name : 'non-Error thrown',
            });
            continue;
        }

        const asked = wanted.get(connection.id) ?? new Set<string>();
        for (const descriptor of advertised.slice(0, MAX_TOOLS_PER_CONNECTION)) {
            if (!asked.has(descriptor.name)) continue;

            const qualified = externalToolName(connection.id, descriptor.name);
            const def = {
                name: descriptor.name,
                description: descriptor.description ?? '',
                inputSchema: (descriptor.inputSchema ?? {}) as Record<string, unknown>,
            };
            const verdict = verifyToolManifest(def, pinByName.get(qualified) ?? null);
            if (verdict.status !== 'APPROVED') {
                logger.warn('mcp.external_tool_refused_on_manifest', {
                    connectionId: connection.id,
                    tool: qualified,
                    status: verdict.status,
                });
                continue;
            }

            out.push({
                qualified,
                def,
                transport: { url, authorization },
                parameterSets: setsByTool.get(qualified) ?? [],
            });
        }
    }

    return out;
}
