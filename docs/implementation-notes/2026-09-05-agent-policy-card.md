# 2026-09-05 — the agent POLICY CARD (Agentic 5/10, stage 1)

**Commit:** `<pending>` feat(agentic): the policy card — a versioned runtime policy evaluated before the tool runs (5/10 stage 1)

Stage 1 of two. This lands the card, the ladder that governs an edit, and the
evaluation at the tool boundary (prompt subpoints 1, 2 and 4). Stage 2 pins the
version in force onto `WorkflowRun` and `AgentProposal` (subpoint 3) and emits
the per-evaluation and per-refusal metrics (subpoint 5).

## Design

The pattern is arXiv 2510.24383 — a declarative, versioned policy per agent,
evaluated at the tool boundary. The point of it, for this codebase, is a
sentence: **1-4 produce records, and a record does not stop anything.** 1/10
registered what an agent is, 2/10 bounded what its credential may reach, 3/10
scored how much authority it has earned. The card is where those become a
refusal.

```
                     ┌──────────────────────────────┐
  RegisteredAgent ─1:1┤ AgentPolicyCard  (mutable)   │  currentVersion → 3
                     │  usageWindowDate / actionsIn │  the per-UTC-day counter
                     └──────────────┬───────────────┘
                                    │ 1:N, append-only
                     ┌──────────────┴───────────────┐
                     │ AgentPolicyCardVersion  v1 v2│  IMMUTABLE
                     │  permittedTools              │  no app_user UPDATE
                     │  maxDataScope                │  + a refusing trigger
                     │  maxAutonomyLevel            │
                     │  maxActionsPerRun / PerDay   │
                     │  escalationTriggers          │
                     │  approvalRung                │
                     └──────────────────────────────┘
```

At the boundary the card is step 5 of `authorizeToolCall`, after the autonomy
ceiling and before the credential scope:

```
audience → liveness → exposure → autonomy ceiling → POLICY CARD → capability
        → resource scope → assertPermission → assertCanRead/Write → tool.run
```

## Files

| File | Role |
| --- | --- |
| `prisma/schema/agentic.prisma` | `AgentPolicyCard` (mutable head + day window) and `AgentPolicyCardVersion` (append-only policy) |
| `prisma/migrations/20260905160000_agent_policy_card/migration.sql` | Tables, CHECKs, the RLS triple + FORCE, and the append-only enforcement |
| `src/lib/agentic/policy-card.ts` | The rule vocabulary, the card value type, the four ordinal ladders, and `checkLadderStep` |
| `src/lib/agentic/policy-card-evaluation.ts` | The two pure evaluators (`evaluateCardReach`, `evaluateCardDailyBudget`) and `seedPolicyCardValue` |
| `src/lib/agentic/policy-card-store.ts` | The uncached per-request read and the atomic daily reservation |
| `src/lib/mcp/tool-data-scope.ts` | Which `AgentDataAccessScope` rung a tool CALL reaches, arguments included |
| `src/lib/mcp/authorize.ts` | Step 5 — `assertWithinPolicyCard`, before anything runs |
| `src/lib/mcp/auth.ts` | Loads the card onto the invocation; `actionsAlready` for a resumed run |
| `src/lib/agentic/risk-tier-consequences.ts` | The 5/10 seam, now wired; gains the two action budgets |
| `src/lib/agentic/agent-risk-scoring.ts` | `MAX_ACTIONS_PER_{RUN,DAY}_BY_TIER` — what each tier costs |
| `src/app-layer/usecases/agent-policy-card.ts` | Create (seeded) and edit (laddered), with the two coherence refusals |
| `src/app-layer/repositories/AgentPolicyCardRepository.ts` | Queries; `appendVersion` with a conditional pointer move |
| `src/app-layer/schemas/agent-policy-card.schemas.ts` | `z.enum(<the ladder>)` everywhere, so schema and boundary cannot drift |

## Decisions

**The card can only ever NARROW.** Every term it contributes sits over something
another layer already decided — the 2/10 tool grants, the autonomy ceiling, the
register's data-access axis. That is the discipline `resolveAutonomyCeiling`
already states as "a MINIMUM over independent narrowing terms". It is what makes
adding a card to a live agent safe: the worst a card can do is refuse.

**An ABSENT card contributes NO term.** Not "may do nothing". Deny-by-default
already lives in the tool grants; making the governance artefact's own absence a
denial would mean creating one is the outage, and never creating one is the safe
move — the exact inversion of what this is for. It is the third time this
subsystem has had to write that sentence down (`agent-tool-exposure.ts`'s
register switch, `autonomy-ceiling.ts`'s `agentAutonomy: null`).

**Seeded from what is already true.** A new card writes down the agent's current
grants, the register's own `dataAccessScope`, and the tier's autonomy cap,
budgets and approval rung — from `defaultPolicyCardForRiskTier`, which 3/10 left
as a named seam for exactly this. So creating a card changes nothing about what
the agent may do; it pins it. Nothing in `seedPolicyCardValue` invents a number,
and that is the property to preserve if it grows.

**Creating a card for an UNSCORED agent is refused.** The seam's
`assessmentRequired` flag is documented as "the card should refuse to be saved
until the agent is assessed", and taking it literally removed a whole class of
problem: a card of zeroes is indistinguishable in the register from one somebody
deliberately narrowed, and it would also sit at `DENY_CEILING` — a rung not on
the autonomy ladder — so the one-rung rule could never climb it out again.

**The ladder is the identity write ladder's SHAPE, not its values.** Ordinal
comparison, index is the order, one rung per widen, narrowing free. The identity
subsystem shipped the equality bug once (`mode !== LEAVER_MAX_MODE`, correct only
while the clamp sat at the second rung), so the ladder test pins the
two-rungs-below case explicitly — an `===` implementation passes every assertion
that only compares the ceiling to itself.

Three consequences of generalising it to seven dimensions:

- **A budget is ordinal too.** `ACTION_CAP_LADDER` exists because "one rung" has
  no meaning over the integers: 10 → 1000 is one edit and three orders of
  magnitude. There is deliberately no unlimited rung.
- **Dropping an escalation trigger is a WIDENING.** The sign is inverted against
  every other set on the card, so it is stated in the code and pinned in both
  directions in the test.
- **Narrowing does not pay for widening on the same dimension.** Removing five
  tools and adding two is a net widening of two. Each new reach is its own
  decision; the removals are unrelated decisions in the same edit.

**The data rung depends on the ARGUMENTS, and that is not a contrivance.**
`get_framework_status` returns the installable-framework catalogue with no
arguments and this tenant's coverage breakdown with a `frameworkKey`. A
tool-level answer has to pick one, and both choices are wrong in a way that
matters. The rule is read against RAW arguments, before validation, because
nothing may run ahead of the gate — safe because it only tests for property
presence and can only RAISE the rung.

Correspondingly, the usecase's coherence check uses a tool's BASE rung, not its
maximum: a ceiling below the maximum is the useful case (the tool works, its
wider arguments are refused), and only a ceiling below the base makes the grant
inert however it is called.

**Two evaluators, not one, because one of them costs a write.** `evaluateCardReach`
decides everything free; only if it passes does `reserveDailyAction` increment
the day counter. A call refused for naming an unpermitted tool must not spend a
unit of the day, or one misconfiguration exhausts the budget and the operator
reads `DAILY_ACTION_CAP_EXCEEDED` while the fault was `TOOL_NOT_PERMITTED`. The
split is two exported functions rather than one function with a nullable count,
because a nullable count skips silently.

**The reservation is increment-and-return.** Read-then-write is a budget two
concurrent calls can both pass. The window also rolls over inside the same
statement (`SET … = CASE WHEN date = today THEN +1 ELSE 1`), so the daily reset
is a property of the write — there is nothing to run at midnight and nothing to
fail to run.

**The per-run counter lives on the invocation, and is seeded on resume.** One
`McpInvocation` IS one run segment for the engine and one request for
`/api/mcp`. `executeFrom` passes `actionsAlready: fromSeq`, because it is
re-entered after every human checkpoint with a fresh invocation — without it a
run with three checkpoints would quietly get four budgets.

**The refusal names the rule and the version.** `reason: 'policy_card_denied'`
alone would be the same defect one level down as "denied" is one level up. The
`AUTHZ_DENIED` row carries `policyCardRule`, `policyCardVersion` and `escalate`;
the success row (`MCP_TOOL_INVOKED`) carries `policyCardVersion` too, so a reader
reconstructing what the rules were does not have to infer the allow case from
the absence of a denial.

**Immutability is enforced twice, and DELETE is deliberately not blocked.**
`app_user` holds no UPDATE privilege on the version table and a trigger refuses
one from any role — the privilege covers the application, the trigger covers
migrations, scripts and a superuser session. Unlike `AuditLog`, DELETE is
allowed: a version row is removed only by CASCADE from its card, its agent or
its tenant, and a trigger refusing that would make deleting a tenant impossible.
Immutability here means the record cannot be rewritten, not that it outlives its
subject.

**`loadPolicyCardInForce` reads the version BY NUMBER, not "the newest".** They
agree today, because the write path only appends and moves the pointer to the new
maximum. They are still different claims, and a boundary that reads one while
meaning the other is the coincidence that breaks the day somebody adds a
rollback. A head naming a missing version resolves to deny-everything rather
than to "no card" — a broken policy must not degrade into an absent one.

## What stage 2 owes

- Pin `policyCardVersion` on `WorkflowRun` and `AgentProposal` at execution
  (subpoint 3). The version is already immutable, so the pin will mean something.
- A metric per evaluation and per refusal (subpoint 5), keyed by rule — refusal
  volume is an early signal of both misconfiguration and ASI10.
- The admin surface. The usecase is complete and tested; it has no route yet, so
  a card cannot be created in the product today. That needs
  `admin.agent_policy_card` — its own permission key rather than
  `admin.agent_tool_exposure`, because the card decides autonomy and budgets as
  well as tools, and folding it in would make every routine "let it read tasks
  too" carry the authority to raise the ceiling.
