/**
 * The MCP tool catalogue, as a LEAF module.
 *
 * `registry.ts` and `propose-tools.ts` are the definitions, but importing either
 * one pulls in every read and propose usecase behind it. The admin surface that
 * grants a tool to an agent needs only the NAMES, and dragging the whole tool
 * graph into an admin route to learn eleven strings is how a route acquires a
 * dependency on the dashboard cache, the search index and the proposal queue.
 *
 * So the names live here with no imports at all, and
 * `tests/guards/mcp-tools-use-shared-authz.test.ts` asserts this list is exactly
 * what the two registries actually export. A tool added to the registry and not
 * here would be ungrantable — reachable by nobody, silently — which is the
 * failure a catalogue copy invites and the reason the equality is pinned rather
 * than trusted.
 */

/** Read tools — `registry.ts`'s `READ_TOOLS`, by name. */
export const MCP_READ_TOOL_NAMES = [
    'get_compliance_posture',
    'get_tenant_context',
    'list_risks',
    'list_controls',
    'search_controls',
    'find_coverage_gaps',
    'get_framework_status',
    'list_evidence_expiring',
    'list_findings',
    'list_tasks',
] as const;

/** Propose tools — `propose-tools.ts`'s `PROPOSE_TOOLS`, by name. */
export const MCP_PROPOSE_TOOL_NAMES = [
    'propose_risks',
    'propose_controls',
    'draft_policy',
    'propose_finding',
] as const;

export const MCP_TOOL_NAMES: readonly string[] = [
    ...MCP_READ_TOOL_NAMES,
    ...MCP_PROPOSE_TOOL_NAMES,
];

export function isKnownMcpTool(name: string): boolean {
    return MCP_TOOL_NAMES.includes(name);
}
