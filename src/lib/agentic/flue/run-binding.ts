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
/**
 * One resolved skill, as the binding carries it — the Agent Skills fields
 * `defineSkill` needs, and nothing that could reach the filesystem again.
 */
export interface FlueSkillDocument {
    readonly name: string;
    readonly description: string;
    readonly instructions: string;
}

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

    /**
     * The skills this run loads, ALREADY RESOLVED — the same discipline the
     * tool set above follows, and for the first of the same two reasons.
     *
     * AUTHORITY: the agent function receives documents, not the ability to go
     * and find documents. It cannot read a seventh skill off disk because the
     * corpus loader is not in its scope, so no edit inside the agent can widen
     * what the model is taught.
     *
     * Plain data rather than a Flue `SkillReference`: `defineSkill` lives in
     * `@flue/runtime`, whose only VALUE import in `src/` is the agent module,
     * so the conversion happens there and the resolution happens here.
     */
    skills: readonly FlueSkillDocument[];
    /** `<provider-id>/<model-id>`, already resolved against the tenant's residency. */
    modelSpecifier: string;

    /**
     * HOW MANY SUBAGENTS ONE TURN OF THIS RUN MAY DELEGATE TO (#3473).
     *
     * Carried here for the same reason the tools and the skills are: the only
     * place a fan-out cap can be enforced is the Flue execution interceptor,
     * which runs in the ESM graph where `pg` does not load — so the VALUE is
     * resolved by the driver, in ordinary Node, from
     * `TenantSecuritySettings.agentMaxSubagentsPerTurn`, and the enforcement
     * compares against what it was handed.
     *
     * OPTIONAL ON THE TYPE AND NEVER OPTIONAL IN EFFECT.
     * `normaliseFanOutCap` turns an absent, negative or non-finite value into
     * `DEFAULT_MAX_SUBAGENTS_PER_TURN`, so a caller that omits it gets the
     * safe number rather than "unlimited". Optional rather than required
     * because every existing `bindRun` call site predates delegation and
     * requiring it would make them all say a number about a capability they do
     * not use — and a required field answered by copy-paste is a worse record
     * than an absent one with a safe default.
     */
    maxSubagentsPerTurn?: number;

    /**
     * SCAN A DELEGATE'S ANSWER BEFORE IT RE-ENTERS THE PARENT'S CONTEXT
     * (#3473, and #3468's rule applied to a new inbound edge).
     *
     * A CALLBACK rather than a value, which is the one authority term here
     * that cannot be precomputed: the guard runs on TEXT that does not exist
     * until the delegate has answered. The driver builds it closed over its
     * own `ctx` — in ordinary Node, where `app-layer/ai/guard` and Prisma load
     * — and the interceptor awaits it in the ESM graph. Same shape as
     * `wrapForLedger`'s `onFailure`/`noteOrigin` hooks, for the same reason.
     *
     * THROWS to block. A delegate's answer that is steering the parent must
     * not reach the model, and returning a verdict for the caller to check
     * would put the enforcement in the caller — which is where it gets
     * forgotten.
     *
     * WHY THE DELEGATE'S READS NEED NO SUCH HOOK: `narrowTools` hands the
     * delegate the parent's OWN tool objects, so its reads run the parent's
     * `wrapForLedger` — already scanned both directions, already recorded in
     * the parent's step ledger, already charged to the parent's budget.
     * Measured: a delegate's `list_controls` call runs the parent's wrapper.
     * What that leaves unscanned is the delegate's own composed ANSWER, which
     * is what this guards.
     */
    guardDelegateOutput?: (text: string, taskId: string | undefined) => Promise<void>;

    /**
     * RECORD A COMPLETED DELEGATION IN THE STEP LEDGER (#3473, part 3).
     *
     * A callback for the same reason `guardDelegateOutput` is one: the ledger
     * write reaches Prisma, which the interceptor's ESM graph cannot load. The
     * driver owns the sequence counter, so it allocates the `seq` as well —
     * the interceptor supplies only what it knows.
     *
     * WHAT IT KNOWS IS ENOUGH, and that was the finding that shaped this. The
     * `task` result's `details` carries `agent` — the specialist's name,
     * supplied by the runtime — alongside `taskId` and `session`. So no render
     * callback is needed to report the name, which is as well: a delegate's
     * render gets `useInitialData() === undefined` and has no task identity to
     * key a report to.
     *
     * A TRAILING MARKER, not a leading one. The seq is allocated when the
     * delegation COMPLETES, so the step lands after the delegate's own steps
     * rather than before them. That is the better end of the span to mark: the
     * step carries the outcome, and the group a reader wants is "the steps back
     * to the previous non-delegation step".
     */
    /**
     * The ledger counter's CURRENT value, without advancing it (#3473 part 3).
     *
     * Read by the gate before `next()`, so a delegation's step span has an
     * exact lower bound: every step the delegate goes on to record takes a seq
     * from this same counter, so they all sit at or above it.
     *
     * A READER, not an allocator. `nextSeq()` is the driver's and must stay so
     * — a second allocator would hand two steps the same seq.
     */
    currentLedgerSeq?: () => number;

    onDelegationComplete?: (delegation: {
        /** The specialist the model selected, from the runtime's own result. */
        agent: string;
        taskId: string;
        /**
         * Did the answer survive the guard? `false` when
         * `guardDelegateOutput` refused it, which is a different outcome from
         * a delegate that failed on its own.
         */
        answerAccepted: boolean;
        /**
         * The seq the ledger stood at when this delegation STARTED, so the
         * span is `[fromSeq, this step's seq)`.
         *
         * EXACT EVEN UNDER CONCURRENT FAN-OUT, and that is a property of where
         * it is captured rather than of any bookkeeping. The gate reads it
         * before `next()` in the SAME interceptor frame that later records the
         * completion, so each delegation's bound lives in its own local — two
         * delegations in one turn are two frames and cannot read each other's.
         *
         * An earlier draft kept this in a module map keyed by run and turn,
         * which would have been last-write-wins for exactly the concurrent
         * case the fan-out cap permits. Spans may still OVERLAP in the ledger
         * when two delegations run at once; each one's bounds are right, and
         * overlap is an honest thing for a timeline to show.
         *
         * `null` when the driver supplied no reader — a run bound by a test or
         * a caller predating delegation. The marker is still recorded; only the
         * grouping is absent, which is the right way for this to degrade.
         */
        fromSeq: number | null;
    }) => Promise<void>;
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
