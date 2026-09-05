# 2026-09-05 — the policy-card PIN, its permission key, and its metric

**Commit:** _(this change)_ — feat(agentic): pin the policy-card version, gate the
edit, count the refusals. Agentic 5/10, stage 2 of 2. A note cannot name its own
sha, and naming a pre-amend one is worse than naming none — see stage 1's header
for the same call.

Stage 2 of Agentic 5/10. Stage 1
(`docs/implementation-notes/2026-09-05-agent-policy-card.md`) built the card, the
ladder and the pre-execution evaluation. This is the other half: the version an
agent's work executed under is recorded on the work, editing a card is a
privileged act with its own key, and the gate reports itself.

## Design

### The card schema, and where the pin sits in it

Two tables from stage 1, unchanged here:

```
AgentPolicyCard          — the MUTABLE head. currentVersion, plus the rolling
                           per-UTC-day action counter. One row per agent.
AgentPolicyCardVersion   — APPEND-ONLY policy. permittedTools, maxDataScope,
                           maxAutonomyLevel, maxActionsPerRun/Day,
                           escalationTriggers, approvalRung. Never updated.
```

Stage 2 adds one column to each of the two RUNTIME tables:

```
AgentProposal.policyCardVersion  Int?
WorkflowRun.policyCardVersion    Int?
```

1/10 gave both tables `agentId` — nullable in the schema, required at the
usecase, because the column was added to a populated table in the transaction
that back-filled it. The pin is the same shape for the same reason, and it is
placed beside `agentId` deliberately: the two answer one question from two
angles. *Which principal did this, and under what rules.*

### Three states in one nullable column

```
NULL   — the row predates pinning. We do not know.
0      — the pin was resolved and NO card was in force. `NO_POLICY_CARD`.
>= 1   — the version that authorized the call which produced the row.
```

"Not recorded" and "recorded as none" are different facts. A column where one
absence means both is an absence nobody can act on: an operator seeing NULL
cannot tell a governance gap from a deployment that predates the feature. The
migration deliberately does not backfill — every existing row genuinely predates
the pin, and writing 0 across them would assert something nobody checked.

`0` is safe as the sentinel because `AgentPolicyCardVersion_version_positive`
already CHECKs a real version at `>= 1`, so the two value spaces cannot meet. A
CHECK on each new column pins it at `>= 0`.

### Why a version is immutable ONCE PINNED — and why that needed a second mechanism

A version row was already immutable: `app_user` holds no UPDATE privilege on
`AgentPolicyCardVersion`, and a trigger refuses one from any role. That is only
half the evidence. A pointer INTO immutable state is worthless if the pointer
can move — reading "the agent's card" at review time answers what the agent may
do NOW, which is a different question from what it was allowed to do THEN, and
the two differ exactly when somebody has edited the card, which is the case a
review exists to find.

So the pin is write-once, enforced by a BEFORE UPDATE trigger on both tables:

- `NULL → value` is permitted. That is the one transition a future backfill (or
  a write path that learns the version late) needs, and refusing it would make
  the backfill impossible to ever run.
- `value → anything else`, including `value → NULL`, raises
  `IMMUTABLE_POLICY_CARD_PIN`.

**A blanket UPDATE ban was not available, and that shaped the mechanism.** Both
tables are updated constantly on the ordinary path — a run moves
`RUNNING → AWAITING_APPROVAL → COMPLETED` and rewrites `stepCount`,
`contextJson` and `summary`; a proposal moves to `APPROVED` and gains
`createdEntityId`. The version table can express immutability as a PRIVILEGE
because it is never legitimately updated; these two cannot, so the property is
enforced at COLUMN level, for every role. `tests/integration/policy-card-version-pinning.test.ts`
asserts both halves — the refusal, and that ordinary updates still work — because
a trigger that had broken the engine would pass every assertion about the
refusal alone.

**The trigger raises with the DEFAULT errcode (P0001), and the sibling does
not.** `AgentPolicyCardVersion`'s trigger uses `restrict_violation` (23001), like
the AuditLog ones. That is right for a table the typed Prisma client never
updates: only raw SQL reaches it, and raw SQL surfaces the message. This trigger
fires on `prisma.workflowRun.update(...)`, and Prisma maps 23001 to P2003 —
*"Foreign key constraint violated on the (not available)"*. The message never
reaches the caller and the reader goes looking for a foreign key. Measured, not
assumed: the first draft used 23001 and the test failed on exactly that string.

### The ladder was REUSED, not re-implemented — and stage 2 adds nothing to it

Worth restating here because it is the half a reader of this note will otherwise
go looking for, and because stage 2 deliberately leaves it alone.

`src/lib/identity/write-ladder.ts` exists because the identity write-mode order
lived in FOUR places and they agreed only by coincidence — until the clamp moved,
at which point `mode !== CLAMP` refused a tenant that was BELOW the clamp rather
than above it. What stage 1 took from that module is its SHAPE, not its values:

- order lives in ONE place per dimension, as a `const` tuple, and INDEX IS THE
  ORDERING — nothing compares two rungs except through `rungOf`;
- comparison is ORDINAL, never `===`, because equality is correct only while the
  ceiling sits at the top rung and silently wrong the moment it moves;
- narrowing is free at any distance on any number of dimensions; widening is one
  rung on one dimension;
- no server imports, so an admin client can render the same ladder.

Reusing the identity module's write modes would have been a category error —
`DISABLED` / `DRY_RUN` / `AUTOMATIC` are not agent policy — so `policy-card.ts`
declares its own rungs and answers `rungOf` the same way for every one of them,
including the two ACTION BUDGETS, which are ordinal on an explicit
`ACTION_CAP_LADDER` because "one rung" has no meaning over the integers.

Stage 2 adds **no rung and no dimension**. The pin, the permission key and the
metric all sit outside `checkLadderStep`, and the one place stage 2 touches the
ladder at all is a test fixture: every card edit in the new suites spells out all
five escalation triggers, because DROPPING one is a WIDENING (the card stops
asking to be told) and a shortened list would be refused by the ladder for a
reason that has nothing to do with what the test is about.

### Where the pin is written, and why not one place

Two callers, because they hold different things:

- **`pinFromCard(inv.policyCard?.inForce ?? null)`** — `runProposeTool`, which
  holds the invocation the tool boundary just authorized. This is the strong
  form and the one to prefer: it records the version that ACTUALLY allowed the
  call, not the version in force a moment afterwards. Between the gate and the
  insert an operator can have edited the card, and only the first is evidence.
- **`resolvePolicyCardPin(tenantId, agentId)`** — `startWorkflowRun` (the run row
  exists before the first tool call) and the in-product assistant (a human
  writing through the proposal queue). One indexed point read, and only when the
  caller is an agent at all.

Neither has a default, and `ProposeInput.policyCardVersion` is REQUIRED rather
than optional-with-a-fallback. Stage 1 made the same call about splitting the
evaluator in two rather than taking a nullable count: *a nullable argument skips
silently; a missing one is visible at the call site.*

**A run's pin is the version at its START, and that is a narrowing rather than
the whole story.** A run re-resolves its invocation after every human checkpoint,
so a run spanning a card edit is authorized under the NEWER card for its later
segments — each individual call's audit row (`MCP_TOOL_INVOKED` /
`AUTHZ_DENIED`) carries the version that decided it. The column answers the
question those rows cannot once the card has moved on: what did this run open
under.

### The lint rule was extended, not duplicated

`local/require-agent-attribution` already refused a create against
`AgentProposal` / `WorkflowRun` that did not name `agentId`. It now requires
`policyCardVersion` too — one rule, one report listing every missing field,
because the two are the same decision seen from two angles and a site that
forgot one has almost always forgotten the other.

The realistic regression is not a site that forgot everything; it is a site
written before the pin existed and left behind when the column landed. A rule
that only fired when BOTH fields were absent would have reported the tree clean
on that day, so both the RuleTester suite and the git-population sweep carry a
single-omission case in each direction.

### Editing a card is privileged: a THIRD agent key

`admin.agent_policy_card`, gating
`/api/t/:slug/admin/agents/:agentId/policy-card` (GET / POST / PUT).

Not `admin.agent_tool_exposure` and not `admin.agent_registry`. The card is the
WIDEST of the three agent surfaces, not the narrowest: it declares the permitted
tools AND the data rung AND the autonomy rung AND both action budgets AND how
many humans must sign what the agent proposes. Sharing the tool-exposure key
would mean every routine "let the reporting agent read tasks too" grant also
carried the authority to raise that agent's autonomy ceiling — which is exactly
the composition that key's own docstring rejects one level down. Sharing the
register's key would put the everyday edit behind the switch that admits new
agents, and an edit people cannot make is an edit people route around.

Its rule sits ABOVE the `admin/agents(/.*)?` catch-all in `ROUTE_PERMISSIONS`
(first-wins). It is denied to a `*` API key alongside its two neighbours: a `*`
key carried BY an agent that could edit its own card could widen its own
ceiling, and a policy its own subject can rewrite is not a policy.

The gate is at the ROUTE. A `requirePermission` denial writes a hash-chained
`AUTHZ_DENIED` row and returns a generic 403 that never echoes the key; a
usecase `assertCanWrite` throw records nothing. `tests/integration/policy-card-authz.test.ts`
drives the real handlers and asserts EXACTLY one row per denial (not "at least
one" — a second gate one layer down would double every denial and make the trail
count refusals rather than attempts), that the body does not echo the key, that
the write did not happen anyway, and that the chain still verifies with the
denial rows in it.

The negative that carries the weight is a principal holding the NEIGHBOURING
keys — `agent_registry` and `agent_tool_exposure` — being refused. A test that
only refused a READER would pass on a route gated by `admin.manage`.

### Where evaluation sits in 2/10's funnel, and why there

```
1 audience → 2 liveness → 3 exposure → 4 autonomy ceiling
   → 5 POLICY CARD → 6 capability → 7 scope → 8 assertPermission → 9 policy
```

Inside `authorizeToolCall`, before `tool.run` is entered. Not beside the funnel
and not after it, for two reasons that are different:

- **Before** — because post-hoc evaluation DETECTS and only pre-execution
  PREVENTS, and the two are indistinguishable from a status code (both answer
  the next request with 403). The property is "no side effect occurred", which
  is why stage 1 asserts it with a spy on the real tool through the real funnel.
- **Inside** — because a check beside the funnel is a check a new call site can
  forget. Everything already passes through here: `/api/mcp`, the workflow
  engine, the propose path and the resources door. Step 5 rather than step 1
  because 1–4 are cheaper and less revealing, and a call refused for naming an
  ungranted tool should say so rather than reporting a card violation.

### The metric dimensions

Two counters, in `integration-metrics.ts`, both emitted from
`assertWithinPolicyCard` — the single point every evaluation passes through, so
every path out emits exactly one evaluation (the no-card early return, each
refusal, and the allow).

```
agentic.policy_card.evaluation   outcome (allowed|refused|no_card|no_agent), surface (tool|resource)
agentic.policy_card.refusal      agent, rule, escalate, risk.tier, surface
```

A refusal breaks nothing — no failed job, no error rate, no user-visible symptom;
the agent simply gets less done, and a misconfigured card looks from the outside
exactly like a quiet week. So the instrument IS this control's observability.

**Refusal volume alone cannot separate the two things that produce it.** A
MISCONFIGURED card is one agent, ONE rule, starting at an edit. An agent
operating outside its envelope (ASI10) is one agent, refusals SPREAD ACROSS
RULES or repeatedly against the action budgets. Both are "refusals went up".
Telling them apart needs the AGENT and the RULE on the same series, which is why
`agent` is a label here and `tenant.id` is a label nowhere.

The cardinality argument is different in kind, not merely in degree.
`api.request.count` emits for every tenant on every request, so a tenant label
creates a series per tenant unconditionally. A refusal series exists only for an
agent that has ACTUALLY been refused — in a healthy deployment, none — and the
agent population is operator-curated behind a privileged route and a risk
assessment, not something signups grow. The EVALUATION counter, which does fire
on every call, deliberately carries no agent for exactly that reason: it is the
denominator, and the refusal counter is the detail.

`no_card` is a first-class outcome because an agent with no card and an agent
whose card permits everything both produce zero refusals for ever. Only that
label separates a governance gap from a quiet one — and it is kept SEPARATE from
`no_agent` (a human, an ordinary integration key, a tenant with the register off)
for the same reason one level along: folded together, a tenant that simply does
not run agents would be indistinguishable from one running agents nobody has
written a card for, and the adoption number would be unreadable in exactly the
deployments where somebody needs to read it. Both reach the gate as
`policyCard: null`; `inv.agentId` is what tells them apart.

The TOOL is deliberately not a label. It is on the `AUTHZ_DENIED` audit row for
every refusal, which is the per-call record; adding it here would multiply the
series by the catalogue for the one dimension the audit trail already answers
precisely.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/agentic.prisma` | `policyCardVersion` on `AgentProposal` + `WorkflowRun`, with the three-state contract in the doc comments |
| `prisma/migrations/20260905190000_agent_policy_card_pin/migration.sql` | The two columns, their `>= 0` CHECKs, and the write-once trigger on both tables |
| `src/lib/agentic/policy-card.ts` | `NO_POLICY_CARD` — the sentinel, in the client-safe vocabulary module beside the ladders |
| `src/lib/agentic/policy-card-pin.ts` | `pinFromCard`, `resolvePolicyCardPin` — the two resolvers, and the only module that reads the card to pin it |
| `src/app-layer/usecases/workflow-runs.ts` | Resolves the pin before the run row is written; carries it into the audit entry |
| `src/app-layer/usecases/agent-proposals.ts` | `ProposeInput.policyCardVersion`, required; written onto the row and into the audit entry |
| `src/lib/mcp/tools/propose-tools.ts` | Passes the version the boundary authorized, not a re-read |
| `src/app-layer/usecases/assistant.ts` | The human path — resolves to `NO_POLICY_CARD` without a query |
| `eslint-rules/rules/require-agent-attribution.js` | Now requires both attribution fields, reported as one omission |
| `src/lib/observability/integration-metrics.ts` | `recordPolicyCardEvaluation` + `recordPolicyCardRefusal`, with the cardinality argument and the alert shapes |
| `src/lib/mcp/authorize.ts` | Both counters, at the single emission point |
| `docs/integration-observability.md` | The two metrics in the operator runbook's catalogue, with the four alert conditions |
| `src/lib/permissions.ts` | `admin.agent_policy_card` — the type, the schema, and every role branch |
| `src/lib/auth/api-key-auth.ts` | Denied to `*`, alongside its two neighbours |
| `src/lib/security/route-permissions.ts` | The rule, above the register's catch-all |
| `src/app/api/t/[tenantSlug]/admin/agents/[agentId]/policy-card/route.ts` | GET / POST / PUT behind `requirePermission` |

## Decisions

- **One nullable column with a `0` sentinel, not two columns.** The first draft
  carried `policyCardEvaluated Boolean` beside the version so the three states
  were structural. It doubled the lint surface and the trigger's conditions to
  express something a reserved value already expresses unambiguously — `0` cannot
  collide with a real version because the version table CHECKs at `>= 1`, and
  the subsystem already reads a named out-of-band integer (`DENY_CEILING`) the
  same way.
- **The proposal pin comes from the INVOCATION, the run pin from a read.** Not
  an inconsistency: the propose path holds the card the gate authorized against
  and the run row is created before any tool call exists. Where the stronger
  form is available it is used, and where it is not the weaker one is named as
  such in the code rather than papered over.
- **`NULL → value` stays open.** It is the only transition a backfill can use,
  and closing it would make the deliberate non-backfill permanent. The risk it
  admits is bounded: a row that already answered cannot be made to answer
  differently.
- **The lint rule was extended rather than a second rule added.** Two rules over
  the same two tables would double the report on the common case (a site that
  forgot both) and would each need their own RuleTester suite and their own
  entry in the wiring guard.
- **`admin.agent_policy_card` gates the READ as well as the write.** A card is a
  readable statement of exactly how much authority an agent holds; leaving GET
  on the register's key would publish the narrowing to anybody who could list
  agents.
- **The evaluation counter carries no agent and the refusal counter does.** The
  asymmetry is the cardinality decision, stated once in the counters' own
  docstrings so a future edit that "makes them consistent" has to read the
  reason first.
