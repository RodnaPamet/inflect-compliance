/**
 * Deny-by-default MCP tool exposure — which tools a registered agent may reach.
 *
 * ## The rule
 *
 * A tool is reachable only if the agent's registration lists it. The server
 * offering a tool is not permission to call it, and an agent with no grants can
 * call nothing. `RegisteredAgentTool` is that list; there is no wildcard row and
 * no "all tools" flag, because the value of an allowlist is entirely in not
 * having one.
 *
 * ## Where it does NOT apply, and why that is not a hole
 *
 * The allowlist is a property of an AGENT. A credential bound to no agent has no
 * list to consult, and there are exactly two ways to be in that state:
 *
 *   • the tenant has `requireRegisteredAgent` ON (the default, including every
 *     new tenant) — then `assertRegisteredAgent` already refused the request
 *     before this code runs, so an unbound credential never gets here;
 *   • the tenant has explicitly turned the register OFF — then it has opted out
 *     of the register wholesale, and the credential is gated by its scopes and
 *     its principal's permissions exactly as it was before the register existed.
 *
 * Applying an empty allowlist to the second case would mean "turning the
 * register off turns MCP off", which is the composition failure #2288's sibling
 * commit already had to undo once: two individually correct defaults meeting to
 * produce a third behaviour neither intended. The register's switch controls the
 * register; it must not silently double as a kill switch for the product.
 *
 * ## Freshness
 *
 * Read per HTTP request, not cached. A revoke has to take effect on the next
 * request — a cache here would put a TTL between an operator revoking a tool and
 * the agent stopping, and the whole point of the register is that its controls
 * are immediate.
 */
import prisma from '@/lib/prisma';

/**
 * The tool names granted to one agent. An EMPTY SET IS THE CORRECT ANSWER for
 * an agent nobody has granted anything to — callers must treat it as "no tools",
 * never as "unset, so allow".
 */
export async function listGrantedToolNames(
    tenantId: string,
    agentId: string,
): Promise<Set<string>> {
    const rows = await prisma.registeredAgentTool.findMany({
        where: { tenantId, agentId },
        select: { toolName: true },
        // Bounded: the catalogue is a handful of tools, and a tenant that has
        // somehow accumulated more grants than that has a bug worth noticing
        // rather than a page worth loading.
        take: 200,
    });
    return new Set(rows.map((r) => r.toolName));
}
