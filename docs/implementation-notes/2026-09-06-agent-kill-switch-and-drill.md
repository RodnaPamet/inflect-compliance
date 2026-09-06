# 2026-09-06 — The agent kill switch, at three scopes, and the drill that proves it

**Commit:** `0de956276` feat(agentic): a kill switch at the tool boundary, and the drill that proves it

OWASP **ASI08** (cascading failure) and **ASI10** (rogue agent) both end in the
same operator sentence: *make it stop*. Propose-not-commit already caps what a
single agent call can do. Nothing in this codebase could STOP a run that had
already started.

## Design

### The check is at the TOOL BOUNDARY, and it is step 0

```
runReadTool / runProposeTool
  └─ authorizeToolCall(inv, tool, rawArgs)
       0. KILL SWITCH      ← new. resolveKillState(tenantId, agentId), uncached
       1. audience
       2. credential liveness
       3. tool-manifest pin
       4. deny-by-default exposure
       5. autonomy ceiling
       6. policy card
       7. credential capability
       8. credential scope
       9. permission keys
      10. read/write policy
```

**Why not `RegisteredAgent.status = SUSPENDED`, which already exists.**
Suspension is a *dispatch* control. `evaluateAgentRegistration` reads the status
inside `resolveMcpInvocation`, and the workflow engine resolves ONE invocation
per execution and drives every step on it (`executeFrom`). So suspending an
agent refuses the next REQUEST and does nothing at all to a run already in
flight — which is the case a stop control exists for. It is also inert for a
tenant with `requireRegisteredAgent` off, and it has no tenant-wide or
platform-wide form.

**Why step 0.** Every other step asks whether the caller is correctly
*configured*. This one asks whether a human has already decided nothing further
runs, and that must not become conditional on the other seven answers. A killed
agent presenting a mis-scoped token has to be refused for being KILLED — if the
audience check answered first, the operator watching the trail during an
incident would see the wrong reason and no row saying the kill did anything.
It also short-circuits the funnel, which matters most in the situation it exists
for. `tests/integration/agent-kill-switch.test.ts` asserts the ordering
behaviourally: an agent that is killed AND ungranted is refused with the KILL
refusal, and with the kill lifted the same call is refused by the exposure check.

### Three scopes, two tables

`AgentKillSwitch` is tenant-scoped and carries the AGENT and TENANT scopes;
`PlatformAgentKillSwitch` is global. A single table with a nullable `tenantId`
would have forced the asymmetric single-policy RLS shape `UserSession` needs;
the split is the one `ai-governance.prisma` and the agent-assessment tables
already make.

**The scope is DERIVED, never stored.** `agentId IS NULL` ⇔ TENANT, non-NULL ⇔
AGENT. A stored `scope` column beside a nullable `agentId` is two encodings of
one fact and they can disagree.

**Precedence PLATFORM > TENANT > AGENT**, resolved in SQL. When two kills are in
force the refusal names the WIDEST, because the widest is the one whose lift is
somebody else's decision: telling an operator "this agent is killed" while the
platform is dark sends them to edit a row that will change nothing.

### Who may kill at each scope

| Scope | Gate | Why |
| --- | --- | --- |
| AGENT | `requirePermission('admin.agent_kill_switch')` | A tenant admin decision |
| TENANT | same | Same authority, wider blast radius, same person |
| PLATFORM | `verifyPlatformApiKey` (`PLATFORM_ADMIN_API_KEY`) | No tenant to scope a key to |

`admin.agent_kill_switch` is a NEW key rather than a reuse of
`admin.agent_registry`, which already carries "suspend". The register key
BUNDLES suspend with activate, so a tenant cannot delegate the authority to STOP
without also delegating the authority to ADMIT an agent nobody has scored —
opposite risk profiles (a wrong stop is bounded, reversible and audited; a wrong
start is what every other key in that block exists to prevent). The default
grant is OWNER + ADMIN, same as its three neighbours; the *grantability* is the
argument, not the default.

`scopesToPermissions(['*'])` denies it, joining the three agent-governance flags:
an agent holding a `*` key that could lift its own kill switch is an agent that
cannot be stopped, and unlike the other three that failure has no backstop.

**Platform-wide has no `AuditLog` home**, because that table is tenant-scoped by
construction and fanning one platform action into every tenant's hash chain
would be write amplification with no reader. The durable record is the
`PlatformAgentKillSwitch` row (a CHECK constraint makes a half-written lift
unrepresentable) plus a structured log line. Each tenant still sees the
CONSEQUENCE in its own trail: every refused call writes an `AUTHZ_DENIED` row
carrying `killScope: 'PLATFORM'`.

### What a kill guarantees, and what it does not

**Guarantees.** No tool call authorized after the kill row commits executes. The
check runs before `tool.run` is entered, so a refusal precedes the side effect
rather than reporting it. That includes a run already in flight, at its next
step, and it includes the resources surface as well as the tools surface.

**Does not.** A kill cannot un-write a row. It does not roll back what earlier
steps of the run committed, does not un-queue proposals already in the review
queue, and does not interrupt a call already inside `tool.run` — the boundary is
BETWEEN calls, not a preemption of one in progress. It does not touch
non-agentic traffic: a human using the product is unaffected, which is the
point. And a killed workflow run ends FAILED with the kill named in
`errorMessage`; it is not resumable past the refusal.

### The hot path, and why there is no cache

The check runs on every tool call. The one thing that must not be done about
that is cache the answer: a cached kill state that lags by one execution cycle
is the control failing at the one moment it matters, the window being — by
construction — the first seconds of an incident.

What is done instead is to make the uncached read cheap:

* **ONE round trip for all three scopes**, a single `UNION ALL … ORDER BY rank
  LIMIT 1`. Two `Promise.all`'d queries would take two pooled server connections
  per tool call under PgBouncer's transaction pooling; this takes one.
* **One index scan per arm** — `@@index([tenantId, agentId, liftedAt])` exists
  for this query and nothing else; the platform table holds one row per
  incident, ever.
* **At most one row returned.** Precedence is resolved in SQL, not by fetching
  every match and sorting in JS.

Same cost class as `checkCredentialLiveness`, which already runs on this path.
`tests/integration/agent-kill-switch.test.ts` has a dedicated freshness test:
two calls on the SAME invocation with the kill engaged between them. A
per-execution cache passes every other test in that file and fails that one.

### The drill

`agent-kill-switch-drill`, daily at 06:00 UTC, per tenant that runs agents.

* **AGENT arm — COMMITTED.** A real `AgentKillSwitch` row is written against
  `KILL_SWITCH_DRILL_AGENT_ID`, the boundary's own decision function is asked,
  the answer must name the AGENT scope, and the row is lifted in a `finally`.
  The canary resolves to no registered agent in any tenant (which is why
  `AgentKillSwitch.agentId` carries no FK), so the write → decide → lift
  lifecycle runs against production code and tables without stopping anything.
* **TENANT and PLATFORM arms — PREDICATE, inside a rolled-back transaction.**
  Committing either would be an outage on a cron. What is checked is that
  `resolveKillState` returns the right scope for a row of that shape — the
  regression the AGENT arm cannot see (narrowing the SQL's `agentId IS NULL OR …`
  breaks tenant-wide kills while every agent-scope test stays green).
* **What it does NOT prove**, stated on the row itself: that
  `authorizeToolCall` still CALLS the decision, and calls it first. A job module
  may not import the gate — `tests/guards/worker-import-graph.test.ts` forbids
  reaching `src/lib/auth.ts`, and the worker genuinely cannot evaluate that
  module tree, so a drill that imported it would record `ERROR` every night: a
  control whose self-test never runs, wearing a status. Wiring is a compile-time
  fact and is asserted in CI; what varies in production is state, and state is
  what this drills.

A FAILED drill raises a `Finding(NONCONFORMITY, OPEN, CRITICAL)` bridged by
`FindingEvidence` to an `Evidence(TEXT, category 'integration')` row — the same
artefact chain `control-test-runner` produces on an automated FAIL, so a failed
stop control lands in the same queue, in front of the same people.

`ERROR` is deliberately **not** `FAILED`. A drill that could not run has proved
nothing; reporting it as "the control is broken" would raise a CRITICAL Finding
about a database timeout and teach people to close them in bulk.

**Halting is not truncation**, in both directions: within one tenant all three
arms are attempted even after one fails (the evidence needs "which scopes are
honoured", not "the first one that broke"), and across tenants one tenant's
throw is recorded as that tenant's own `ERROR` row rather than aborting the
sweep — halting there would leave every later tenant undrilled with nothing
saying so. The tenant set is DRAINED (`drainPages`), never `take`-capped: a cap
and a true total are indistinguishable at the boundary.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/agentic.prisma` | `AgentKillSwitch`, `PlatformAgentKillSwitch`, `AgentKillSwitchDrill` |
| `prisma/migrations/20260906090000_agent_kill_switch/migration.sql` | Tables, CHECKs, partial unique indexes, RLS triple + FORCE |
| `src/lib/agentic/kill-switch.ts` | The hot-path read (one `UNION ALL`), the scope vocabulary, the refusal messages, the platform store |
| `src/lib/mcp/authorize.ts` | Step 0 — `assertNotKilled`, the `agent_killed` denial reason |
| `src/app-layer/usecases/agent-kill-switch.ts` | Tenant-scoped engage / lift / list, sanitised, audited |
| `src/app/api/t/[tenantSlug]/admin/agents/kill-switch/route.ts` | AGENT + TENANT scopes, `requirePermission` |
| `src/app/api/admin/agent-kill-switch/route.ts` | PLATFORM scope, `verifyPlatformApiKey` |
| `src/app-layer/jobs/agent-kill-switch-drill.ts` | The drill, its record, its Evidence and its Finding |
| `src/lib/permissions.ts` | `admin.agent_kill_switch` |
| `src/lib/auth/api-key-auth.ts` | `*` keys do not get it |
| `src/lib/observability/integration-metrics.ts` | `agentic.kill_switch.refusal`, `agentic.kill_switch.drill` |
| `src/lib/security/encrypted-fields.ts` | `AgentKillSwitch.reason` / `.liftReason` encrypted at rest |

## Decisions

* **`AgentKillSwitch.agentId` carries no foreign key.** Three reasons, each
  sufficient: a kill must be recordable when the register is in a bad state (an
  FK makes a healthy register a *precondition for stopping*); a kill row is
  HISTORY and must outlive its agent, where `RegisteredAgentTool` argues the
  opposite way for grants because a grant is authority; and it lets the drill
  target a canary id no credential can resolve to. An unmatched id is inert —
  the read is `(tenantId, agentId)` scoped.
* **Lifting is an UPDATE, never a DELETE.** The row is the evidence that agents
  were stopped between two timestamps. A control that erases its own history by
  being used is not auditable. A DB CHECK makes `liftedAt` without
  `liftedByUserId` unrepresentable.
* **Partial unique indexes, not usecase checks.** `one_in_force_per_target`
  (with `COALESCE(agentId,'')`, because NULLs are distinct in a plain unique
  index) and `one_in_force` on the platform table. Two concurrent engages must
  not leave two rows that BOTH have to be lifted before agents resume — a stop
  that looks lifted and is not.
* **No new Postgres enums.** `outcome` and the scope vocabularies are TEXT with
  CHECK constraints, matching `McpToolManifestPin.approvalSource` and
  `AgentPolicyCardVersion.approvalRung`, for the reason the `@@map("WorkItem*")`
  pins record: an `ALTER TYPE` mid-rolling-deploy makes still-running old
  containers fail with SQLSTATE 42704.
* **`PlatformAgentKillSwitch.reason` is NOT encrypted and cannot be** —
  ciphertext is wrapped by a per-tenant DEK and that row has no tenant. Its
  content is a platform operator's own incident reference rather than tenant
  data. The asymmetry with `AgentKillSwitch.reason` is stated rather than left
  to be discovered.
* **`app_user` gets SELECT and no write grant on the platform table.** Nothing
  an app_user session does may stop or start the deployment.
* **Engage is idempotent, lift is a conditional `updateMany`.** An operator
  hammering the stop button during an incident must get "yes, it is stopped"
  rather than a unique-violation 500; one racing a colleague's lift must be told
  the truth rather than reporting a success that did nothing.
* **The refusal never echoes the operator's reason text.** The caller in the
  scenario this defends against is the thing that was just stopped. The message
  names WHAT is stopped and WHO can lift it; the reason lives on the row.
* **The drill's refusals are labelled `drill: true` in the metric**, derived
  from the target agent id rather than passed in, so nothing can mark a genuine
  refusal as synthetic. Without the label every deployment would show a steady
  trickle of `agent_killed` denials and operators would learn to ignore the
  series — which is how a security signal stops being read.
