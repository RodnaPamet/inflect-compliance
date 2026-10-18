# 2026-10-18 — Agent recertification campaigns (3a deploy 2)

**Commit:** _(this PR)_ `feat(agentic): agent recertification campaigns (3a deploy 2)`

## Design

Deploy 1 added `AGENT` to `AccessReviewScope` and taught every reader. This
deploy is the campaign: an access review whose subjects are registered agents.

```
create      POST /access-reviews/agents        createAgentAccessReview
              freeze DRAFT/ACTIVE/SUSPENDED agents → AccessReviewConnectedDecision
              (subjectRef agent:<id>, subjectAgentId, subjectOwnerUserId, snapshot)
              refuse an empty population (NO_SUBJECTS), then name two preparing
              agents (preparerAgentId, crossPreparerAgentId), each ACTIVE, scored,
              not killed, breaker not open, granted the read tool (PREPARER_*)

prepare     POST /access-reviews/:id/agent-packs prepareAgentReviewPacks
              started by a person; the eligibility asked again; then the AGENTS' runs:
                preparer:       startWorkflowRun({...ctx, agentId: preparer}, …,
                                  { page: n, subject: '*' })    every subject but its own
                cross-preparer: startWorkflowRun({...ctx, agentId: cross}, …,
                                  { page: 0, subject: preparer }) the preparer's own pack
              each run:
                READ       get_agent_recertification_evidence  (stored rows only; the
                           funnel applies the AGENT's grants, card, autonomy, kill)
                SYNTHESIS  planAgentReviewPacks                (pure: hash + narrowings)
              re-derive each plan from the run's recorded READ output, refuse a
              recorded plan that disagrees, then ONE transaction:
                AccessReviewAgentPack × subjects, AccessReviewAgentNarrowing × proposals

decide      POST …/agent-narrowings/:id            decideAgentNarrowing
              ACCEPT → RegisteredAgentToolRepository.revokeGrant (delete by id)
            POST …/connected-decisions/:id         route dispatches AGENT → submitAgentDecision
              waits for the pack and every narrowing; refuses the owner

close       POST …/close                           route dispatches AGENT → closeAgentAccessReview
              phase 1 (tx): subjectCount > 0 && decided === subjectCount, packs = subjects,
                no pending narrowing; claim; remediation tasks; executed stamps;
                selectSample → AccessReviewDecisionSampleAudit
              phase 2: evidence JSON from the committed rows → storage → FileRecord
                (sha256 === content hash) → Evidence + control links (A.5.18, CC6.1, ASI03)

second      POST …/agent-samples/:id               recordAgentDecisionSampleOutcome
human         a pack reader who neither decided the subject nor owns the agent
```

The decisions stay in `AccessReviewConnectedDecision`, as `LEGACY_APP`'s do, so
the register, progress, reminders and escalation need nothing new. What an agent
subject needs beyond a connected one is two columns on that row and three child
tables:

| Table | What it holds | Write rule |
|---|---|---|
| `AccessReviewConnectedDecision` + `subjectAgentId`, `subjectOwnerUserId` | the frozen agent and its owner at creation | a trigger freezes the subject and makes the verdict and executed stamps one-way — for every scope |
| `AccessReview` + `preparerAgentId`, `crossPreparerAgentId` | the two preparing agents | CHECK: both set and different for AGENT, both NULL otherwise |
| `AccessReviewAgentPack` | sections, `sha256:` content hash, run id, preparing agent, window | written once; any UPDATE refused; CHECK `preparedByAgentId <> agentId` |
| `AccessReviewAgentNarrowing` | one proposed grant delete and its outcome | proposal frozen; outcome and execution stamped once |
| `AccessReviewDecisionSampleAudit` | a drawn decision and the second person's answer | draw frozen; answer stamped once |

## Files

| File | Role |
|---|---|
| `prisma/migrations/20261018130100_agent_recertification_campaigns/` | columns, three tables, CHECKs, four triggers, grants (no DELETE), RLS |
| `prisma/schema/audit-workflow.prisma`, `auth.prisma`, `enums.prisma` | the models, the two columns, `AgentNarrowingOutcome` |
| `src/lib/agentic/agent-recertification.ts` | pure: window, evidence schema, narrowing rule, pack plan and hash, closing evidence and hash |
| `src/app-layer/usecases/agent-recertification-evidence.ts` | the read behind the tool; writes nothing |
| `src/lib/mcp/tools/access-review-tools.ts` | `get_agent_recertification_evidence`, registered with the read tools |
| `src/lib/agentic/workflows/agent-recertification-pack.ts` | the static READ + SYNTHESIS workflow |
| `src/app-layer/usecases/access-review-agent.ts` | create, prepare, decide, narrow, close, evidence recompute, sample answer |
| `src/app-layer/usecases/access-review-scope-gate.ts` | the brake's refusal, and the generic paths' `AGENT_CAMPAIGN_OWN_FLOW` |
| `src/app-layer/repositories/AccessReviewRepository.ts` | `createAgentCampaign`, the one writer of the scope |
| `src/app-layer/repositories/RegisteredAgentToolRepository.ts` | `revokeGrant`, delete one grant by id |
| `src/app/api/t/[tenantSlug]/access-reviews/agents/`, `[reviewId]/agent-packs/`, `agent-narrowings/[narrowingId]/`, `agent-samples/[sampleId]/` | the routes |
| `…/[reviewId]/close/route.ts`, `connected-decisions/[decisionId]/route.ts`, `evidence/route.ts` | AGENT dispatch; the evidence file narrowed like the subjects |
| `src/lib/security/route-permissions.ts` | the four leaves, before the detail rule |
| `AccessReviewsClient.tsx`, `AccessReviewDetailClient.tsx`, `messages/*.json` | the AGENT option; pack, narrowing, sample and evidence-hash sections |
| `tests/guards/agent-recertification-single-write-seam.test.ts` | one write seam; the campaign's exact write set; the workflow reads only |

## Decisions

- **Narrowings are their own model, not `AgentProposal`** — accepted by the
  owner on 2026-10-18 (roadmap decision 20). The roadmap's retention
  note planned `AgentProposal`. A narrowing kind would be a new
  `AgentProposalKind` value — a second two-deploy enum inside this step — and
  the proposal queue's expiry sweep, approver count and four-eyes trigger are
  rules for an agent's output, not for a reviewer's verdict on an agent. The
  narrowing row carries what the queue would have: a frozen proposal, a one-way
  decision, an executed stamp, and the audit row the standalone revoke writes.
- **The decision sample is its own model too**, accepted in the same decision.
  `AgentProposalSampleAudit` is keyed on a proposal. The draw reuses the ASI09
  sampler (`selectSample`, `sampleSizeFor`) and its seed derivation, with the
  campaign in the epoch.
- **No foreign key from a retained table to `RegisteredAgent`.** The three
  tables are Regulatory artefacts, retained by the tenant purge, and
  `RegisteredAgent` is not; an FK would either block the purge or cascade the
  evidence away. The agent and grant are plain ids, as the journals keep them.
- **The workflow's recorded output is re-derived, not trusted.** The SYNTHESIS
  step already plans the packs; the usecase re-plans from the READ step's
  recorded output and refuses a mismatch, so the rows written are what the
  stored evidence implies, whatever happened to the recorded synthesis.
- **One run per 20 agents.** A single run over 500 agents would exceed
  `MAX_CONTEXT_BYTES`; paging keeps every run bounded and the packs are written
  only after every page succeeded.
- **The window is the 90 days before CREATION**, so every page, prepared at any
  time, reads the same window, and a grant younger than the window is never
  proposed for deletion.
- **Observed use is one `take: 1` read per grant** on the behaviour window's
  index prefix. A single capped read across agents could turn "not read" into
  "not called" — the one wrong answer that deletes a grant somebody needs.
- **The one-way trigger covers every scope's connected decisions.** Every
  existing writer already wrote only where the stamp was empty; a database rule
  for agents alone would leave the same claim editable for directory and legacy
  campaigns.
- **SOC 2 CC6.1 stands in for the brief's CC6.3**, which neither SOC 2
  representation carries, as the legacy campaign's evidence substitutes CC6.1
  for CC6.2 (accepted by the owner on 2026-10-18, decision 20, as was creation at
  `POST /access-reviews/agents` under `access_reviews.create`).
  `tests/unit/agent-recertification.test.ts` asserts the absence.
- **A registered agent prepares every pack** (owner decision of 2026-10-18,
  roadmap rule 1 and decision 19). The run is started through the seam the automation
  dispatcher uses to run a registered agent (`agent-invoke-dispatch`): the
  requester's context with `agentId` bound, into `startWorkflowRun`. That makes
  the run row carry the agent, pins its policy card, and makes the READ step's
  tool call the agent's — the static driver builds the invocation from the
  register, so the agent's grants are deny-by-default, its card and autonomy
  ceiling apply, and the kill and credential checks run on the call. The
  requester's permissions are one term of that intersection: an OWNER who
  starts the run for an agent not granted the read tool gets a `tool_not_granted`
  refusal, not the read the OWNER could have made directly. The eligibility
  terms are the dispatcher's own (ACTIVE, scored, not killed, breaker not open)
  plus the grant, each refused by name, asked at creation and again at
  preparation. Preparation itself is started by a signed-in person — a key's
  agent binding would otherwise decide whose run it is.
- **Two preparers, because rule 8 leaves no other sound option.** Every agent
  able to prepare is ACTIVE, and every ACTIVE agent is in the frozen
  population, so the preparer is always one of the subjects. The options were:
  - *refuse a campaign whose preparer is in the population* — refuses every
    campaign;
  - *leave the preparer out of the population* — the one agent trusted to
    prepare packs is the one never recertified, and the campaign's evidence
    would claim a population it did not cover (invariant 5's sibling);
  - *prepare its pack on the static, person-started path* — keeps rule 8 and
    breaks the owner's decision that a registered agent prepares each pack;
  - *a second registered agent prepares the preparer's pack* — keeps both.

  So the campaign names a `crossPreparerAgentId` that prepares exactly the
  preparer's pack, and the preparer prepares every other pack, the
  cross-preparer's included. Neither prepares its own. The cost is that a
  tenant needs two eligible agents to run a campaign; a tenant with one cannot
  start one, and is told so by name. Rule 8 is held at three layers: the
  evidence read never returns the calling agent's own subject (and refuses it
  when asked), the usecase refuses a run whose evidence contains it, and a CHECK
  refuses a pack row whose preparer is its subject.
- **The brake stays.** `AGENT_CAMPAIGNS_IMPLEMENTED` is true and every act of the
  agent flow asserts it, so a hurried rollback of behaviour is one reviewed line
  that leaves every reader working.
