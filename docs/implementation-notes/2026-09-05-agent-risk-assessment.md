# 2026-09-05 — Agent risk assessment (Agentic 3/10, stage 1)

**Commit:** `<pending>` feat(agentic): the agent risk assessment — models, seed, scorer, staleness (3/10)

Stage 1 of two. This lands the instrument: the models, the global reference
content, the scorer, and staleness detection. Stage 2 wires the tier into the
gates it already has seams for (`ceilingForRiskTier`, the 5/10 policy card, the
8/10 review tier) and adds the HTTP surface.

## Why

Singapore IMDA's *Model AI Governance Framework for Agentic AI* makes "assess
and bound the risks upfront" dimension 1, scored on AUTONOMY × DATA ACCESS ×
ACTION REVERSIBILITY. NIST AI RMF, ISO/IEC 42001 and the EU AI Act contain no
reference to "agent" at all, so a customer running agents has three frameworks
and no instrument. The register that 1/10 shipped records the three axes; this
turns them into a judgement, and the judgement into a cap.

## Design

### The RLS split, copied exactly

The four tables mirror the AI-governance self-assessment
(`ai-governance.prisma`) rather than inventing a shape, because the split is the
part that is expensive to get backwards:

| Table | Scope |
| --- | --- |
| `AgentAssessmentDomain` | GLOBAL reference — no `tenantId`, no RLS |
| `AgentAssessmentQuestion` | GLOBAL reference — no `tenantId`, no RLS |
| `AgentRiskAssessment` | tenant-scoped, canonical policy triple + FORCE |
| `AgentRiskAssessmentAnswer` | tenant-scoped, `note` encrypted + sanitised |

Backwards in one direction publishes one customer's account of which guardrails
its agents are missing. Backwards in the other means every tenant needs its own
copy of an identical question set, and an assessor citing `ara-1-03` resolves to
a different row per customer.

`tests/integration/agent-assessment-isolation.test.ts` proves BOTH directions.
A tenant-only isolation suite would stay green if the global tables had
accidentally been put behind RLS — every tenant would see zero questions, the
instrument would be blank for everybody, and no cross-tenant assertion would
object.

### The scorer: a band raised by per-axis floors

`src/lib/agentic/agent-risk-scoring.ts`. Pure, dependency-free, and

    tier = max( band(additive score) , the highest floor any SINGLE axis imposes )

The additive part (autonomy ×1, data-access ordinal ×2, reversibility ×3,
third-party +2, answers up to 12, max 34) is where the questionnaire does its
work — answering the twenty questions honestly moves an agent by up to twelve
points, more than a full band. The floors are where governance does its.

A purely additive score lets a good answer on one axis buy down a bad one: an
agent that sends irreversible external notifications talks its way to LOW by
being narrow everywhere else, and the arithmetic does not object. A purely
tabular matrix is 7 × 5 × 3 × 2 = 210 cells nobody reviews, and the
questionnaire then changes nothing — the paperwork failure this exists to avoid.

The floors, each with its reason:

- **TERMINAL reversibility → MODERATE.** An action the platform cannot undo is a
  risk no control removes; controls change how often it happens, never whether
  it can be taken back. This is the property pinned by name in the tests, over
  every cell of the matrix rather than at one point.
- **EXTERNAL_EGRESS → HIGH.** The only data-access rung whose blast radius is
  not bounded by the tenant's own database — the enum's own docstring says so.
- **WRITE_TENANT_DATA → MODERATE.** The weaker version of the same argument.
- **Autonomy ≥ 5 → MODERATE.** The questions ask whether controls exist; the
  meaning of unattended operation is that no human watches those controls work.

**Unanswered counts as NO.** An unclaimed mitigation is an absent one, and
counting a blank as YES would mean a brand-new empty assessment scores its agent
LOW — the least-assessed agent getting the friendliest treatment, which is the
exact inversion `riskTier IS NULL` already exists to prevent one level up. So
the tier only comes DOWN as the form is filled in. `NA` leaves the denominator
(a first-party agent has no supplier to assess); N/A-ing everything removes at
most the twelve answer points and cannot get an agent below the floors.

**`MAX_AUTONOMY_BY_TIER` lives with the scorer**, not with the ceiling. It is
the assessment's MEANING — what coming out HIGH actually costs you —
and a tier whose consequence is defined in another module is a tier whose
consequence can be changed without anyone re-reading why it was set.
`autonomy-ceiling.ts` owns the composition (`min` over independent narrowing
terms); this owns the number each tier contributes.

### Staleness: a comparison, not a flag

`AgentRiskAssessment` freezes the six things the score was true of (`basis*`),
and `evaluateAssessmentStaleness` compares them against the live agent. An
`isStale` boolean that every write path remembers to set fails silently the
first time somebody adds a seventh write path, and the failure looks exactly
like "nothing changed".

Triggers are ONE-DIRECTIONAL — they fire when a scorer input moves in the
direction that raises risk:

| Trigger | Fires on |
| --- | --- |
| `AUTONOMY_RAISED` | autonomy up |
| `TOOL_GRANTED` | granted-tool count up |
| `DATA_SCOPE_WIDENED` | data-access ordinal up |
| `REVERSIBILITY_WORSENED` | reversibility ordinal up |
| `PROVENANCE_WIDENED` | provenance FIRST_PARTY → THIRD_PARTY |
| `MODEL_CHANGED` | `modelRef` differs, either direction |

Moving the other way does NOT mark stale: the stored tier is then merely too
high, and an over-restrictive cap is a safe error. Renaming the agent, changing
its owner, editing its description — `AssessmentBasis` has no such fields, so
they cannot reach the comparison at all.

`REVERSIBILITY_WORSENED` and `PROVENANCE_WIDENED` are the fourth and fifth AXIS
triggers, beyond the ones the brief names, and the rule behind both is that the
basis carries EXACTLY the scorer's agent-side inputs. Reversibility carries the
strongest floor in the table; provenance is worth two points, enough to move a
run across a band boundary on its own. An axis the scorer weighs but the basis
omits is an axis you can worsen with nobody noticing.

> **Correction (same day).** `PROVENANCE_WIDENED` was NOT in the first version
> of this list, and `basisProvenance` was stored on the row but read by nothing.
> That was the gap this rule exists to prevent, present in the diff that stated
> the rule. See
> [`2026-09-05-agent-widening-rescore.md`](2026-09-05-agent-widening-rescore.md).

`MODEL_CHANGED` needs something to compare, so this adds
`RegisteredAgent.modelRef` — nullable, not backfilled, because the platform
cannot observe which model an agent runs on and inventing a value would be a
declaration nobody made. NULL → NULL is not a change; NULL → a value is.

> **Correction (same day).** As first shipped, NULL → a value was NOT reachable.
> `modelRef` was absent from `CreateRegisteredAgentSchema`,
> `UpdateRegisteredAgentSchema` and `RegisteredAgentWriteFields`; both schemas
> are strict objects, so a caller supplying the field had it silently STRIPPED
> and the column stayed NULL for the life of every agent. `MODEL_CHANGED` could
> therefore never fire in production, and its only coverage hand-built two
> values no product surface could produce — this repo's own "guard validates
> diagnosis, not remedy" trap. The write path now exists on all three create /
> update seams and is proved end-to-end through the usecases in
> `tests/integration/agent-widening-reassessment.test.ts`.

### The decision that was asked for: **stale WARNS, it does not block**

> **Correction (same day).** Reason 3 below, as first written, was FALSE — and
> it was the reason that made the decision safe rather than merely convenient.
> It is struck through and replaced. The decision itself did not change; what
> changed is that it is now true. See
> [`2026-09-05-agent-widening-rescore.md`](2026-09-05-agent-widening-rescore.md).

1. **"Never scored" and "stale" are different epistemic states.** Never-scored
   means nobody has ever looked, and `ceilingForRiskTier(null)` already resolves
   that to `DENY_CEILING` — the agent can call nothing. Stale means somebody
   looked and something moved since. Collapsing the two throws away the only
   assessment anybody did, and treats the customer who assessed their agent
   identically to the one who never did.
2. **Blocking makes the register's own maintenance the outage.** Granting a tool
   is the correct, audited act that fires `TOOL_GRANTED`. An operator whose
   agent goes dark the instant they do the right thing stops doing the right
   thing — they stop granting through the register, or stop registering.
3. ~~**The widening is inert anyway.** The tier still in force is the tier
   scored against the NARROWER basis, and the ceiling composes as a `min` over
   independent narrowing terms.~~ **False for four of the five triggers.** The
   `min` argument holds only for `AUTONOMY_RAISED`, because
   `agent.autonomyLevel` is itself a term in that `min`. `DATA_SCOPE_WIDENED`,
   `REVERSIBILITY_WORSENED` and `PROVENANCE_WIDENED` move axes that appear in
   the ceiling NOWHERE, and `updateRegisteredAgent` accepted every one of them
   without a murmur: an agent could be walked READ_TENANT_DATA →
   EXTERNAL_EGRESS and REVERSIBLE → TERMINAL, keep whatever tier it had and the
   whole ladder that tier bought, and run at an authority a fresh score of the
   same agent refused — a HIGH agent walked that way scores CRITICAL, cap 1,
   READ only. (Not LOW → CRITICAL in one step, which the arithmetic forbids:
   LOW caps the pre-walk score at 8, the walk adds at most 14, and CRITICAL
   starts at 25. Every LOW agent walked that way lands at HIGH — swept in
   `tests/unit/agent-risk-scoring.test.ts`.) `TOOL_GRANTED` was worse still —
   the grant took effect immediately, in the transaction that recorded the
   assessment as overtaken.
3. **(replacement) The tier does not lag the agent, because a widening
   RE-SCORES.** The scorer is pure in (autonomy, data access, reversibility,
   provenance, answers). Four of those five are declared fields an operator has
   just changed and the fifth is on file, so the tier for the agent as it now
   stands is computable with no human in the loop — and it is computed, in the
   same transaction that records the widening, and written back whenever it is
   worse. The ceiling narrows at once. "Stale" then means only *the twenty
   answers may be out of date*, which genuinely is a warning rather than a
   euphemism for *the tier is wrong*.

Staleness is stamped ONCE (`staleAt` is not moved by a later re-evaluation that
finds the same thing) because the operator-facing question is "how long has this
been stale", not "when did we last look". The audit row is written only on the
TRANSITION into staleness — a trail where the same fact repeats a thousand times
is a trail nobody reads.

### The seed

`prisma/fixtures/agent-risk-assessment.json` — four IMDA dimensions, twenty
questions, every one of OWASP ASI01–ASI10 covered at least once. Loaded by
`prisma/seed.ts` AND by `scripts/seed-self-assessments.ts` (the
production-safe standalone seeder), both by upsert on the stable id, both
idempotent. Ids are `ara-<domain>-<nn>` and are STABLE EXTERNAL KEYS: an
assessor citing a question in a report must resolve to the same row forever,
which is why the seed is an upsert and never a truncate-and-reload, and why the
answer→question FK is `RESTRICT` rather than `CASCADE` — a question retired from
the fixture must not silently delete the answers that cite it.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/agentic.prisma` | The four models + `RegisteredAgent.modelRef` + the assessments back-relation |
| `prisma/schema/auth.prisma` | Two `Tenant` back-relations |
| `prisma/migrations/20260905120000_agent_risk_assessment/migration.sql` | Tables, indexes, composite FKs, the RLS triple on the two tenant tables only |
| `prisma/fixtures/agent-risk-assessment.json` | The global reference content |
| `prisma/seed.ts`, `scripts/seed-self-assessments.ts` | Idempotent upsert loaders |
| `src/lib/agentic/agent-risk-scoring.ts` | The pure scorer + `MAX_AUTONOMY_BY_TIER` |
| `src/lib/agentic/agent-assessment-staleness.ts` | The pure staleness comparison |
| `src/app-layer/schemas/agent-assessment.schemas.ts` | Zod; no tier field, deliberately |
| `src/app-layer/repositories/AgentRiskAssessmentRepository.ts` | Tenant-filtered queries + the two global reference reads |
| `src/app-layer/usecases/agent-risk-assessment.ts` | State, answer (sanitised), score-and-write-back, staleness refresh |
| `src/app-layer/repositories/RegisteredAgentRepository.ts` | `getScoringState` + `setRiskTier` |
| `src/lib/security/encrypted-fields.ts` | `AgentRiskAssessmentAnswer: ['note']` |
| `docs/data-retention.md` | Four classification rows |

## Decisions

- **`status` is a `String`, not a Postgres enum**, and there is no `SUPERSEDED`
  value. The String avoids the `ALTER TYPE` mid-rolling-deploy hazard the
  `@@map("WorkItem*")` pins record. `SUPERSEDED` was drafted and removed: a
  completed run is never reopened, a re-score opens a NEW run, and a fourth
  value nothing ever writes reads to anybody browsing the table as a state the
  system can be in.
- **`staleTriggers`, not `staleReasons`.** `reason` is in the
  encryption-manifest sensitivity heuristic, and a column of enum codes tripping
  a free-text detector teaches people to add exemptions.
- **The basis columns are nullable.** A DRAFT run has not been scored, and a
  basis invented at insert time would be a snapshot of a state nobody assessed.
  `stalenessFor` returns `null` — not "fresh" — when the basis is absent.
- **Assessment → agent FK is CASCADE** (unlike `AgentProposal`'s RESTRICT). A
  proposal is history and must outlive the agent that made it; an assessment is
  a judgement ABOUT an agent, and a judgement about a row that no longer exists
  caps nothing.
- **`getScoringState` is a separate selection from `listSelect`.** One is the
  operator's view of an agent, the other is the scorer's. Widening `listSelect`
  to serve both would mean a future trim of a column nobody could see on a page
  silently changes what the scorer reads.
- **A floor is compared against the BAND, not the running tier.** Under the
  current weights at most one floor is ever above the band (an axis extreme
  enough to floor also carries enough points to reach that band on its own —
  except `EXTERNAL_EGRESS`, which sits exactly on the LOW boundary at 8 points
  while flooring at HIGH). The band comparison is kept anyway because it is the
  version that stays correct when somebody re-weights an axis, and a re-weighting
  is exactly when a second floor becomes reachable. The test asserts the current
  maximum is 1, so the day that changes is a diff somebody reads.
- **`triggerDetail`, not `detail`, in the audit payload.** The canonical audit
  details schema reserves `detail` for a single free-form string; handing it an
  array is a 400 at the write.

## Seams left for later prompts, each marked in source

- **The autonomy cap (stage 2 of this PR).**
  `ceilingForRiskTier` in `src/lib/agentic/autonomy-ceiling.ts` still returns
  `UNCLAMPED` for every scored tier and the live call site still passes
  `RISK_TIER_CEILING_UNWIRED`. `MAX_AUTONOMY_BY_TIER` is the table it consumes.
  *(Stage 2 landed in the same PR and closed this: the constant is gone and the
  cap is wired. See
  [`2026-09-05-agent-risk-tier-load-bearing.md`](2026-09-05-agent-risk-tier-load-bearing.md).)*
- **Evidence emission (10/10).** `completeAgentRiskAssessment` carries a named
  comment where the emission call goes, and states why it is not invented here:
  10/10 owns the emission point for agentic artefacts, and inventing one now
  would make 10/10 either adopt a shape it did not choose or migrate rows that
  already exist. The hash-chained `AGENT_RISK_SCORED` audit row — carrying the
  tier, the score and the basis — is the durable record meanwhile.
- **The policy card's default caps (5/10)** and **the review tier (8/10)** both
  read `RegisteredAgent.riskTier`, which this now populates.
