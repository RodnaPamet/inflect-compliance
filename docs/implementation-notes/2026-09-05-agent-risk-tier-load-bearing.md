# 2026-09-05 — Making the agent risk tier load-bearing (Agentic 3/10, stage 2)

**Commit:** `<pending>` feat(agentic): the assessed tier caps autonomy, server-side (3/10)

Stage 2 of two, same PR. Stage 1 built the instrument — the four models, the
global reference content, the scorer and staleness detection; see
[`2026-09-05-agent-risk-assessment.md`](2026-09-05-agent-risk-assessment.md).
This stage makes the tier it produces *do* something: it caps autonomy at the
MCP tool boundary and at the register's own write seam, it forces an assessment
before an agent can be switched on, and it declares — fail-closed, with
docstrings naming their eventual callers — the two consequences that 8/10 and
5/10 will consume.

An assessment that changes no behaviour is paperwork. This is the diff that
makes it not paperwork.

## What the tier now does

```
                        ┌───────────────────────────────────────────┐
  every MCP tool call → │ min( key.maxAutonomyLevel ,               │
                        │      agent.autonomyLevel  ,               │
                        │      tierCap )                            │ → rung
                        └───────────────────────────────────────────┘
                                              ▲
                    riskTierCeilingFor(resolvedAgent)
                       • no agent resolved    → UNCLAMPED (no term)
                       • agent, tier NULL     → DENY_CEILING (-1)
                       • agent, tier scored   → MAX_AUTONOMY_BY_TIER[tier]
```

and, at the usecase layer:

| act | before | now |
| --- | --- | --- |
| raise `autonomyLevel` above the tier cap | allowed | **refused**, nothing written |
| raise it within the cap | allowed | allowed |
| lower it (even from above the cap) | allowed | allowed |
| raise it on an unscored agent | allowed | **refused** — assess it first |
| activate an unscored agent | allowed | **refused** — assess it first |
| suspend / retire anything | allowed | allowed, unconditionally |

`MAX_AUTONOMY_BY_TIER` (LOW 6 · MODERATE 3 · HIGH 2 · CRITICAL 1) shipped with
the scorer in stage 1 and is unchanged. `autonomy-ceiling.ts` owns the
composition; the scorer owns the numbers.

> **Correction (same day).** LOW's cap is **4**, not 6. `UNATTENDED_AUTONOMY`
> (5) floors at MODERATE, so LOW is unreachable above rung 4 — an exhaustive
> sweep of the axis grid confirms it — and a cap of 6 therefore granted two
> rungs the tier could never itself be scored at. `assertRaiseWithinTier` would
> have accepted a raise from 4 to 6 into a state no fresh assessment could hold
> as LOW. Latent, not exploited, only because no MCP tool declares a rung above
> PROPOSE (2), and `src/lib/mcp/tools/types.ts` carries an `autonomy` override
> precisely so one can. See
> [`2026-09-05-agent-widening-rescore.md`](2026-09-05-agent-widening-rescore.md).

## The three nulls, and the one that would have caused an outage

2/10's `autonomy-ceiling.ts` header already warned that two nulls in this
subsystem mean opposite things: an absent KEY ceiling is "no narrowing", an
absent RISK TIER is "unscored, deny". Wiring the term surfaced a third, and it
is the one that takes the product dark:

- **No agent resolved at all** — a signed-in human, an ordinary integration key,
  or a tenant that never switched the register on. `evaluateAgentRegistration`
  reports this as `agentId === null`, and it also reports `riskTier === null`,
  because there is no agent to have a tier. Passing that bare `null` to
  `ceilingForRiskTier` would have denied **every non-agent caller on the MCP
  surface and every tenant that never turned the register on** — the register's
  own switch doubling as a kill switch for the product, which is precisely what
  the `agentAutonomy: null` term is documented as refusing to do.

The fix is a shape, not a comment: `riskTierCeilingFor` takes the resolved agent
as an **object-or-null**, so `null` (no agent) cannot be spelled the same way as
`{ riskTier: null }` (an unscored agent). `ceilingForRiskTier` keeps its 2/10
contract — bare tier in, NULL means unscored, unscored means deny — and is now
the inner call rather than the call site's call.

## The transition: how existing agents get out of the dark

2/10 wrote the warning down: wiring the tier while every agent in every register
is unscored takes the whole MCP surface dark. That is a product outage, not a
control, so the change ships with three routes out and no dated bypass.

**1. Forward — the assessment is required at ACTIVATION, not at registration.**
`createRegisteredAgent` still leaves the tier NULL and the status DRAFT, exactly
as 1/10 decided: an agent arrives unassessed, and a tier invented at insert time
is a judgement nobody made. But activation is the act that makes an agent's
credentials live, so that is where the requirement belongs.
`activateRegisteredAgent` now refuses an unscored agent and names the fix. Both
halves stay true: an operator can register, describe, own and prepare an agent
without being interrogated, and cannot switch one on without an assessment.
Nothing new can enter the ACTIVE-and-unscored state.

Placing it here rather than at registration also kept 1/10's tests honest —
`agent-registry-isolation.test.ts` asserts a freshly registered agent is
unscored, and that assertion is still the truth rather than something rewritten
to accommodate this change.

**2. Self-service — the admin surface makes scoring reachable.**
`GET/PUT /api/t/:slug/admin/agents/:agentId/risk-assessment` and
`POST …/risk-assessment/complete`, both on `admin.agent_registry`. A control
whose remedy has no surface is an outage with a rationale; these are the remedy's
surface, and the activation refusal points at them. They take the register's own
permission key rather than a narrower one because completing a run WRITES the
tier onto the agent — this is the authority to set an agent's authority.

**3. Bulk — `scripts/backfill-agent-risk-tiers.ts`** for the agents that were
already ACTIVE when this landed. It scores each one through the real
`completeAgentRiskAssessment`, with nothing answered. No SQL transcription of the
bands and floors exists anywhere: a second copy would be a second opinion that
drifts on the first weight change.

### Why a provisional score is safe, and why it is not a loophole

The scorer counts an unanswered question as NO, so a run with no answers carries
the full `MAX_ANSWER_POINTS` (12). Twelve points alone exceed the LOW band, so:

- **A provisional score can never come out LOW**, and LOW is the tier that costs
  the agent fewest rungs. Nobody can use the backfill to buy an agent the widest
  ladder any tier grants — filling in the questionnaire is the only route to it,
  which is what makes the questionnaire worth filling in. Swept over the whole
  axis grid in `tests/unit/agent-risk-scoring.test.ts`, with the paired positive
  that answering everything YES *does* reach LOW (a tier nobody can reach is a
  tier nobody fills in the form for).

  > **Correction (same day).** This read "LOW is the only tier that leaves the
  > ladder whole … the only route to rung 6". No tier reaches rung 6, and none
  > should: rungs 5-6 are unattended operation, which floors at MODERATE, so no
  > assessment can score an unattended agent below MODERATE and MODERATE caps at
  > 3. The ladder's top two rungs are declarable and unreachable, which is the
  > floor table meaning what it says.
- **It is a floor, not a cliff.** The least-exposed agent lands at MODERATE,
  whose cap (3) admits the highest rung any MCP capability class requires, so a
  narrow read-only integration keeps working. An agent with write access, egress,
  irreversibility or unattended operation lands at HIGH or CRITICAL and *is*
  bounded to PROPOSE or READ until a human assesses it. The dangerous agents are
  the ones the deploy constrains — the correct direction for a control nobody has
  yet applied by hand.
- **The tier gets evidence, not a bare column.** The backfill leaves a real
  COMPLETED `AgentRiskAssessment` with the basis frozen, legible as provisional
  because `unansweredQuestions === applicableQuestions`. No new column was needed
  to mark it, and none was added.

**No grace window, and that is a decision.** A dated bypass expires when nobody
is watching — this repo's own DAST deferral lapsed 36 days and read as green the
whole time, and the fix there was to make the date PARSED rather than decorative.
With routes 1–3 there is nothing to grant grace to. The 1/10 legacy placeholder
agents are SUSPENDED by construction, so they cannot pass the registration gate
and are unaffected either way; the backfill deliberately does not touch DRAFT,
SUSPENDED or RETIRED agents, because scoring them would invent judgements nobody
needs and would put a tier on rows that exist precisely to look unassessed.

## Stale WARNS; it does not block — and stage 2 had to preserve that

Stage 1 argued the decision; this stage is where it could have been silently
reversed, so it is restated with the property that keeps it true.

*"Never scored"* and *"stale"* are different epistemic states.
`ceilingForRiskTier(null)` denies the first outright. Collapsing the second into
it would throw away the only assessment anybody did, and would make the
register's own maintenance the outage — granting a tool is the correct, audited
act that fires a trigger, and an operator whose agent goes dark for doing the
right thing stops doing the right thing.

> **Correction (same day).** The paragraph that followed claimed the widening
> was "inert anyway", and called that "a property of the composition, not a
> hope". It was neither: it was true only of `AUTONOMY_RAISED`, the single
> example both notes reached for. `agent.autonomyLevel` is a term in the `min`;
> `dataAccessScope`, `reversibility` and `provenance` are terms in NOTHING, and
> `updateRegisteredAgent` checked only `autonomyLevel`. So an agent could be
> walked READ_TENANT_DATA → EXTERNAL_EGRESS and REVERSIBLE → TERMINAL and keep
> its LOW tier and its full ceiling while a fresh score of that same agent came
> out CRITICAL. `TOOL_GRANTED` was worse: the grant took effect in the same
> transaction that recorded the assessment as overtaken.

**What makes the claim true now: a widening RE-SCORES.** The scorer is a pure
function of the four declared axes plus the answers, so when an axis moves the
tier is recomputed on the spot from the answers already on file — in the
transaction that records the widening — and written back whenever it comes out
worse. The ceiling narrows immediately, and stale narrows to mean only *the
questionnaire answers may be out of date*. The `min` composition is still
load-bearing and still must not become a lookup; it is simply no longer asked to
carry an argument about axes it does not contain. See
[`2026-09-05-agent-widening-rescore.md`](2026-09-05-agent-widening-rescore.md).

Stage 2's autonomy-raise refusal makes a related point one layer up: a raise
above the cap does not even land.

Stage 1 left `refreshAgentAssessmentStaleness` with no caller. It has two now —
`updateRegisteredAgent` and `grantAgentTool` — both through a function taking
the OPEN transaction, so the re-scored tier and the staleness note commit or
roll back with the change that caused them, and so a second transaction is never
opened from inside the first against a transaction-mode pooler. (Both functions
were renamed to `reassessAgentAfterChange{,InTx}` when the re-score landed: they
no longer only refresh staleness, and a name that undersells what a function
writes is how the next caller misjudges it.)

## Seams: two declared, one carried forward

The house style is 2/10's, and it is the reason this stage had nothing to
re-decide: a named export, a docstring saying who wires it, and the FAIL
DIRECTION settled in the function rather than left to the eventual caller.

- **8/10 — approver tiering.** `reviewRequirementForRiskTier` in
  `src/lib/agentic/risk-tier-consequences.ts`. Returns `{ approvals,
  requireSecondApprover, autoApprovable }`. An unscored agent — and any tier this
  build does not recognise — gets two approvers and no auto-approval. The
  threshold is `SECOND_APPROVER_FROM_TIER = 'HIGH'`, chosen because that is where
  the autonomy cap already stops agreeing with the registration; the two controls
  should not disagree about where "a person decides" begins.
- **5/10 — policy-card defaults.** `defaultPolicyCardForRiskTier`, same module.
  Deliberately DERIVED from the autonomy cap and the approver threshold rather
  than tabulated: a card that offers rung 5 to an agent the funnel caps at 2 is
  worse than no card — it is a written promise the product then breaks. Unscored
  opens at `DENY_CEILING` with `assessmentRequired: true`.
- **10/10 — evidence emission.** `src/lib/agentic/agent-assessment-evidence.ts`.
  The emission point for agentic artefacts is 10/10's to design, so it is not
  invented here — but it is not silently skipped either. The DESCRIPTOR is built
  for real on every completion (it is the part of the seam that can be *wrong*,
  so it is the part that is tested) and travels in the usecase's return value and
  its audit row beside `emitted: false` — a literal type no code path can flip.
  Nothing downstream can come to believe an artefact was filed when none was.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/autonomy-ceiling.ts` | `ceilingForRiskTier` now returns the tier's cap; new `riskTierCeilingFor` states the third null; `RISK_TIER_CEILING_UNWIRED` deleted |
| `src/lib/agentic/risk-tier-consequences.ts` | NEW — the 8/10 and 5/10 seams |
| `src/lib/agentic/agent-assessment-evidence.ts` | NEW — the 10/10 seam's descriptor and unemitted outcome |
| `src/lib/agentic/agent-registration-gate.ts` | the verdict carries `riskTier`, read from the same row and query as `autonomyLevel` |
| `src/lib/mcp/auth.ts` | the live wiring: `riskTierCeilingFor(resolvedAgentTier)` |
| `src/lib/mcp/authorize.ts` | `McpInvocation.riskTier`; the autonomy denial names the binding term |
| `src/app-layer/usecases/agent-registry.ts` | raise-above-tier refusal; activation requires a score; staleness refreshed after an amendment |
| `src/app-layer/usecases/agent-risk-assessment.ts` | evidence descriptor built and reported; `refreshAgentAssessmentStalenessInTx` extracted |
| `src/app-layer/usecases/agent-tool-exposure.ts` | a grant refreshes staleness in the same transaction |
| `src/app-layer/usecases/api-keys.ts` | the credentials report computes the same three-term ceiling, and flags `unscored` |
| `src/app/api/t/[tenantSlug]/admin/agents/[agentId]/risk-assessment/**` | NEW — the remedy's HTTP surface |
| `src/app/t/[tenantSlug]/(app)/admin/mcp/page.tsx` | renders "Unassessed — no authority" rather than a bare `-1` |
| `scripts/backfill-agent-risk-tiers.ts` | NEW — the bulk route out, through the real usecase |

## Decisions

- **The activation gate, not a registration gate.** Requiring a score at
  registration would have meant either interrogating an operator before they can
  write anything down, or auto-scoring — inventing a judgement nobody made and
  contradicting 1/10's explicit choice. Activation is the act that makes the
  credentials live, so it is the act that carries the precondition.
- **The raise refusal is one-directional.** An agent declared at rung 6 and later
  assessed HIGH is an ordinary state — registration declares, assessment judges,
  and they are allowed to disagree. A rule written as "the result must be within
  the cap" would refuse `6 → 4`, fighting the operator moving *toward* the cap. So
  only a raise is checked, exactly as the staleness triggers are one-directional.
- **The refusal precedes the write, and the test proves it.** The illegal
  `autonomyLevel` is carried in the same payload as a `name` change; the
  assertion checks that neither landed and that no `AGENT_UPDATED` audit row
  exists. A check placed after the write would also throw, and would also leave
  the caller with an error — and the row would be wrong.
- **The denial message names the binding term.** A ceiling of `DENY_CEILING` can
  only have come from the tier (the other two terms are bounded at 0), so an
  unscored agent is told to assess itself rather than to raise a number the
  boundary is already ignoring. The `AUTHZ_DENIED` row carries `riskTier` and
  `unscored` for the same reason.
- **The credentials report was wired too, not just the enforcement.** The whole
  hazard `effectiveAutonomy` exists for is somebody assuming the key's own number
  is the answer; a report that omitted the tier term would have become the new
  version of that hazard. It also meant the page had to stop rendering a bare
  `-1`, which is why `unscored` is a field rather than a magic number a UI has to
  recognise.
- **Every refusal in the new suite is stated with its positive companion.** A
  suite of refusals alone passes against a gate that refuses everything — which
  is the failure mode that actually threatened this change, because wiring the
  term while every agent was unscored would have looked, from inside the tests,
  exactly like the control working.
- **Five existing fixtures were SCORED rather than the assertions relaxed.** The
  MCP suites seed agents to test audiences, revocation and principal narrowing;
  left unscored, every one of them would have started passing for the wrong
  reason — the tier gate firing before the thing under test. They now seed
  `riskTier: 'LOW'`, which leaves the ladder whole so the arithmetic they assert
  on is unchanged, and each carries the comment saying why.

## What is deliberately NOT here

- **A per-agent assessment PAGE.** The routes are the admin surface; the page
  that would render the twenty questions belongs with 5/10's policy card, which
  is where an agent's per-agent detail surface lands. Shipping a second detail
  page now would mean 5/10 either adopts a layout it did not choose or migrates
  one that already exists — the same argument that keeps the evidence emission
  point out of this stage.
- **A `provisional` column on `AgentRiskAssessment`.** It is derivable
  (`unansweredQuestions === applicableQuestions`), and a column that must be
  written by every completion path is a column the seventh path forgets.
