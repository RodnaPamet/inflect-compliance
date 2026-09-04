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
| `MODEL_CHANGED` | `modelRef` differs, either direction |

Moving the other way does NOT mark stale: the stored tier is then merely too
high, and an over-restrictive cap is a safe error. Renaming the agent, changing
its owner, editing its description — `AssessmentBasis` has no such fields, so
they cannot reach the comparison at all.

`REVERSIBILITY_WORSENED` is a fifth trigger beyond the four the brief names,
for the same reason as the other three axis triggers: reversibility is a scorer
input carrying the strongest floor in the table, so leaving it out would make it
the one axis you could worsen without re-assessing.

`MODEL_CHANGED` needs something to compare, so this adds
`RegisteredAgent.modelRef` — nullable, not backfilled, because the platform
cannot observe which model an agent runs on and inventing a value would be a
declaration nobody made. NULL → NULL is not a change; NULL → a value is.

### The decision that was asked for: **stale WARNS, it does not block**

Three reasons, and the third is the one that makes it safe rather than merely
convenient.

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
3. **The widening is inert anyway.** The tier still in force is the tier scored
   against the NARROWER basis, and the ceiling composes as a `min` over
   independent narrowing terms. So an agent whose autonomy was raised from 3 to
   5 on a MODERATE assessment is still capped at `MAX_AUTONOMY_BY_TIER.MODERATE`
   = 3 until somebody re-scores. Stale does not stop the agent; it stops the
   WIDENING, which is precisely the part that was never assessed.

Point 3 is a property stage 2 must preserve: the tier term must compose as a
`min` alongside `agent.autonomyLevel`, never replace it. If a future change made
the tier cap the only term, a stale assessment would start granting authority
nobody assessed, and this decision would have to be revisited.

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
