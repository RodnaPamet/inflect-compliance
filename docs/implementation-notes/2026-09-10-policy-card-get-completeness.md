# 2026-09-10 — the policy-card GET carries what the editor is judged by

**Issue:** #2377 — "Policy-card GET withholds what the editor needs".

## Design

`GET /admin/agents/:id/policy-card` answered with the card, its version trail
and (before a card exists) the seed preview. Three facts the surface needs were
missing, and a fourth question was answered inconsistently by two neighbouring
refusals.

```
   agent (RegisteredAgent)                 card (AgentPolicyCard + versions)
   ├─ riskTier ──────► ceilingForRiskTier ─┐
   │                                       ├─► what the PUT will accept
   └─ dataAccessScope ─────────────────────┘
   grants (RegisteredAgentTool) ─► withholdingReasonForTool(tool, inForce)
   versions[].createdByUserId  ─► User.name ?? User.email
```

1. **`riskTier` + `dataAccessScope` on both branches.** The PUT refuses autonomy
   above the tier cap and a data rung raised past the register's declaration.
   Neither was on the payload, so `PolicyCardTab` offered both rungs and the
   operator met the rule as a 400 — an English sentence rendered verbatim into a
   Bulgarian UI. `LadderField` now takes a `ceiling` and clips the ONE rung
   above the base, never a rung the card already holds.
2. **`withheld` on the card branch.** Grants the card in force does not permit,
   evaluated by the same predicate the boundary refuses on. Previously this
   disclosure existed only on the no-card branch (`wouldWithhold`) and in the
   creation audit row, i.e. it was available exactly once, before it mattered.
3. **`versions[].createdByName`.** One batched `User` lookup in the usecase
   (the `listScoreEvents` / `attachOwnerUsers` shape), resolved to
   `name ?? email` server-side so the client is not handed a second piece of
   PII to do nothing with. `createdByUserId` stays on the row and stays
   unrendered — a raw cuid on a compliance surface is noise.

## The decision: the tier cap now judges the MOVE, not the value

`assertDeclarationsExercisable` refused whenever `card.maxAutonomyLevel >
tierCap`, on the create path AND the edit path. Its two siblings —
`assertRaiseWithinTier` (register) and `assertDataScopeRaiseWithinDeclaration`
(this file) — deliberately refuse only a RAISE, and both say why. Three
refusals over one question; two agreed.

Split into `assertAutonomyRaiseWithinTier(current | null, next, riskTier)`:
`null` (create) judges the value, an edit judges the move.

Why the raise-only reading is not a loosening, on this axis specifically:

- The tier cap is a LIVE term at the boundary — `resolveAutonomyCeiling` takes
  `min(key, agent.autonomyLevel, tierCap)` and `authorize.ts` applies it
  independently of the card — so a card left above the cap grants nothing. That
  is the opposite of the data axis, where the card is the only term at the
  boundary and a widening past the declaration is HONOURED; that asymmetry is
  precisely why the data rule needs its bound at this seam.
- The drift is already reported where drift belongs: `AUTONOMY_ABOVE_TIER` in
  `agent-control-tests.ts`, beside `DATA_SCOPE_ABOVE_DECLARATION` and
  `TOOL_UNEXERCISABLE`. A control test that looks for the state is the product
  agreeing the state is reachable.
- The cost was real: after a downward re-assessment, a value gate refuses every
  edit — including dropping a permitted tool, cutting a budget, or adding an
  escalation trigger — until autonomy comes back under the cap. Each of those
  makes the agent narrower, and each met a refusal about an axis it did not
  touch.

The tab does not go silent about the drift: the editor renders
`aboveTierCapTitle` when the card in force sits above the cap, says what the
boundary is already enforcing, and offers the narrowing that repairs it.

## Both drifts get a notice, and the per-control hint is gated on neither

`LadderField`'s hint (`autonomyCapHint`, `dataScopeCapHint`) ends in "so no rung
above it is offered". On a card sitting ABOVE its bound that is FALSE by design
— the ladder keeps every rung the card holds so the operator can narrow it — so
the hint now renders only while its claim is true of the ladder beside it, and a
drift notice takes its place otherwise. The two are mutually exclusive and
between them exhaustive; the predicates are the drift REPORTER's, so the editor
warns exactly when `agent-control-tests.ts` would report:

| state | notice | hint |
| --- | --- | --- |
| `maxAutonomyLevel > ceilingForRiskTier(tier)` (or unscored) | `aboveTierCapTitle` | absent |
| `!dataScopeWithinCard(maxDataScope, declared)` | `aboveDeclaredScopeTitle` | absent |
| within both | none | `autonomyCapHint` / `dataScopeCapHint` |

The data axis got the second notice because it is the DANGEROUS one, and the
asymmetry is the same one that decided the raise/value split above:
`resolveAutonomyCeiling` clamps autonomy on every call, so a card above the tier
cap grants nothing; `dataAccessScope` appears nowhere under `src/lib/mcp/` and
`evaluateCardReach` compares the CARD's rung, so a card above the declaration
reaches further than the register says and nothing stops it. The editor used to
warn loudly about the harmless drift and say nothing about the live one.

`autonomyCapUnscoredHint` was dropped rather than written: `ceilingForRiskTier`
gives an unscored agent `DENY_CEILING` (-1), which no rung is at or below, so an
unscored agent is ALWAYS the notice case and a hint there would have had to
invent a cap to name.

## The sentinel is never a number in a sentence

`assertAutonomyRaiseWithinTier` rendered `caps it at -1` for an unscored agent.
It now branches on `DENY_CEILING` and uses the sentence its register sibling
(`assertRaiseWithinTier`) already gives that state: the fix is the assessment,
not a lower number. Section 8 of the seed-coherence suite pins it — including
that `-1` never reaches the message.

The per-tool contradiction check (`assertDeclarationsExercisable`) keeps judging
the value, and that is not the same shape: a card permitting a tool its own
ceilings refuse is composed in the payload being submitted, and the repair —
dropping the tool — is always available inside the same edit because narrowing
is never rationed.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/agent-policy-card.ts` | the two agent fields, `withheld`, `withActorNames`, the raise/value split |
| `src/app/t/[tenantSlug]/(app)/admin/agents/[agentId]/tabs/PolicyCardTab.tsx` | capped ladders, the above-cap notice, the standing withheld list, the version actor |
| `tests/rendered/agent-policy-card-tab.test.tsx` | ceiling clipping (incl. a card above the cap), the withheld pair, the actor pair |
| `tests/integration/policy-card-seed-coherence.test.ts` | section 6: a re-assessment lowers the cap under a live card, the narrowing is accepted, the raise is still refused. Section 7: the GET payload itself — both ceilings on both branches, `withheld` with its ceiling reason, the two resolved actors. Section 8: the unscored sentence |

## Decisions

- `withheld` is `null`, not `[]`, when the version in force cannot be read: an
  empty list would say "nothing is withheld" about a card nobody can read.
- The ladder ceiling takes `max(baseRung, …)`. Clipping to the ceiling on a card
  that sits above it would leave the radio group with no selected value — the
  operator could not see their own declaration, let alone narrow it.
- `ceilingForRiskTier` is imported by the client rather than re-derived. It
  carries only a type import from Prisma, and the tab already pulls
  `policy-card-evaluation` (which reaches the same module) into the bundle.
- The actor lookup is in the usecase, not `AgentPolicyCardRepository.listVersions`
  as the issue suggested: repositories here are one model each, and the batched
  name attachment is a usecase pattern in this codebase.
- `withheldNowIntro` does NOT say "the card in force does not permit them".
  `withholdingReasonForTool` never reads `permittedTools` — its three reasons
  are `NOT_IN_CATALOGUE`, `AUTONOMY_ABOVE_CARD`, `DATA_SCOPE_ABOVE_CARD` — so
  the copy carries its settled sibling `withheldIntro`'s framing ("the ceiling
  it ran into") plus the one thing that key cannot say: every call is refused
  meanwhile. Section 7 asserts the reason a narrowed card reports is the
  CEILING even though that card also drops the tool.
- The two drift notices are addressed in the rendered test by element ID
  (`agent-policy-card-above-tier-cap`, `-above-declared-scope`) and the hints
  by `FormField`'s own `aria-describedby` target. The keys are unmerged, and
  next-intl renders a missing key as its own dotted path — an assertion against
  that path would pass only while the key is missing. `ceilingsElsewhereHint`'s
  retirement is asserted the same way, by what stands in its place, so deleting
  that orphan key from the catalogues cannot take the suite red.
