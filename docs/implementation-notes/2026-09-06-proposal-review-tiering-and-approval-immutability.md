# 2026-09-06 — Tiered review + approval immutability on the agent proposal queue

**Commit:** `a0dbc2d14 feat(agentic): tier proposal review and make approvals immutable (ASI09)`

OWASP **ASI09 — Human-Agent Trust Exploitation** (automation bias). The
propose-not-commit queue is the product's whole safety story for agentic writes:
an agent never mutates a record, it proposes, and a human approves. That control
was correct in DESIGN and unmeasured in PRACTICE — one reviewer, any reviewer,
any volume, and no durable record of who. A queue rubber-stamped under load is
worse than no queue: it manufactures an auditable record of consent nobody gave.

## Design

Two halves, and only the second is new machinery.

### 1. How many humans sign — a composition, not a new setting

`src/lib/agentic/approval-tiering.ts` is pure and imports nothing but a type. It
takes three inputs that ALREADY EXISTED and were already labelled as this
prompt's seams:

| input | where it comes from | what the source already said |
| --- | --- | --- |
| `AgentPolicyCardVersion.approvalRung` | the version PINNED to the proposal | *"declared and pinned so that when 8/10 builds the review queue, the queue reads the version that was in force when the proposal was made"* |
| `RegisteredAgent.riskTier` | `reviewRequirementForRiskTier` | *"── SEAM (Agentic 8/10) — APPROVER TIERING … Wired by: 8/10, at the proposal-approval usecase. Nothing calls it today."* |
| `RegisteredAgent.autonomyLevel` | against `UNATTENDED_AUTONOMY` (5) | *"the rung at which an agent is operating without a human in the loop"* |

**Which is authoritative when they disagree: none of them.** Every term is a
NARROWING term over one quantity, and the answer is the strictest — the shape
`resolveAutonomyCeiling` already uses. Picking a winner fails in both
directions, and both failures are reachable:

- *card wins* — the card is operator-editable, so a tenant could score an agent
  CRITICAL and then set the card to `AUTO_APPROVAL`, deleting the assessment's
  only consequence while the assessment page went on saying CRITICAL.
- *tier wins* — an operator who deliberately narrows a LOW agent's card to
  `SECOND_APPROVER` (the one direction the card ladder lets them move freely)
  would find the narrowing had no effect.

The composed number is PINNED onto `AgentProposal.requiredApprovals` at the
propose seam and never recomputed. Same reason the card version is pinned, plus
one more: the database trigger reads that integer rather than re-deriving the
ladder in plpgsql, so the rule has one implementation rather than two in
different languages.

### 2. Four eyes is a pair of database constraints

Counting approvals and then writing one is a read-then-write: two concurrent
requests each read "one signature so far" and each write the second. There is no
arrangement of that check in a usecase that closes the window. So
`AgentProposalApproval` carries both halves as constraints:

```
@@unique([tenantId, proposalId, approverUserId])   -- the second approver is not the first
agent_proposal_approval_four_eyes  (BEFORE INSERT OR UPDATE)
                                                   -- the approvers exclude the agent's owner
```

**The owner rule is a SET property, not an ordinal one.** "The SECOND approver
must not be the owner" sounds equivalent to "the owner is not among the
approvers" and is not: with signatures `{owner, other}`, which one is "the
second" is decided by insertion order, and insertion order is chosen by whoever
clicks first. An ordering-dependent four-eyes rule is bypassed by controlling
the ordering. The set form cannot be, and it strictly implies the ordinal one.

It applies only where two signatures are required. On a single-approver proposal
the owner may sign — a control shaped like an outage (a one-admin tenant that
can approve nothing) is a control people remove.

### 3. An approval that can be edited is not evidence

`agent_proposal_approval_immutable` mirrors `ai_decision_log_immutable` column
for column: every column frozen, and `outcome` may leave `PENDING` exactly once.
Enforced twice, the split `AgentPolicyCardVersion` and `AuditLog` already make —
`app_user` holds neither UPDATE nor DELETE, and the trigger refuses an UPDATE
from any role including the owner. Neither alone is the claim, so the test
asserts both.

`PENDING` is not decoration. Only a terminal APPROVING outcome counts toward the
requirement, so a row written by anything that forgot to state an outcome grants
nothing — and the four-eyes trigger fires on UPDATE as well as INSERT so the
reserved state cannot be used as a two-statement way around the owner rule.

One level up, `AgentProposal.requiredApprovals` is write-once by its own trigger
(NULL → value only). A requirement that can be lowered after the fact retires
both halves of the rule while the queue goes on looking tiered.

### 4. Edits are refused on a two-approver proposal

The subtle bypass: approver one signs the content they read, approver two
approves WITH EDITS, and the record that commits is one no two people agreed on.
Merging the first approver's edits instead has the same defect pointing the
other way. Re-arming the queue on every edit so both signatures reattach is a
real design and a larger one; refusing is the honest version until it exists.

## Files

| file | role |
| --- | --- |
| `src/lib/agentic/approval-tiering.ts` | NEW. Pure composition of the three terms; every absence's fail direction. |
| `src/app-layer/usecases/agent-proposals.ts` | Resolves + pins the requirement at propose; records a signature and gates the claim on the distinct count at approve; audits both refusal shapes. |
| `prisma/schema/agentic.prisma` | `AgentProposal.requiredApprovals` + `@@unique([id, tenantId])`; new `AgentProposalApproval`. |
| `prisma/schema/auth.prisma` | Tenant back-relation. |
| `prisma/migrations/20260906120000_agent_proposal_approval/migration.sql` | Table, both four-eyes constraints, both immutability triggers, privileges, RLS triple + FORCE. |
| `docs/data-retention.md` | `AgentProposalApproval` classified as a regulatory artefact. |
| `tests/guardrails/tenant-isolation-forward-lock.test.ts` | `ISOLATION_TESTED` entry. |
| `tests/guardrails/schema-index-coverage.test.ts` | Layer C-completeness triage. |

## Decisions

- **Three absences, not one.** `policyCardVersion` NULL / 0 / `>= 1` are three
  different facts and the resolver keeps them apart: unknown ⇒ strictest; "asked,
  answer was none" ⇒ capped at `SINGLE_APPROVER` (absence can never be the thing
  that authorizes auto-approval, which is the required direction); a pin naming a
  version that cannot be read ⇒ strictest, because a card that exists but is
  unreadable is a BROKEN policy, not an absent one.

- **A FOURTH absence, and it is the one that would have been the bypass.** A
  proposal with no agent is split by who wrote it. Written through an API key
  with no agent resolved — only producible with the agent registration gate OFF
  — is the strictest rung: if turning that gate off also downgraded the approval
  requirement, the gate would be a lever for WIDENING authority. Written by a
  session user, it is a human at a keyboard, one approver, never auto-approval.
  A row that NAMES an agent the register cannot produce is the strictest too —
  `autonomy-ceiling.ts` already paid for that third null.

- **`AUTO_APPROVAL` costs one human.** Nothing in this product auto-approves;
  there is no rule engine on this queue. Mapping the rung to zero would ship the
  permission before the mechanism. The rung is preserved as a declaration.

- **`AiHumanOutcome` is reused rather than a new enum minted.** PENDING /
  ACCEPTED / EDITED / REJECTED is the same Art 14 human-oversight vocabulary,
  it already exists, and a new Postgres enum type is one more `ALTER TYPE`
  hazard in a rolling deploy for no new meaning.

- **`approverUserId` has no FK**, matching `RegisteredAgentTool.grantedByUserId`:
  the signature must survive the signer's account being deleted, and a `RESTRICT`
  FK would block that deletion while `SET NULL` would erase the accountability
  the row exists for.

- **DELETE is withheld from `app_user` but not trigger-blocked**, unlike
  `AuditLog`. An approval is deleted only by CASCADE from its proposal or its
  tenant — only when the thing it signs is gone — and a trigger refusing that
  would make deleting a tenant impossible.

- **In-flight proposals become two-approver proposals on deploy.** The new column
  is nullable and deliberately NOT backfilled to 1; NULL reads as 2 everywhere
  including the trigger. Every proposal already queued was composed under no
  requirement at all, and an uncomputed requirement must fail toward the
  expensive answer.

- **`CREATE UNIQUE INDEX IF NOT EXISTS` on `AgentProposal_id_tenantId_key`.**
  That composite parent key is not private to this change — any table wanting a
  tenant-safe composite FK back to `AgentProposal` needs exactly it, under
  exactly that name. Two migrations creating it unconditionally means whichever
  merges second fails with 42P07. Observed for real: a sibling branch had already
  created it in the shared test database.

## Known gaps, stated rather than left to be found

- **The queue UI does not yet show the requirement.** `AgentProposalsClient.tsx`
  renders no "1 of 2 approvals" state and no "you have already signed" hint. The
  usecase returns `AWAITING_APPROVAL` with both counts and the list rows now
  carry `requiredApprovals`, so the data is there; the rendering is not. This is
  where automation bias actually lives, and it is the obvious next increment.
- **A rolling deploy has a window.** A container running the old image approves
  through the old single-reviewer path and writes no signature row. That closes
  when the last old container drains; it is inherent to adding any gate.
- **Re-scoring an agent does not retighten proposals already queued.** The pin
  records what was required when the work was proposed, which is the evidentiary
  question; a re-score changes future proposals.
