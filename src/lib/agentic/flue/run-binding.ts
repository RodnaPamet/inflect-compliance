import type { FlueToolDefinition } from './tools-adapter';

/**
 * WHAT A FIXED AGENT FUNCTION NEEDS TO KNOW ABOUT THE RUN IT IS SERVING.
 *
 * ── THE SHAPE THE RUNTIME FORCES ────────────────────────────────────────────
 *
 * Two constraints meet here and neither is negotiable:
 *
 *   · `start({ agents })` fixes the agent set at boot, and `start()` throws if
 *     the process already has a runtime. So there is ONE agent function, and a
 *     run cannot bring its own.
 *   · Agent functions must be SYNCHRONOUS — "move async work into tools,
 *     actions, or resource factories" — so the function cannot load the policy
 *     card, the tool manifest or anything else it needs to decide its tools.
 *
 * Everything a run's agent needs must therefore be resolved BEFORE dispatch and
 * readable synchronously during it.
 *
 * ── WHY NOT `initialData` ───────────────────────────────────────────────────
 *
 * `useInitialData()` is the runtime's own answer for per-instance data and is
 * synchronous, which fits. It is also, in its own words, "part of the
 * instance's durable record stream" and "not a secrets channel".
 *
 * An `McpInvocation` is exactly the thing that must not go there: it carries
 * the `RequestContext` — tenant, principal, permissions, the API key id — and
 * closures that would not survive serialisation anyway. So `initialData`
 * carries the RUN ID, which is already an identifier the ledger records, and
 * the invocation stays in this process, in memory, addressed by it.
 *
 * ── TAKE, NOT GET ───────────────────────────────────────────────────────────
 *
 * `takeRunBinding` REMOVES the entry. A binding is authority: it is the
 * resolved answer to "what may this run reach", and leaving it addressable
 * after the run has claimed it means a later dispatch naming the same id
 * inherits it. Runs are keyed by a cuid, so that is not a likely accident —
 * but "not likely" is a poor property for an authority lookup, and a map that
 * only ever grows is also a leak in a long-lived worker.
 */
export interface FlueRunBinding {
    /**
     * The tools this run may reach, ALREADY RESOLVED.
     *
     * The resolved set rather than the `McpInvocation` that produced it, and
     * the difference is load-bearing in two directions.
     *
     * AUTHORITY: an invocation is a capability — it carries the tenant, the
     * principal, the key id and the ceiling, and holding it means being able
     * to ask new questions of it. The agent function needs none of that; it
     * needs a list of tools to register. Handing it the narrower thing means a
     * later edit inside the agent cannot widen what the run reaches, because
     * the widening inputs are not in scope.
     *
     * LOADABILITY: `flueToolsFor` reaches the MCP registry and, through it,
     * the Prisma client. The agent module is the one place `@flue/runtime` is
     * imported as a VALUE, so it can only be loaded under the ESM jest project
     * — where `pg` does not load at all ("Class extends value [object Module]").
     * Resolving the tools in the DRIVER, which runs in ordinary Node, keeps
     * the app graph out of the ESM boundary entirely.
     */
    tools: readonly FlueToolDefinition[];
    /** `<provider-id>/<model-id>`, already resolved against the tenant's residency. */
    modelSpecifier: string;
}

const BINDINGS = new Map<string, FlueRunBinding>();

/**
 * Register what a run may reach, immediately before dispatching it.
 *
 * Refuses to overwrite. A second bind for a live run id means two callers
 * believe they own the same run, and silently keeping the newer authority is
 * how the wrong one gets used — the caller is told instead.
 */
export function bindRun(runId: string, binding: FlueRunBinding): void {
    if (BINDINGS.has(runId)) {
        throw new Error(
            `flue: run ${runId} is already bound. A run has one authority; ` +
                `rebinding it would let a second caller replace what the first resolved.`,
        );
    }
    BINDINGS.set(runId, binding);
}

/** Claim the binding, removing it. Returns undefined if there is none. */
export function takeRunBinding(runId: string): FlueRunBinding | undefined {
    const found = BINDINGS.get(runId);
    BINDINGS.delete(runId);
    return found;
}

/**
 * Drop a binding without claiming it — for the failure paths between `bindRun`
 * and a dispatch that never happened. Without it a refused or throwing start
 * leaves authority sitting in the map for the lifetime of the process.
 */
export function releaseRun(runId: string): void {
    BINDINGS.delete(runId);
}

/** How many bindings are outstanding. Diagnostics and the leak test. */
export function outstandingRunBindings(): number {
    return BINDINGS.size;
}
