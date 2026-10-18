/**
 * Which API-key scopes admit a caller to `/api/mcp` at all.
 *
 * `mcp:read` and `mcp:propose` are CAPABILITY scopes: they map to no
 * `PermissionSet` flag and only answer "may this key talk to MCP". `*` and
 * `mcp:*` carry both. `mcp:orchestrate` is deliberately absent — it narrows what
 * an admitted key may do and admits nothing on its own.
 *
 * One definition, because two readers depend on it agreeing: the endpoint gate
 * in `mcp/auth.ts` (both the tool call and the token exchange) and the
 * credential hygiene pass, which treats a key the gate would admit as an agent
 * credential. If the hygiene pass spelled its own list, a scope added to the
 * gate would admit keys the hygiene pass never looks at.
 *
 * Pure, with no imports, so the hygiene planner can hold it.
 *
 * @module lib/mcp/endpoint-scope
 */

export const MCP_ENDPOINT_SCOPES: readonly string[] = ['*', 'mcp:*', 'mcp:read', 'mcp:propose'];

/** Would the `/api/mcp` capability gate admit a key carrying these scopes? */
export function admitsMcpEndpoint(scopes: readonly string[]): boolean {
    return scopes.some((scope) => MCP_ENDPOINT_SCOPES.includes(scope));
}
