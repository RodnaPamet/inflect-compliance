# 2026-11-11 — PROCESS_MAP proposal kind, read-only (#5053 deploy 1)

**Commit:** _(this PR)_ `feat(agentic): PROCESS_MAP proposal kind, read-only (#5053 deploy 1)`

## Design

#5053 lets an agent propose a process map: on approval the proposal becomes one
new DRAFT, DOCUMENT-mode `ProcessMap`, created through the process-map
usecases. The proposal is CREATE-only and names no target. Its value reaches
`AgentProposalKind` in two deploys, as `EXTERNAL_WRITE` did:

```
                 deploy 1 (this PR)                          deploy 2
DB enum          PROCESS_MAP appended                   →   unchanged
readers          every one handles it                   →   unchanged
create           refused by name, for every shape       →   a propose tool queues it
approve          refused while the brake is on          →   creates the map
review surfaces  no Approve on such a row               →   Approve offered
brake            PROCESS_MAP_PROPOSALS_IMPLEMENTED=false →   true, in a commit of its own
```

The reason is not caution in the abstract. A Prisma client that meets an enum
value it was not generated with fails the whole read
(`tests/integration/agent-driver-unknown-stored-mode.test.ts` measures it for
another enum), and the queue reads every pending proposal of the tenant in one
query. So a single PROCESS_MAP row read by an older container would take the
whole queue down. By the time deploy 2's writer stores the value, every
container still running has this build's readers, and a rollback to this build
reads the rows it finds.

**The brake** is `PROCESS_MAP_PROPOSALS_IMPLEMENTED` in the leaf
`src/lib/agentic/proposal-kind-rollout.ts`, typed `boolean` like
`AGENT_CAMPAIGNS_IMPLEMENTED`. Setting it back to false after deploy 2 is a
one-line, reviewed diff that stops approval while every reader keeps reading.

**Two refusals**, both with `details.reason` =
`PROCESS_MAP_PROPOSALS_NOT_AVAILABLE`:

- `createAgentProposal` refuses the kind at its very top, unconditionally and
  by name. Above the operation resolution, because an UPDATE-shaped
  PROCESS_MAP would otherwise be refused by `requireStorableUpdateTarget` with a
  different sentence. By name, so `tsc` narrows `input.kind` and
  `SCHEMA_BY_KIND` needs no entry. This usecase is the only `agentProposal.create`
  site, so this one refusal is what makes the release write nothing.
- `approveAgentProposal` refuses the kind while the brake is on, directly after
  the PENDING check: after the authority refusals (quarantine, expiry, dissent,
  composer) and before the edits check, the diff, both guard re-scans, the
  `AgentProposalApproval` signature insert and the claim. A row written by a
  newer container mid-rollout therefore stays PENDING with no signature. It is
  never burned ACCEPTED with nothing created, which is what the dispatch
  switch's unknown-kind throw would do once the claim (never handed back) had
  been taken.

Reject, bulk reject and the expiry job are kind-agnostic and unchanged, so such
a row can still be rejected or expire.

**The review surfaces withhold Approve.** `buildProposalDiffs` gives such a row
`withheldProposalDiff(kind)`: a new non-reviewable status,
`KIND_NOT_APPROVABLE`. `isDiffReviewable` answers false, so the queue and the
canvas checkpoint review panel both withhold Approve, and Reject stays.
`ProposalDiffPanel` renders the status with its own heading, badge and
sentence: this version cannot approve this kind yet, nothing is wrong with the
proposal, reject it or leave it pending until the update is complete.

### Readers

| Reader | What it reads | What it does with PROCESS_MAP |
| --- | --- | --- |
| Queue (`listAgentProposals`, `/agents/proposals`) | whole rows | passes through; kind labelled through `proposalKindLabelKey`; diff withheld, no Approve |
| Queue diff (`buildProposalDiffs`) | kind, operation, payload, target | withheld diff (`KIND_NOT_APPROVABLE`) while the brake is on |
| Approve (`approveAgentProposal`) | whole row | refused, `PROCESS_MAP_PROPOSALS_NOT_AVAILABLE`, before signature and claim |
| Reject / bulk reject | whole row | kind-agnostic: rejected |
| Quarantine (`listQuarantinedAgentProposals`, `QuarantineClient`) | whole rows | labelled through `proposalKindLabelKey` (private `KINDS` set removed); null target reads "new" |
| Run detail and steps (`workflow-runs.ts`, `workflow-run-steps.ts`, `AgentRunDetailClient`) | id, kind, operation, status | passes through; already labelled through `proposalKindLabelKey` |
| Canvas checkpoint review (`run-checkpoint-review.ts`, `CheckpointReviewPanel`) | rows + diff | kind and operation labelled (they were raw codes); Approve withheld via the diff |
| Expiry job (`agent-proposal-expiry.ts`) | id, kind, agent, window | kind-agnostic: expires it, kind copied into the audit row |
| A2A task status (`a2a-inbound.ts`) | id, kind, status | passes the code through to the peer, as for every kind |
| Recertification evidence (`agent-recertification-evidence.ts`, groupBy kind) | counts by kind | no propose tool maps to it, so it lands in the unattributed bucket like any kind no grant explains |
| Authority conformance (`agent-authority-conformance.ts`) | agent, kind, time | matched only against propose tools' kinds; none names it |
| Sample audit, review quality, governance reports, breaker counts, retirement cascade, workpapers | ids, statuses, counts | do not read `kind` |

### Localisation

The refusal reason is worded on both review surfaces through the new client-safe
`src/lib/agentic/proposal-refusal-keys.ts`, which took the queue's private
`REFUSAL_KEY` (#4970) so the canvas panel stops showing the server's sentence for
the reasons the queue already words. New messages:
`agents.proposals.kind.PROCESS_MAP` and
`agents.proposals.refused.processMapNotAvailable`, in en and bg.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261111230000_agent_proposal_process_map_kind/migration.sql` | the one `ADD VALUE IF NOT EXISTS` |
| `prisma/schema/enums.prisma` | `PROCESS_MAP` appended last, with its docblock |
| `prisma/schema/agentic.prisma` | prose: a process map, CREATE-only, null target |
| `src/lib/agentic/proposal-kind-rollout.ts` | the brake and `withheldProposalDiff` |
| `src/app-layer/usecases/agent-proposals.ts` | the union widened; both refusals |
| `src/app-layer/usecases/agent-proposal-diff.ts` | the withheld diff |
| `src/lib/agentic/proposal-labels.ts` | `PROCESS_MAP` in `PROPOSAL_KINDS` |
| `src/lib/agentic/proposal-refusal-keys.ts` | the shared refusal wording map |
| `src/app/t/[tenantSlug]/(app)/agents/proposals/AgentProposalsClient.tsx` | reads the shared map |
| `src/app/t/[tenantSlug]/(app)/agents/quarantine/QuarantineClient.tsx` | kind labels through the shared list, both sites |
| `src/components/processes/CheckpointReviewPanel.tsx` | kind and operation labelled; refusals worded |
| `src/lib/agentic/proposal-diff-status.ts`, `src/lib/agentic/proposal-diff.ts` | the `KIND_NOT_APPROVABLE` status, non-reviewable |
| `src/components/agentic/ProposalDiffPanel.tsx` | renders `KIND_NOT_APPROVABLE` with its own heading, badge, notice and blocked line |
| `messages/en.json`, `messages/bg.json` | the kind label, the refusal sentence, the withheld-kind panel copy |
| `tests/integration/agent-proposal-process-map-kind.test.ts` | storable; create refused for both shapes; approve refused before signature and claim; read, not reviewable, rejectable |
| `tests/unit/agent-proposal-kind-rollout.test.ts` | every kind classified READ_ONLY/WRITTEN over the generated enum; a READ_ONLY kind has its brake on (IMPLEMENTED=false) and no writing tool |

## Decisions

- **A diff status of its own, not `PAYLOAD_UNREADABLE`.** Reusing that status
  would have withheld Approve with no panel change, but its copy says the
  content could not be read and tells the reviewer to reject the proposal and
  check the agent. Neither is true of a well-formed row a newer container wrote
  mid-rollout, which becomes approvable once the rollout ends. So
  `KIND_NOT_APPROVABLE` is non-reviewable like the two refusals, and the panel
  gives it an explicit branch (heading, warning badge, notice, blocked line)
  ahead of the others, so it never falls through to the before/after list.
  `computeProposalDiff` never produces it; only `withheldProposalDiff` does.
- **Brake ON means refused** (`PROCESS_MAP_PROPOSALS_IMPLEMENTED === false`),
  the convention of `AGENT_CAMPAIGNS_IMPLEMENTED` in
  `src/lib/access-review/scope.ts`.
- **The create refusal is unconditional, not a brake check.** A check of the
  form `kind === 'PROCESS_MAP' && !BRAKE` would not narrow the type, and
  deploy 1 has no payload schema to validate against anyway. Deploy 2 replaces
  it with the real path.
- **The approve refusal sits after the authority refusals.** Quarantine,
  expiry, dissent and composer are 403s that write an `AUTHZ_DENIED` row and
  must not be reachable by any ordering; the brake is a 400 about what this
  build can do, so it sits with the PENDING check.
- **`ROLLOUT` in the unit test is a `Record` over the generated enum.** A kind
  the schema gains fails `tsc` until somebody classifies it, which is the
  two-deploy rule enforced rather than remembered. It is the proposal-kind twin
  of `agent-driver-mode-rollout.test.ts`.
- **The queue's empty-state copy is unchanged.** It still
  describes what an agent can propose today; it changes when a tool can propose
  a map.
