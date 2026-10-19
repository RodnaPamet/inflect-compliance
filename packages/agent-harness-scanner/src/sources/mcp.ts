/**
 * THE MCP SOURCE — `mcp` (#3686, owner decisions 2026-10-19).
 *
 * Each configured MCP server is asked what it serves, and nothing else:
 * `initialize`, the one-way `notifications/initialized` the protocol requires,
 * and `tools/list`, paged (DPIA condition 1, amended by owner decision 5). The
 * wire it holds (`McpListingWire`) has no way to spell `tools/call`, and a
 * test holds the request log to those three messages.
 *
 * WHICH AGENT A SERVER'S TOOLS BELONG TO (owner decision 2). Neither answer
 * names a caller, so a server's tools reach an agent two ways:
 *
 *   • the estate's configuration lists, per server, the agents that use it
 *     (`agents`, by `discoveredId`) — this source reports each with the
 *     server's tools;
 *   • another source reported a `<key>:*` placeholder for the same server URL
 *     — the `code` source does, for a tool set its agent fetches at run time —
 *     and the report builder replaces it with the tools this source read
 *     (`mcpServers`, servers read in full only).
 *
 * WHAT A TOOL CARRIES. Its name (by digest when it is not an identifier), the
 * server's configured URL, `readOnlyHint` as the server's annotations declare
 * it (`null` when they do not, which the contract counts as a write), and
 * `manifestHash`: SHA-256 over the canonical JSON of the tool's definition as
 * served. The definition's text — description, schemas — never leaves this
 * module; the hash stands for it. `pinned` is true only when the server's
 * configured `pinnedManifestHash` equals the hash of its whole listing read
 * live (SHA-256 over each tool's name and hash, in name order), so a server
 * whose tools changed after the estate pinned them reads as unpinned.
 *
 * AUTHENTICATION (owner decision 6). A server may take a read token, named by
 * an environment variable and sent as a bearer token with the three messages
 * above and nothing else. For Inflect's own `/api/mcp` that is a key holding
 * `mcp:read` only. A configured token that is missing from the environment
 * makes that server unread (`AUTH_FAILED`), and the other servers are still
 * read.
 *
 * Every server is a host the customer names, so it is checked as the
 * self-hosted LangSmith is (`customer-host.ts`): at configuration, and again
 * before every request. The source is COMPLETE only when every server was read
 * to the end of its listing; the first reason a server stopped is the source's.
 */
import { createHash } from 'crypto';

import { canonicalJson } from '@/lib/canonical-json';
import { MAX_AGENTS, MAX_TOOLS_PER_AGENT } from '@/lib/agentic/harness-contract';

import {
    assertResolvesReachable,
    parsePrivateCidrAllowlist,
    resolveWithDns,
    type PrivateCidrAllowlist,
    type ResolveHost,
} from '../customer-host';
import type { McpSession } from '../http';
import {
    MAX_PAGES_PER_SOURCE,
    sourceResult,
    SourceReadError,
    type HarnessSource,
    type McpServerRead,
    type Observation,
    type ObservedTool,
    type SourceContext,
    type SourceRead,
} from '../source';
import { reportableToolName } from './langsmith';

export interface McpServerOptions {
    /** The estate's own name for the server: logged, never reported. */
    readonly label: string;
    /** The Streamable HTTP endpoint, https. */
    readonly url: string;
    /** The agents that use this server, by `discoveredId`. */
    readonly agents: readonly string[];
    /** `sha256:` of the listing the estate pinned, when it pinned one. */
    readonly pinnedManifestHash: string | null;
    /** The read token: a value, none, or configured but missing from the environment. */
    readonly token: { readonly value: string } | null | 'MISSING';
    readonly egressPrivateCidrAllowlist: readonly string[];
}

export interface McpSourceOptions {
    readonly servers: readonly McpServerOptions[];
    /** How each server's host is re-resolved before each request. DNS unless a test passes its own. */
    readonly resolveHost?: ResolveHost;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** The manifest hash of one tool definition, as served. */
export function mcpToolHash(definition: unknown): string {
    return `sha256:${sha256(canonicalJson(definition))}`;
}

/** The manifest hash of a server's whole listing: each tool's name and hash, in name order. */
export function mcpListingHash(tools: readonly { readonly name: string; readonly manifestHash: string }[]): string {
    const entries = [...tools].map((t) => [t.name, t.manifestHash]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `sha256:${sha256(canonicalJson(entries))}`;
}

/** `readOnlyHint` as the definition's annotations declare it; `null` when they do not. */
function readOnlyHintOf(definition: Record<string, unknown>): boolean | null {
    const annotations = definition.annotations;
    if (annotations === null || typeof annotations !== 'object') return null;
    const hint = (annotations as { readOnlyHint?: unknown }).readOnlyHint;
    return typeof hint === 'boolean' ? hint : null;
}

export function mcpSource(opts: McpSourceOptions): HarnessSource {
    const resolve = opts.resolveHost ?? resolveWithDns;

    return {
        kind: 'mcp',
        product: 'mcp',
        async read(ctx: SourceContext): Promise<SourceRead> {
            const observations: Observation[] = [];
            const fullyRead: McpServerRead[] = [];
            let rows = 0;
            let stoppedBy: unknown = null;

            for (const server of opts.servers) {
                const allowlist: PrivateCidrAllowlist = parsePrivateCidrAllowlist(server.egressPrivateCidrAllowlist) ?? [];
                const hostname = new URL(server.url).hostname;
                const guard = () => assertResolvesReachable(hostname, resolve, allowlist);
                // Tools read so far from this server, by name: what WAS read is real.
                const byName = new Map<string, ObservedTool>();
                const hashes: { name: string; manifestHash: string }[] = [];
                let complete = false;
                try {
                    if (server.token === 'MISSING') throw new SourceReadError('AUTH_FAILED', 'the read token is not set');
                    const headers: Record<string, string> =
                        server.token === null ? {} : { Authorization: `Bearer ${server.token.value}` };
                    await guard();
                    const session: McpSession = await ctx.mcp.open({ url: server.url, headers });
                    if (session.offersTools) {
                        const seen = new Set<string>();
                        let cursor: string | null = null;
                        let pages = 0;
                        do {
                            if (cursor !== null && seen.has(cursor)) {
                                throw new SourceReadError('PAGINATION_TORN', 'the listing returned a cursor it had served');
                            }
                            if (pages >= MAX_PAGES_PER_SOURCE) throw new SourceReadError('BYTE_CAP', 'the listing ran past the page cap');
                            if (cursor !== null) seen.add(cursor);
                            pages += 1;
                            await guard();
                            const page = await ctx.mcp.listTools(session, cursor);
                            for (const raw of page.tools) {
                                rows += 1;
                                if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
                                    throw new SourceReadError('PAGINATION_TORN', 'a listed tool was not an object');
                                }
                                const definition = raw as Record<string, unknown>;
                                if (typeof definition.name !== 'string' || definition.name === '') {
                                    throw new SourceReadError('PAGINATION_TORN', 'a listed tool had no name');
                                }
                                const name = reportableToolName(definition.name);
                                if (byName.has(name)) throw new SourceReadError('PAGINATION_TORN', 'the listing named one tool twice');
                                if (byName.size >= MAX_TOOLS_PER_AGENT) {
                                    throw new SourceReadError('BYTE_CAP', 'more tools than one agent may carry');
                                }
                                const manifestHash = mcpToolHash(definition);
                                hashes.push({ name, manifestHash });
                                byName.set(name, {
                                    server: server.url,
                                    name,
                                    manifestHash,
                                    pinned: false,
                                    readOnlyHint: readOnlyHintOf(definition),
                                });
                            }
                            cursor = page.nextCursor;
                        } while (cursor !== null);
                    }
                    complete = true;
                } catch (err) {
                    if (stoppedBy === null) stoppedBy = err;
                }

                // Pinned only against the whole listing, read live: a partial one
                // cannot match a pin, and is never resolved into a placeholder.
                const listingHash = mcpListingHash(hashes);
                const pinned = complete && server.pinnedManifestHash !== null && server.pinnedManifestHash === listingHash;
                const tools = [...byName.values()]
                    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
                    .map((t) => ({ ...t, pinned }));
                if (complete) fullyRead.push({ label: server.label, url: server.url, manifestHash: listingHash, tools });
                for (const discoveredId of server.agents) {
                    if (observations.length >= MAX_AGENTS) {
                        if (stoppedBy === null) stoppedBy = new SourceReadError('BYTE_CAP', 'more agents than one report may carry');
                        break;
                    }
                    observations.push({
                        discoveredId,
                        owner: null,
                        credentials: [],
                        verdicts: [],
                        tools: tools.map((tool) => ({ tool })),
                    });
                }
            }

            return { ...sourceResult('mcp', rows, observations, stoppedBy), mcpServers: fullyRead };
        },
    };
}
