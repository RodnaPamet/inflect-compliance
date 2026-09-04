# 2026-09-05 — A widening re-scores the agent (Agentic 3/10, correction)

**Commit:** `<pending>` fix(agentic): a widening re-scores the agent, and `modelRef` gets a write path

Three defects in the agent risk assessment that shipped the same day, all found
by an adversarial review that RAN the code rather than reading it. Two were
blocking. They are related: each is a mechanism that looked covered because its
only tests constructed states no product surface could reach.

- Stage 1: [`2026-09-05-agent-risk-assessment.md`](2026-09-05-agent-risk-assessment.md)
- Stage 2: [`2026-09-05-agent-risk-tier-load-bearing.md`](2026-09-05-agent-risk-tier-load-bearing.md)

Both of those notes now carry inline corrections pointing here.

## 1. `MODEL_CHANGED` had no write path

`RegisteredAgent.modelRef` existed as a column, was read by `getScoringState`,
was frozen into `basisModelRef`, and was compared by
`evaluateAssessmentStaleness`. **Nothing could write it.** It was absent from
`CreateRegisteredAgentSchema`, `UpdateRegisteredAgentSchema` and
`RegisteredAgentWriteFields`; both schemas are strict Zod objects, so a caller
that supplied `modelRef` had it silently STRIPPED. The column was NULL for the
life of every agent, `before !== after` was permanently false, and one of the
four triggers the brief names could not fire in production.

Its coverage hand-built `'model-a'` and `'model-b'` and asserted the comparison
noticed the difference. That is this repo's own documented trap — a guard that
validates the diagnosis rather than the remedy — and it passed for the same
reason it was worthless.

The field now exists on all three create/update seams (`createRegisteredAgent`,
`registerAgent`, `updateRegisteredAgent`), in the repository write shape, and on
the detail read. `PATCH /api/t/:slug/admin/agents/:agentId` forwards the body
straight to the usecase, so the HTTP surface came with it.

Two details worth keeping:

- **`''` folds to `null` on write AND in the comparison.** "Declared as nothing"
  and "never declared" are one fact. Without both halves, a form that posts an
  empty string over a never-declared column reports the model as CHANGED, and
  the register shows a stale assessment because somebody opened an edit dialog
  and saved it. The staleness module's comment already CLAIMED this
  normalisation; `?? null` does not perform it, so the code now matches the
  comment rather than the other way round.
- **It is sanitised** (`sanitizePlainText`) like every other operator free-text
  field on this row, because the register export and the assessment surface both
  render it.

## 2. "The widening is inert until somebody re-scores" was false

This was reason 3 of three for the decision the brief asked to be written down —
*stale WARNS, it does not block* — and it was the reason that made the decision
safe rather than merely convenient. It said: the tier in force was scored
against the narrower basis, and the ceiling composes as a `min`, so the new
authority cannot take effect until somebody re-scores.

That is true of **one** of the five triggers. `agent.autonomyLevel` is itself a
term in the `min`. The others are not terms in anything:

| trigger | in the ceiling? | what actually happened |
| --- | --- | --- |
| `AUTONOMY_RAISED` | yes — `agent.autonomyLevel` | genuinely inert. The one example both notes gave. |
| `DATA_SCOPE_WIDENED` | **no** | `updateRegisteredAgent` accepted READ_TENANT_DATA → EXTERNAL_EGRESS with no check; tier and ceiling unchanged. |
| `REVERSIBILITY_WORSENED` | **no** | likewise REVERSIBLE → TERMINAL. |
| `PROVENANCE_WIDENED` | **no** | did not even EXIST as a trigger, though `basisProvenance` was stored. |
| `TOOL_GRANTED` | n/a | the grant took effect in the same transaction that stamped the run stale. |

So an agent could be walked from READ_TENANT_DATA/REVERSIBLE to
EXTERNAL_EGRESS/TERMINAL through the ordinary amendment route, keep whatever
tier it had and the whole ladder that tier bought, while a fresh score of that
same agent came out CRITICAL — cap 1, READ only.

### The fix: re-score, do not block

The principled route, and it needs no new human step. **The scorer is a pure
function of `(autonomyLevel, dataAccessScope, reversibility, provenance)` plus
the answers.** Four of those five are declared fields the operator has just
changed. The fifth is on file, frozen with the standing completed run, and
unchanged. So the tier for the agent AS IT NOW STANDS is computable — there is
nothing to ask anybody — and it is computed, in the same transaction that
records the widening.

`reassessAgentAfterChangeInTx` (formerly `refreshAgentAssessmentStalenessInTx`)
now does two things where it did one, and the rename is part of the fix: a name
that undersells what a function writes is how the next caller misjudges it.

Three rails, each closing a different way of getting this wrong:

1. **It only ever RAISES.** `isTierAbove` gates the write. A narrowing, or a
   widening that happens to score the same, leaves the standing tier alone —
   because the questionnaire behind it has not been re-answered, and an
   over-restrictive cap is the safe error. Same one-directional rule the
   staleness triggers and `assertRaiseWithinTier` already follow. The way back
   down is to re-assess, which the tests assert as the paired positive: without
   it, "never lowers" would be satisfied by a one-way ratchet.
2. **It never scores an UNSCORED agent.** `riskTier IS NULL` is DENY; turning a
   deny into any tier would GRANT authority nobody assessed.
3. **The AXES decide whether it runs at all.** If the live axes equal the basis,
   the answers are the same answers and the arithmetic cannot have moved, so the
   whole thing is skipped — which is why a tool grant costs no extra queries.

**The re-score does not consult the trigger list.** It re-runs the scorer over
the live agent and compares tiers. That is deliberate: a trigger list is a
hand-maintained enumeration of the axes, and the defect being fixed here is
precisely an axis missing from one (`provenance`). A future fifth axis is picked
up by the re-score whether or not anybody remembers to add its trigger.

**The completed run is NOT rewritten.** Its `scoredTier` and `basis*` stay as
they were: they are the record of a judgement a human made, at a moment, about a
state. `RegisteredAgent.riskTier` is the operational value and it is what moves.
The `AGENT_RISK_TIER_RAISED` audit row names both tiers and the run whose
answers were reused, so the trail shows an existing judgement re-applied rather
than a new one invented.

**What "stale" means now** is narrow and honest: *the questionnaire answers may
be out of date*. Not *the tier is wrong*. The first is a warning; the second was
not, and that is why the old decision needed the false claim to hold it up.

### `TOOL_GRANTED` — checked, and it is genuinely different

**A granted tool is not an input to the score.** `scoreAgentRisk` reads four
declared axes and the questionnaire; `RegisteredAgentTool` appears in none of
them. So unlike an axis widening, a grant cannot be answered by re-scoring —
there is nothing to recompute, and saying so is more useful than inventing an
arithmetic for it.

What bounds a grant instead is the **rung**. Every tool call goes through
`min(key max, registered autonomy, tier cap)` and each tool declares the rung it
requires, so the assessed tier already decides how far a grant can reach; the
grant only decides which tools within that reach. The tier is being spent, not
bypassed.

The residual is a configuration error rather than an escalation — granting a
PROPOSE tool to an agent capped at READ writes a row that looks deliberate in
the register and refuses at the boundary forever — so `grantAgentTool` now
refuses it outright, mirroring `assertRaiseWithinTier`. An **unscored** agent is
deliberately exempt: its ceiling is DENY, so the rule would refuse every grant
and make preparing a DRAFT agent impossible. Activation is where the score is
demanded; the register's own preparation must not be the outage.

**One residual is named rather than closed.** `dataAccessScope` is a
DECLARATION that nothing at the tool boundary enforces — no tool declares the
data reach it needs, so nothing checks a `list_risks` grant against an agent
that declared `READ_METADATA`. Binding those would mean giving every tool a
data-reach class, which belongs to the tool catalogue's design rather than to
this correction. It is written here so the next reader knows it is a gap and not
an oversight.

## 3. `MAX_AUTONOMY_BY_TIER.LOW` granted a rung LOW cannot be scored at

`UNATTENDED_AUTONOMY` is 5 and floors at MODERATE, so an exhaustive sweep of the
axis grid shows LOW is reachable only at `autonomyLevel <= 4`. LOW's cap was 6.
The table therefore granted two rungs the tier could never itself hold, and
`assertRaiseWithinTier` would have accepted a raise from 4 to 6 into a state no
fresh assessment could reproduce.

Harmless *today* only because no MCP tool declares a rung above PROPOSE (2) —
and `src/lib/mcp/tools/types.ts` carries an `autonomy` override precisely so one
can. The cap is now 4, and the invariant is pinned as a **property over the
whole grid**: for every tier, the cap is at most the highest rung at which that
tier is produced by any input, and there is at least one input that produces
that tier AT the cap (so a needlessly stingy cap is caught too).

The honest consequence, stated because it is easy to mistake for a bug: **rungs
5 and 6 are declarable and unreachable.** Unattended operation floors at
MODERATE and MODERATE caps at 3. The ladder's top is a thing the register can
record and no assessment can authorise, which is the floor table meaning what it
says.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/agent-risk-scoring.ts` | `LOW` cap 6 → 4 with the reachability argument; new `isTierAbove` |
| `src/lib/agentic/agent-assessment-staleness.ts` | `PROVENANCE_WIDENED`; `provenance` on the basis; empty-model normalisation; the corrected warn-not-block argument |
| `src/app-layer/schemas/agent-registry.schemas.ts` | `modelRef` on all three create/update schemas |
| `src/app-layer/repositories/RegisteredAgentRepository.ts` | `modelRef` in the write shape and on the detail read |
| `src/app-layer/usecases/agent-registry.ts` | `modelRef` through create / register / update; calls the reconcile |
| `src/app-layer/usecases/agent-risk-assessment.ts` | the re-score, one shared scoring seam, `reassessAgentAfterChange{,InTx}` |
| `src/app-layer/usecases/agent-tool-exposure.ts` | `assertGrantWithinTier` — a grant the tier cannot exercise is refused |
| `src/lib/mcp/tool-catalogue.ts` | `mcpToolCapabilityClass` — the rung a tool name implies, still importing nothing |
| `tests/integration/agent-widening-reassessment.test.ts` | the whole correction, driven through the usecases and the real MCP route |

## Decisions

- **Re-score rather than block.** Blocking a widening until re-assessment would
  make the register's own maintenance the outage — the second surviving reason
  for warning — and would still have left `TOOL_GRANTED` immediate. Re-scoring
  removes the need to choose: the tier follows the agent, so nothing has to be
  refused to keep it honest.
- **The re-score is keyed on the AXES, not on the triggers.** Comparing live
  axes to the frozen basis means a future scorer input is covered by the
  re-score even if its trigger is forgotten — which is the exact failure being
  corrected.
- **`provenance` joins the basis.** `basisProvenance` was already stored and
  read by nothing. The basis is now exactly the scorer's agent-side inputs, and
  a test asserts that identity against `AgentRiskScoreInput` so widening one
  without the other fails to compile.
- **The unscored agent is exempt from the grant rung-check.** Everywhere else in
  this subsystem NULL fails closed. Here it would refuse the ordinary act of
  preparing a DRAFT agent, and the boundary already denies an unscored agent
  every tool, so the check has nothing to add and a workflow to break.
- **`riskTierScoredAt` moves with a re-score.** The tier in force is as of now,
  computed from the answers of a run whose own `completedAt` is unchanged. The
  CHECK constraint pins the two columns together, so there was no option to move
  one and not the other — and a tier whose date belonged to a different agent
  state would be the same class of lie this correction is about.
- **Both prior notes were corrected in place with struck-through text rather
  than rewritten.** The brief asked for the decision to be written down; a note
  silently edited to agree with the code loses the fact that the reasoning was
  once wrong, which is the part worth reading in six months.
