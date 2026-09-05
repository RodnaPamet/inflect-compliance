# 2026-09-05 — a policy card may not be born permitting what it forbids

**Commit:** `<pending>` fix(agentic): the card create path wrote a state the edit path calls impossible

## What was contradictory

Two write paths over one object disagreed about what a valid policy card is.

- `createAgentPolicyCard` seeded `maxDataScope` from `RegisteredAgent.dataAccessScope`,
  seeded `permittedTools` from the grant list, and checked **nothing**. The three
  inputs it draws on — the assessed tier, the register's data axis, the grants —
  are independent, and nothing made them agree.
- `updateAgentPolicyCard` ran `assertDeclarationsExercisable`, which refuses a card
  permitting a tool whose base data rung is above the card's own ceiling.

So an agent registered at `READ_METADATA` and granted `list_risks` got

```
v1 { permittedTools: ['list_risks'], maxDataScope: 'READ_METADATA' }
```

— a card whose every `list_risks` call is refused `DATA_SCOPE_EXCEEDED`, and which
the **edit** path rejects verbatim with *"…would write a declaration the tool
boundary refuses."* Creating the governance artefact took the agent dark, and the
only notice was a refusal at the agent's next call.

Two defects in one:

1. **create and update disagreed** about validity; and
2. **a card could be born self-contradictory** — permitting a tool its own
   `maxDataScope` forbids — which is a governance object that refuses everything
   it declares.

And underneath both: nothing at grant time cross-checked the register's DATA axis
against a tool's base rung. `assertGrantWithinTier` guarded the AUTONOMY axis only.

## Design

### One predicate, two dispositions

`withholdingReasonForTool(toolName, ceilings)` in
`src/lib/agentic/policy-card-evaluation.ts` is now the single definition of *"this
card could never call that tool"*. It answers three reasons — `NOT_IN_CATALOGUE`,
`AUTONOMY_ABOVE_CARD`, `DATA_SCOPE_ABOVE_CARD` — and both paths read it:

- **create** uses it as a **filter**. A contradiction never enters a seeded card.
- **edit** uses it as a **refusal**. An operator typing one is told as they type it.

The disagreement was possible because the rule was spelled once, in the usecase,
on one of the two paths. `createAgentPolicyCard` additionally now runs
`assertDeclarationsExercisable` on its own seed — a no-op on a correct seed, and
deliberately so: anything it catches is a seeder bug surfacing as a named refusal
rather than as a silently dark agent.

It reads the tool's **BASE** rung, never its maximum. A ceiling below a tool's
maximum is the useful case — `get_framework_status` under a `READ_METADATA` card is
a working catalogue read whose `frameworkKey` argument is refused at the boundary.
Only a ceiling below the base makes a tool unreachable however it is called.

### Why option C (withhold and say so)

The three candidates, and what an operator sees under each:

| | what happens | what the operator sees |
| --- | --- | --- |
| **A** — seed `maxDataScope` from the union of the granted tools' base rungs, capped by the register's axis | **rejected** | It *narrows a live agent.* `get_framework_status` bases at `READ_METADATA` and reaches `READ_TENANT_DATA` with a `frameworkKey`; a ceiling seeded from base rungs takes that working argument dark. Creating the governance artefact would itself be the outage — and where the grant genuinely exceeds the axis, the cap re-creates the same contradiction anyway. |
| **B** — refuse the CREATE | **rejected** | A clear error at the moment of creation, but the register's own inconsistency becomes the reason the agent cannot be governed **at all**, and the way back is to fix a register the operator may not own. 3/10 already learned that a correct gate which bricks the product is still a broken change. |
| **C** — seed the card, withhold the tool, report it | **taken** | `POST` returns `201` with `withheld: [{toolName:'list_risks', reason:'DATA_SCOPE_ABOVE_CARD', requires:'READ_TENANT_DATA', permits:'READ_METADATA'}]`; the `GET` preview shows the same list *before* the button is pressed, as `wouldWithhold`; the audit summary reads *"…1 granted tool(s) withheld as unexercisable (list_risks)"*. The agent keeps every call it could actually make. The withheld call is refused `TOOL_NOT_PERMITTED` — naming the card and the version — instead of `DATA_SCOPE_EXCEEDED` on a card that claimed to permit it. |

Nothing is lost under C: the grant row stands, and permitting the tool is two
ordinary ladder steps once the declared axis is raised (widen `maxDataScope` one
rung, then add the tool — the ladder refuses both in one edit, and the error
message names the order).

### The second axis at the grant seam

`assertGrantWithinDeclaredDataScope` in `agent-tool-exposure.ts` refuses a grant
whose base data rung exceeds `RegisteredAgent.dataAccessScope`, the way
`assertGrantWithinTier` already refused one the tier could not exercise. Two axes,
one seam. The message names both remedies, because only the operator knows which
of their two records is the false one:

> `"list_risks"` reaches READ_TENANT_DATA on every call, and this agent is registered
> as reaching READ_METADATA. … Raise the agent's data-access scope — that re-scores
> it on the spot, which is the point — or grant a tool that stays within READ_METADATA.

This is more than card hygiene. `dataAccessScope` is a **weighted scorer input with
its own tier floor**, so an agent that actually reads tenant data while declaring
metadata is scored as the agent it is not, and comes out at a tier that buys it a
higher autonomy cap. The refusal is the only thing standing between the two numbers.

Unlike the tier rule it applies to an **UNSCORED** agent too, and that asymmetry is
deliberate: the tier is absent until somebody computes it (refusing on an absent
tier would make preparing a DRAFT agent impossible), whereas the data axis is
declared at registration and is never absent.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/policy-card-evaluation.ts` | `withholdingReasonForTool` — the one definition of unexercisable. `seedPolicyCardValue` now returns `{ value, withheld }` and filters. |
| `src/app-layer/usecases/agent-policy-card.ts` | Create runs the same gate the edit runs; `withheld` in the response and the audit row; `wouldWithhold` in the GET preview. `assertDeclarationsExercisable` rewritten on the shared predicate. |
| `src/app-layer/usecases/agent-tool-exposure.ts` | `assertGrantWithinDeclaredDataScope` — the data axis at the grant seam. `dataAccessScope` added to the tenant-scoped select. |
| `tests/integration/policy-card-seed-coherence.test.ts` | The reviewer's repro end-to-end through the real usecases, the real DB and the real MCP route, including the operator's whole way back. |
| `tests/unit/policy-card-evaluation.test.ts` | Seeding cases per reason, plus the invariant over every (tier × data rung) pair against the boundary's own evaluator. |
| `tests/unit/agent-tool-exposure-usecase.test.ts` | The grant-seam refusal, its paired positive (`get_framework_status` at `READ_METADATA`), and the unscored asymmetry. |
| `tests/integration/agent-widening-reassessment.test.ts` | Fixtures corrected: an agent granted a PROPOSE tool now declares `WRITE_TENANT_DATA`, which is that tool's base rung. Tiers unchanged (2+6+0+12 = 20 is still HIGH). |

## Decisions

- **The seeded card keeps its ceiling from the register, not from the tools.** The
  register carries the operator's own statement of how far the agent reaches;
  deriving a second number from the grants would answer a question that already had
  an answer, and would narrow a live agent (option A above).
- **The UNSCORED preview now permits nothing.** It previously seeded the tool list
  under a `NONE`/`DENY_CEILING` ceiling on the reasoning that "blanking it would lose
  the operator's work". That reasoning does not survive the coherence rule, and it
  no longer needs to: the grants live in `RegisteredAgentTool`, and `withheld` names
  every one of them. The preview now says *"creating this card would permit nothing,
  and here is why"* rather than listing tools the card would refuse.
- **Narrowing `dataAccessScope` below a standing grant is still allowed.** Taking
  authority away is never the move to refuse. That is precisely the case the seed has
  to handle, and the integration suite reaches the contradictory state that way —
  through the product's own write paths, with the new grant gate in place — rather
  than by hand-writing a row.
- **No repair path for cards already written.** `AgentPolicyCardVersion` refuses
  UPDATE at two levels by design, so a repair would have to append a version nobody
  decided about. The policy card is unreleased (this branch), so no such card exists;
  and if one did, the edit path already names the exact tool to remove.
- **The two grant refusals stay separate functions with separate messages.** They
  share the rung lookups, not the sentence: one says *re-assess the agent*, the other
  says *raise the declaration or narrow the grant*, and merging them would blur which
  of the operator's records is wrong.
