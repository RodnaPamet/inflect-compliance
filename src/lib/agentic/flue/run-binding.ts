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
 * ── READ, AND LET THE DRIVER DISPOSE ────────────────────────────────────────
 *
 * This used to be `takeRunBinding`, which REMOVED the entry on read. The
 * reasoning was sound about authority — a binding is the resolved answer to
 * "what may this run reach", and leaving it addressable after the run has
 * finished with it means a later dispatch naming the same id inherits it —
 * but it was wrong about WHO disposes, and that made the agent lose its tools.
 *
 * `@flue/runtime` re-runs the agent function before EVERY model call. The
 * first render claimed the binding and deleted it; from the second turn on the
 * lookup returned `undefined`, so the agent took the no-authority branch,
 * registered ZERO tools, skipped `useModel`/`useResponseFinish`, and told the
 * model the run could not be bound. The run still settled COMPLETED. Every
 * multi-turn Flue run was silently a one-turn run with an unusable tail.
 *
 * So the read is non-destructive, and disposal belongs to the one place that
 * knows the dispatch is over: `executeFlueRun`'s `finally`, which calls
 * `releaseRun` on every exit — success, failure, guard halt and throw alike.
 * That keeps both original properties. The map cannot grow without bound,
 * because the finally always runs. Authority is not left addressable after the
 * run, because the finally removes it at exactly the moment the run ends —
 * which is the correct boundary, rather than the first of N renders inside it.
 *
 * `bindRun` deliberately sits OUTSIDE that try: a refused rebind must not
 * reach the `finally`, or it would release the incumbent's authority while
 * reporting that it had protected it.
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

/**
 * Read the binding WITHOUT removing it. Returns undefined if there is none.
 *
 * Non-destructive because the runtime re-renders the agent before every model
 * call, and each render must see the same authority. `releaseRun`, from the
 * driver's `finally`, is the disposer.
 */
export function readRunBinding(runId: string): FlueRunBinding | undefined {
    return BINDINGS.get(runId);
}

/**
 * Drop a binding. THE disposer: `executeFlueRun`'s `finally` calls this on
 * every exit, so it covers both the dispatch that ran to completion and the
 * failure paths between `bindRun` and a dispatch that never happened. Without
 * it authority would sit in the map for the lifetime of the process.
 */
export function releaseRun(runId: string): void {
    BINDINGS.delete(runId);
}

/** How many bindings are outstanding. Diagnostics and the leak test. */
export function outstandingRunBindings(): number {
    return BINDINGS.size;
}
