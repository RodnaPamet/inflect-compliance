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
    'get_discovered_agent',
    'get_harness_register',
    'get_agent_recertification_evidence',
    'list_audit_workpapers',
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

/**
 * Which AUTONOMY class a tool call falls in — `read` (rung 1) or `propose`
 * (rung 2).
 *
 * Derived from list membership rather than imported from the registries,
 * because that is exactly what the registries do: `runReadTool` passes
 * `capabilityClass: 'read'` and `runProposeTool` passes `'propose'`, both as
 * literals over the whole list. So the list a name is in IS its class, and
 * `tests/guards/mcp-tools-use-shared-authz.test.ts` already pins each list
 * against the registry it mirrors.
 *
 * An unknown name answers `propose` — the higher rung. Callers use this to
 * decide whether an agent's tier could ever exercise a grant, and a name this
 * build does not recognise must not be waved through as the cheaper class.
 * `authorizeToolCall` remains the enforcement on every actual call; this is a
 * pre-check at the moment a grant is written, and a tool that declares its own
 * higher `autonomy` override is caught there rather than here.
 */
export function mcpToolCapabilityClass(name: string): 'read' | 'propose' {
    return MCP_READ_TOOL_NAMES.includes(name as (typeof MCP_READ_TOOL_NAMES)[number])
        ? 'read'
        : 'propose';
}

/**
 * The API-key scope each tool checks at `/api/mcp`, IN ADDITION to `mcp:read`
 * or `mcp:propose` (the tool's `resourceScope`, written `<resource>:<action>`).
 *
 * Here, as a copy, for the same reason the names are: the connect wizard on an
 * agent's page (#4155) mints a key carrying exactly the scopes its agent's
 * grants need, and a client component cannot import the registries.
 * `tests/unit/mcp-tool-key-scopes.test.ts` asserts this map equals every
 * registry definition's `resourceScope`, so the copy cannot drift: a key
 * minted from a stale map would be refused the tool it was minted for.
 */
export const MCP_TOOL_KEY_SCOPE: Readonly<
    Record<(typeof MCP_READ_TOOL_NAMES)[number] | (typeof MCP_PROPOSE_TOOL_NAMES)[number], string>
> = {
    get_compliance_posture: 'controls:read',
    get_tenant_context: 'controls:read',
    list_risks: 'risks:read',
    list_controls: 'controls:read',
    search_controls: 'controls:read',
    find_coverage_gaps: 'frameworks:read',
    get_framework_status: 'frameworks:read',
    list_evidence_expiring: 'evidence:read',
    list_findings: 'audits:read',
    list_tasks: 'tasks:read',
    get_discovered_agent: 'admin:agent_registry_view',
    get_harness_register: 'admin:harness_ingest',
    get_agent_recertification_evidence: 'access_reviews:read',
    list_audit_workpapers: 'audits:workpaper_view',
    propose_risks: 'risks:read',
    propose_controls: 'controls:read',
    draft_policy: 'policies:read',
    propose_finding: 'audits:read',
};

/**
 * The scope every granted external tool (`mcp__<connection>__<tool>`) checks:
 * `admin:external_tools`, which also carries the permission the call needs
 * (#4485). A copy of `EXTERNAL_TOOL_RESOURCE_SCOPE`, held equal by the same test.
 */
export const EXTERNAL_TOOL_KEY_SCOPE = 'admin:external_tools';
