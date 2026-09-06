/**
 * THE KILL SWITCH — stop an agent, a tenant's agents, or every agent, NOW.
 *
 * OWASP ASI08 (cascading failure) and ASI10 (rogue agent) both end in the same
 * operator sentence: *make it stop*. Propose-not-commit already caps what a
 * single call can do; nothing in this codebase could STOP a run that had already
 * started.
 *
 * ## Why `RegisteredAgent.status = SUSPENDED` was not already the answer
 *
 * Suspension is a DISPATCH control and this is a BOUNDARY control, and the
 * difference is the whole subsystem.
 *
 * `evaluateAgentRegistration` reads the agent's status inside
 * `resolveMcpInvocation`. The workflow engine resolves ONE invocation per
 * execution and then drives every step on it (`executeFrom` in
 * `usecases/workflow-runs.ts`), so suspending an agent refuses the next REQUEST
 * and does nothing whatsoever to a run already in flight — which is exactly the
 * case a stop control exists for. Suspension is also inert for a tenant with
 * `requireRegisteredAgent` off, and it has no tenant-wide or platform-wide form:
 * an incident spanning a fleet would be answered one row at a time, by hand,
 * while the fleet kept running.
 *
 * So the check lives at the TOOL BOUNDARY, as step 0 of `authorizeToolCall`,
 * beside the credential-liveness re-read that closed the identical gap for
 * revocation. A control that only refuses new dispatches stops nothing that is
 * currently going wrong.
 *
 * ## THE COST, AND WHY IT IS NOT PAID WITH A CACHE
 *
 * This runs on every tool call, so its cost is on the hot path. There is exactly
 * one thing that must not be done about that: cache the answer.
 *
 * A cached kill state that lags by one execution cycle is the control failing at
 * the one moment it matters. The whole claim being made here is "the next tool
 * call", and any TTL is a window in which an operator has pulled the switch and
 * the agent goes on acting — the window being, by construction, the first
 * seconds of an incident. `agent-credential-state.ts` states the same rule for
 * revocation one notch weaker; this is the stronger case, because a kill is
 * pulled by a human who is watching.
 *
 * What IS done instead is to make the uncached read cheap:
 *
 *   • ONE round trip, not three. The three scopes are three predicates over two
 *     tables, resolved by a single `UNION ALL … LIMIT 1`. Under PgBouncer's
 *     transaction pooling two `Promise.all`'d queries take two pooled server
 *     connections on every tool call; this takes one.
 *   • ONE index scan per arm. `AgentKillSwitch` is read by
 *     `(tenantId, agentId, liftedAt)` — the composite that exists for this query
 *     and nothing else — and `PlatformAgentKillSwitch` by `(liftedAt)` over a
 *     table that holds one row per platform incident, ever.
 *   • It returns AT MOST ONE ROW. Precedence is resolved in SQL rather than by
 *     fetching every matching kill and sorting in JS.
 *
 * The result is the same cost class as `checkCredentialLiveness`, which already
 * runs on this path — one indexed lookup against a tool call that is about to do
 * real work inside a usecase.
 *
 * ## Precedence, and why the boundary reports the WIDEST scope
 *
 * PLATFORM > TENANT > AGENT. When two kills are in force the refusal names the
 * widest, because the widest is the one whose lift is a decision somebody else
 * has to make: telling an operator "this agent is killed" while the platform is
 * dark sends them to edit a row that will change nothing.
 *
 * ## What a kill GUARANTEES, and what it does not
 *
 * GUARANTEES: no tool call authorized after the kill row commits executes. The
 * check is step 0 of the gate and the gate runs before `tool.run` is entered, so
 * a refusal is a refusal BEFORE the side effect, not a report after it.
 *
 * DOES NOT: un-write anything already committed. A kill cannot roll back the
 * rows earlier steps wrote, cannot un-queue proposals already in the review
 * queue, and cannot interrupt a tool call that is already inside `tool.run` —
 * the boundary is BETWEEN calls, not a preemption of one in progress. It also
 * does not stop non-agentic traffic: a human using the product is unaffected,
 * which is the point.
 *
 * ## Scope is DERIVED, never stored
 *
 * `AgentKillSwitch.agentId IS NULL` ⇔ TENANT, non-NULL ⇔ AGENT. A stored `scope`
 * column beside a nullable `agentId` is two encodings of one fact and they can
 * disagree; there is nothing to keep in step because there is only one field.
 */
import prisma from '@/lib/prisma';

/** A Prisma client or transaction client this module can read through. */
type KillReader = Pick<typeof prisma, '$queryRaw'>;

/**
 * The three scopes a kill can be pulled at, WIDEST FIRST.
 *
 * A `readonly` tuple of string literals rather than a Postgres enum, for the
 * reason `AgentPolicyCardVersion.approvalRung` and
 * `McpToolManifestPin.approvalSource` are TEXT: an `ALTER TYPE` mid-rolling-
 * deploy makes still-running old containers fail with SQLSTATE 42704.
 *
 * The order IS the precedence, widest first. It is spelled a SECOND time as
 * integer ranks inside the SQL below, because that is where the ordering has to
 * happen and SQL cannot read this constant — the duplication is stated here
 * rather than hidden behind a helper that only looks like a single source. What
 * holds the two in step is behavioural, not structural: the PLATFORM-scope
 * assertion in `tests/integration/agent-kill-switch.test.ts` engages a NARROWER
 * kill first and requires the wider one to be the answer, and it is the sole
 * detector for a reversed `ORDER BY` — verified by mutating it.
 */
export const KILL_SCOPES = ['PLATFORM', 'TENANT', 'AGENT'] as const;

/**
 * The agent id the scheduled drill kills, and the reason it is a constant.
 *
 * `AgentKillSwitch.agentId` carries no foreign key (see the model docstring), so
 * this id resolves to no registered agent in any tenant — which means engaging a
 * REAL, COMMITTED kill against it exercises the whole write → enforce → lift
 * lifecycle without ever stopping a production agent. A drill that only ever ran
 * against a rolled-back transaction would never prove the write path, and a
 * drill that killed a real agent would be an outage on a cron.
 *
 * It is also the label the boundary uses to separate a drill refusal from a real
 * one in the metric. Derived from the invocation's own agent id rather than
 * passed in, so nothing can mark a genuine refusal as synthetic.
 *
 * The `__` prefix and the space-free shape match nothing `cuid()` can produce,
 * so it cannot collide with a real agent id.
 */
export const KILL_SWITCH_DRILL_AGENT_ID = '__kill-switch-drill-canary__';

export type KillScope = (typeof KILL_SCOPES)[number];

/** Is this string one of the three scopes? Narrows a value read back from TEXT. */
export function isKillScope(value: unknown): value is KillScope {
    return typeof value === 'string' && (KILL_SCOPES as readonly string[]).includes(value);
}

/** A kill in force, as the boundary reports it. */
export interface KillVerdict {
    scope: KillScope;
    /** The switch row's id — what an operator lifts, and what the audit row names. */
    switchId: string;
    engagedAt: Date;
}

/** The shape the UNION below returns, before narrowing. */
interface KillRow {
    scope: string;
    switchId: string;
    engagedAt: Date;
}

/**
 * Is anything stopping this (tenant, agent) from acting RIGHT NOW?
 *
 * `null` means "not killed" and is the answer on the overwhelming majority of
 * calls. A non-null verdict is a refusal.
 *
 * `agentId` is `null` for a credential that resolved to no registered agent —
 * an ordinary integration key, or a tenant with the register turned off. Those
 * callers are deliberately still covered by the TENANT and PLATFORM arms: "stop
 * this tenant's agents" that left unregistered agent traffic running would stop
 * the agents somebody had bothered to write down and none of the others, which
 * is the wrong half.
 *
 * `client` exists so the scheduled drill can drive this function inside a
 * transaction it then rolls back — see `jobs/agent-kill-switch-drill.ts`. The
 * default is the base client, which is what the boundary always uses; nothing on
 * the hot path passes an override.
 *
 * ## Why this talks to Prisma directly
 *
 * Same seam as `policy-card-store.ts` and `agent-credential-state.ts`. It runs
 * inside the MCP tool boundary, which has no `RequestContext` to open a tenant
 * transaction with — the boundary is authorizing the request that would have
 * built one. `tests/guardrails/mcp-server-coverage.test.ts` refuses any Prisma
 * import under `src/lib/mcp/`, so the read belongs here beside the other
 * boundary-time reads rather than as a carve-out there. The base client runs as
 * a non-`app_user` session, so `superuser_bypass` applies and the `tenantId`
 * predicate below is the isolation — not defence in depth, the only layer, which
 * is why `tenantId` is the first parameter rather than something reached for.
 */
export async function resolveKillState(
    tenantId: string,
    agentId: string | null,
    client: KillReader = prisma,
): Promise<KillVerdict | null> {
    // ONE round trip for all three scopes. `rank` is the precedence from
    // `KILL_SCOPES`, spelled here as literals because SQL cannot read the
    // constant — see that constant's docstring for what keeps the two in step.
    const rows = await client.$queryRaw<KillRow[]>`
        SELECT * FROM (
            SELECT 0 AS rank, 'PLATFORM' AS scope, "id" AS "switchId", "engagedAt"
              FROM "PlatformAgentKillSwitch"
             WHERE "liftedAt" IS NULL
            UNION ALL
            SELECT CASE WHEN "agentId" IS NULL THEN 1 ELSE 2 END AS rank,
                   CASE WHEN "agentId" IS NULL THEN 'TENANT' ELSE 'AGENT' END AS scope,
                   "id" AS "switchId",
                   "engagedAt"
              FROM "AgentKillSwitch"
             WHERE "tenantId" = ${tenantId}
               AND "liftedAt" IS NULL
               AND ("agentId" IS NULL OR "agentId" = ${agentId})
        ) k
        ORDER BY k.rank ASC
        LIMIT 1`;

    const row = rows[0];
    if (!row) return null;
    if (!isKillScope(row.scope)) {
        // Unreachable while the SQL above is the only writer of this column. It
        // is here because the alternative to refusing an unrecognised scope is
        // returning `null`, and `null` means "not killed" — a parse failure must
        // never be the thing that lets an agent keep running.
        return { scope: 'PLATFORM', switchId: row.switchId, engagedAt: row.engagedAt };
    }
    return { scope: row.scope, switchId: row.switchId, engagedAt: row.engagedAt };
}

/**
 * The refusal message for each scope. Names WHAT is stopped and WHO can lift it,
 * because those are three different conversations, and says nothing else — the
 * reason text an operator typed is tenant content and does not go back out over
 * an error body to whatever is holding the credential.
 */
export function killRefusalMessage(scope: KillScope): string {
    switch (scope) {
        case 'PLATFORM':
            return (
                'Agent tool calls are stopped platform-wide by an operator kill ' +
                'switch. No agent is running anywhere in this deployment. Contact ' +
                'the platform operator — a tenant administrator cannot lift this.'
            );
        case 'TENANT':
            return (
                "Agent tool calls are stopped for this tenant by an administrator's " +
                'kill switch. Every agent here is halted, including runs already in ' +
                'progress. A tenant administrator lifts it in the agent register.'
            );
        case 'AGENT':
            return (
                "This agent is stopped by an administrator's kill switch. Every " +
                'further tool call is refused, including within a run already in ' +
                'progress. A tenant administrator lifts it in the agent register.'
            );
    }
}

// ─── The PLATFORM scope's own store ─────────────────────────────────
//
// Tenant-scoped engage/lift live in `usecases/agent-kill-switch.ts`, where they
// get a `RequestContext`, RLS and an audit row. The platform scope has none of
// those — there is no tenant to bind, no `PermissionSet` key that can express
// "may stop every deployment", and no `AuditLog` table that is not tenant-scoped
// — so it lives here, beside the read it pairs with, and is gated by
// `verifyPlatformApiKey` at its route.

/** The platform kill in force, or `null`. */
export async function readPlatformKill(): Promise<{
    id: string;
    reason: string;
    engagedByRef: string;
    engagedAt: Date;
} | null> {
    return prisma.platformAgentKillSwitch.findFirst({
        where: { liftedAt: null },
        select: { id: true, reason: true, engagedByRef: true, engagedAt: true },
        orderBy: { engagedAt: 'desc' },
    });
}

/**
 * Stop every agent in the deployment.
 *
 * IDEMPOTENT BY DESIGN: an engage while one is already in force returns the
 * EXISTING row rather than inserting a second. A partial unique index would
 * refuse the second insert anyway, and an operator hammering the stop button
 * during an incident must get "yes, it is stopped" rather than a 500. The
 * database constraint is still the authority — this is the path that makes the
 * common case pleasant, not the thing that makes it correct.
 */
export async function engagePlatformKill(input: {
    reason: string;
    engagedByRef: string;
}): Promise<{ id: string; alreadyInForce: boolean; engagedAt: Date }> {
    const existing = await readPlatformKill();
    if (existing) {
        return { id: existing.id, alreadyInForce: true, engagedAt: existing.engagedAt };
    }
    const row = await prisma.platformAgentKillSwitch.create({
        data: { reason: input.reason, engagedByRef: input.engagedByRef },
        select: { id: true, engagedAt: true },
    });
    return { id: row.id, alreadyInForce: false, engagedAt: row.engagedAt };
}

/**
 * Let every agent in the deployment run again.
 *
 * Returns `null` when nothing was in force — lifting a switch nobody pulled is
 * not an error, and making it one would mean an operator racing a colleague's
 * lift gets a failure that reads like the platform is still down.
 *
 * A conditional `updateMany` on `liftedAt: null`, not a read-then-write: two
 * concurrent lifts must not both claim to have been the one that lifted it.
 */
export async function liftPlatformKill(input: {
    liftedByRef: string;
    liftReason: string;
}): Promise<{ id: string } | null> {
    const existing = await readPlatformKill();
    if (!existing) return null;
    const claimed = await prisma.platformAgentKillSwitch.updateMany({
        where: { id: existing.id, liftedAt: null },
        data: {
            liftedAt: new Date(),
            liftedByRef: input.liftedByRef,
            liftReason: input.liftReason,
        },
    });
    return claimed.count === 1 ? { id: existing.id } : null;
}
