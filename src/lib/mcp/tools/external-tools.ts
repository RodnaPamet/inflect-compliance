/**
 * Tools on an EXTERNAL MCP server, presented as `McpReadTool`s so they enter
 * the one funnel and nothing about them is special at call time.
 *
 * ## Why they are resolved at ASSEMBLY, not at call time
 *
 * `McpInvocation.offeredTools` is a snapshot, and `loadable-tools.ts` states the
 * property it buys: "resolution enumerates THIS, never the live registry, so a
 * tool that enters the registry after assembly is not loadable by an invocation
 * already in flight". An external catalogue is the case that property was
 * waiting for — it is not this build's, and the person who can change it is not
 * us. Resolving here means one `tools/list` per connection at the start of a
 * run, and a set that cannot grow underneath the run afterwards.
 *
 * ## The pin is checked HERE, against text fetched HERE
 *
 * `McpToolManifestPin` stores hashes and no text at all, so an adapter cannot be
 * built from a pin — the model needs the description and the schema, which only
 * the server has. That turns out to be the right shape: the definition is
 * fetched, hashed, and compared to what a human accepted, at the moment the run
 * starts. A description rewritten since approval is refused before the model
 * ever reads it, which is the whole reason the pin exists.
 *
 * A tool is offered only if all four are true: the agent is GRANTED it, a pin is
 * ON FILE, the live definition MATCHES that pin, and the connection is enabled.
 * Anything else and the tool is simply absent — the funnel's own deny-by-default
 * shape, and `resolveOfferedTool` writes the refusal row if the model tries it
 * anyway.
 *
 * ## An unreachable server loses its tools, not the run
 *
 * A connection that will not answer contributes nothing and does not throw. The
 * alternative — failing the whole invocation — would let any third party stop
 * an agent from doing its unrelated internal work by going down, which hands an
 * outsider a denial-of-service on our own runs. An agent left with no tools at
 * all is already handled: the engine records `flue_no_tools_granted` rather than
 * reporting a conclusion drawn from nothing.
 */
import { z } from 'zod';

import { callTool } from '@/app-layer/integrations/mcp/client';
import { resolveGrantedExternalTools } from '@/app-layer/usecases/external-mcp-tools';
import type { RequestContext } from '@/app-layer/types';

import type { McpReadTool } from './types';

/**
 * The permission a CALLING credential must hold. Not `admin.manage`, which owns
 * the connection: that is the authority to rewire what an agent calls, and
 * requiring it here would hand every calling agent CRUD over every integration
 * the tenant has. See the key's own docstring.
 */
export const EXTERNAL_TOOL_PERMISSION = 'admin.agent_external_tools';

/** Upper bound on tools considered per connection, mirroring the catalogue's. */
const MAX_TOOLS_PER_CONNECTION = 250;

/**
 * Arguments are accepted as a plain object and validated BY THE FAR END.
 *
 * The server publishes JSON Schema; this file does not translate it into Zod.
 * A translation would be a second, weaker copy of somebody else's contract, and
 * the failure mode is ugly in both directions — too strict and we refuse calls
 * the server would have accepted, too loose and we have validated nothing while
 * appearing to. What IS pinned is the schema's HASH, so the declared contract
 * cannot change under an approval without the tool being refused.
 *
 * Nothing rides on this being permissive: the arguments go out through
 * `findInternalSecret`, which refuses to send our ciphertext or an API key
 * whatever shape they arrive in.
 */
const EXTERNAL_ARGS_SCHEMA = z.record(z.string(), z.unknown());

/**
 * Build the external read tools this invocation may load.
 *
 * The resolving — connections, pins, the live `tools/list`, the drift verdict —
 * is the usecase's, and deliberately so: `mcp-server-coverage` holds every tool
 * file to going through a usecase and never touching Prisma, which is the
 * cross-tenant-leak lock rather than a matter of taste. What is left here is
 * the only thing this layer should own: the shape the funnel expects.
 *
 * Returns `[]` — with no query and no network — when the agent holds no
 * external grants, which is every invocation today and most of them after.
 */
export async function resolveExternalReadTools(
    ctx: RequestContext,
    grantedTools: ReadonlySet<string> | null,
): Promise<McpReadTool<Record<string, unknown>>[]> {
    const granted = await resolveGrantedExternalTools(ctx, grantedTools);
    return granted.map((g) => adapterFor(g.qualified, g.def, g.transport));
}

/** One approved external tool, in the shape the funnel already knows. */
function adapterFor(
    qualified: string,
    def: { name: string; description: string; inputSchema: Record<string, unknown> },
    transport: { url: string; authorization?: string },
): McpReadTool<Record<string, unknown>> {
    return {
        name: qualified,
        description: def.description,
        inputSchema: def.inputSchema,
        argsSchema: EXTERNAL_ARGS_SCHEMA,
        resourceScope: { resource: 'external_tools', action: 'read' },
        authorize: {
            keys: [EXTERNAL_TOOL_PERMISSION],
            basis: 'effective',
            /**
             * Rung 2, DECLARED rather than inherited, and this is not a detail.
             *
             * `runReadTool` passes `capabilityClass: 'read'` as a literal for
             * every tool it runs, so without this an external call would need
             * rung 1 at CALL time — while the grant surface advertises rung 2
             * for it, because `mcpToolCapabilityClass` answers `propose` for a
             * name this build does not know. A screen promising one rung and a
             * funnel enforcing a lower one is the kind of disagreement nobody
             * finds until it matters.
             *
             * Rung 2 is also the honest number on its own terms: leaving the
             * platform boundary is more autonomous than reading a row of our
             * own, whatever the call is shaped like.
             */
            autonomy: 2,
            // Stated explicitly because the field requires it of a tool with no
            // human equivalent — and this one has none by construction: it
            // belongs to somebody else's deployment, which is the whole reason
            // it carries its own permission key.
            mirrors: 'no human route — the tool is served by an external MCP server',
        },
        run: async (_ctx, args) => {
            // `callTool` is the one outbound seam and it scans these arguments
            // before a socket is opened. Nothing is added here: a second check
            // in a per-tool wrapper would be the copy that drifts.
            return callTool(transport, def.name, args ?? {});
        },
    };
}
