/**
 * WHERE AN AGENT OPENS ON THE CANVAS (Phase 2.3 of
 * `docs/ai-architecture/langflow.md`).
 *
 * Plain strings, and nothing else. The agent page, its Behaviour tab and a
 * process map's `agent` step all link into the processes segment through this
 * file, and none of them imports the canvas: the licensed editor ships only in
 * that segment's chunk, so a link is the whole of what crosses the boundary.
 *
 * The page answers `notFound()` where the tenant does not have the process
 * canvas module, so every caller offers a link only where the module is on.
 */

/** The two versions the view can be asked for, both by version id. */
export interface AgentCanvasLinkOptions {
    /** The profile version to draw. Absent: the version in force, else the newest. */
    version?: string | null;
    /**
     * The version to draw the changes FROM (Phase 2.4): the approver's diff of
     * `version` against this one, normally the version in force.
     */
    compare?: string | null;
}

/** `/t/:slug/processes/agents/:agentId`, with the versions asked for. */
export function agentCanvasHref(tenantSlug: string, agentId: string, opts: AgentCanvasLinkOptions = {}): string {
    return withAgentCanvasVersions(
        `/t/${encodeURIComponent(tenantSlug)}/processes/agents/${encodeURIComponent(agentId)}`,
        opts,
    );
}

/**
 * The same view, at other versions: the Behaviour tab receives the agent's
 * canvas link from the page (or `null` without the module) and asks for a
 * version on it, so it never has to know where the canvas lives.
 */
export function withAgentCanvasVersions(href: string, opts: AgentCanvasLinkOptions): string {
    const params = new URLSearchParams();
    if (opts.version) params.set('version', opts.version);
    if (opts.compare) params.set('compare', opts.compare);
    const query = params.toString();
    return query.length > 0 ? `${href}?${query}` : href;
}

/**
 * The agent an INVOKE_AGENT rule invokes, or null.
 *
 * Narrows rather than casts, as `ruleIdFromDataJson` does: a rule's config is
 * JSON the server stores, and a rule of another action, a config that is not
 * an object, or an `agentId` that is not a non-empty string invokes nobody.
 */
export function agentIdOfInvokeRule(rule: { actionType?: unknown; actionConfigJson?: unknown } | null | undefined): string | null {
    if (!rule || rule.actionType !== 'INVOKE_AGENT') return null;
    const config = rule.actionConfigJson;
    if (typeof config !== 'object' || config === null || Array.isArray(config)) return null;
    const id = (config as { agentId?: unknown }).agentId;
    return typeof id === 'string' && id.length > 0 ? id : null;
}
