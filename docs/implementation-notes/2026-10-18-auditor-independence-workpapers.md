# 2026-10-18 — Auditor independence, the line of defence and the workpaper record (step 3b)

**Commit:** `feat(agentic): workpaper record, line of defence and the auditor independence check (3b)`

Step 3b of the agentic IAM roadmap (#3675, part of #3658 · UC4). Decision 3:
the second line owns and operates the auditor agent, internal audit samples its
workpapers, and the auditor is not the auditee (rule 8).

## Design

Three parts, one migration (`20261018170000_auditor_independence_workpapers`):

```
TenantMembership.lineOfDefence  FIRST | SECOND | THIRD | NULL ("not declared")
        │  one writer: setMembershipLineOfDefence
        │  PUT …/admin/members/:id/line-of-defence  (admin.owner_management)
        ▼
RegisteredAgent.isAuditor ──► independence check (pure: lib/agentic/auditor-independence.ts)
        │                       owner ACTIVE ∧ line = SECOND ∧ owns no audited agent
        │   REFUSE  at: insert recipe (registerAgent), amend that sets the mark,
        │               every move to ACTIVE (assertActivatable)
        │               + trigger registered_agent_auditor_independence
        │   FINDING at: transfer completion, any registration, an unmark, a line change
        ▼
AuditWorkpaper ──► AuditWorkpaperFinding (insert-only)
   recordAuditWorkpaper  (job / the auditor agent; ACTIVE + independent)
   stampAuditWorkpaperReview (THIRD line, not the auditor's owner; once)
   triggers: insert guard (author is an auditor, born unreviewed, first sample
             binding) · one-way (only the stamp, once, every role)
```

The rule is written three times on purpose, as the repo does for its other
authorization invariants: a pure function the usecase calls (named refusals,
every failing term), a usecase that reads the facts in two batched queries, and
a trigger that reads the same three facts for any writer that skips the
usecase. The reason codes are the same in all three.

## Files

| File | Role |
|---|---|
| `prisma/schema/enums.prisma` | `LineOfDefence` |
| `prisma/schema/auth.prisma` | `TenantMembership.lineOfDefence`; Tenant back-relations |
| `prisma/schema/agentic.prisma` | `RegisteredAgent.isAuditor`, `auditWorkpapers` |
| `prisma/schema/audit-workflow.prisma` | `AuditWorkpaper`, `AuditWorkpaperFinding` |
| `prisma/migrations/20261018170000_auditor_independence_workpapers/` | columns, tables, CHECKs, four triggers, grants, RLS |
| `src/lib/agentic/auditor-independence.ts` | the rule, reason codes, finding text |
| `src/lib/agentic/audit-workpaper.ts` | the record contract, periods, epochs, digest, binding-sample comparison |
| `src/app-layer/usecases/auditor-independence.ts` | lock, refusal, reconcile (finding) |
| `src/app-layer/usecases/membership-line-of-defence.ts` | the line's one writer |
| `src/app-layer/usecases/audit-workpaper.ts` | record, link, stamp, binding sample, list, get |
| `src/app-layer/repositories/AuditWorkpaperRepository.ts` | the workpaper reads and writes |
| `src/app-layer/usecases/agent-registry.ts` | recipe, register, amend and activation wiring |
| `src/app-layer/usecases/agent-ownership-transfer.ts` | lock first, reconcile after the move |
| `src/app/api/t/[tenantSlug]/admin/members/[membershipId]/line-of-defence/route.ts` | the PUT |
| `src/lib/security/route-permissions.ts` | the rule, above the members catch-all |

## Decisions

- **The auditor mark is a boolean column, `isAuditor`, default false.** An enum
  ("role" of an agent) would invite more values that each need an independence
  story. Only `registerAgent` and `updateRegisteredAgent` write it; the intake's
  strict schema refuses the key, and `createRegisteredAgent` (the isolation
  seam) does not take it. `RegisteredAgentRepository.update` excludes it by
  type; `setAuditorMark` is its only post-registration write.
- **Unmarking is never refused.** It takes authority away. Workpapers keep their
  `auditorAgentId` (frozen by the one-way trigger), so unmarking launders
  nothing; re-marking asks the check again. Unmarking makes the agent an audited
  agent, so it reconciles the owner's other ACTIVE auditors.
- **Audited agents are every other agent that is not RETIRED and not
  soft-deleted, DRAFT and SUSPENDED included** — each can be put back into
  service by the register's ordinary act. Other auditors are not audited. The
  legacy placeholder agent counts: it is a register row its owner is
  accountable for.
- **A refusal while standing is granted; a finding for a later break.** The
  issue says a later ownership change "raises a finding", and every later break
  is an accountable act (a two-person transfer, an OWNER's declaration, a
  registration) that a refusal would block. A line change is treated as the
  same kind of break as a transfer: refusing it would keep a declaration false
  because an auditor depends on it.
- **The finding is HIGH and a NONCONFORMITY, and suspends nothing.** No agent
  action becomes unconstrained and no data moves, so not CRITICAL; but every
  workpaper after the break would be the auditee auditing itself, so the record
  seam refuses to write one and the procedure goes unevidenced until it is
  fixed, so not lower. One finding per auditor (`sourceRef` = agent id),
  reopened rather than duplicated. A fixed break closes nothing: closing is a
  person's act, and an auto-close would be a path where the system decides an
  assurance problem is over.
- **Only ACTIVE auditors are reconciled.** A DRAFT or SUSPENDED auditor writes
  nothing, and every way back into service passes `assertActivatable`, which
  asks the whole rule.
- **An owner who leaves is not reconciled here.** Membership deactivation and
  removal are the owner-orphan pass's case (2b); meanwhile the record seam
  refuses the auditor's workpapers (`OWNER_NOT_ACTIVE_MEMBER`).
- **A per-tenant advisory lock, taken first.** Without it, activating an auditor
  and registering an audited agent to its owner each pass on a snapshot that
  cannot see the other. Every path takes `auditor-independence:<tenantId>`
  before any row lock (the transfer completion as its first statement), and the
  trigger takes the same key, so no holder waits for it while holding a row
  lock another holder needs.
- **The line's setter requires the BUILT-IN role OWNER as well as the key**, and
  refuses one's own membership and any credential. A tenant with one OWNER
  cannot declare that OWNER's line, which the roadmap accepts: add a second
  OWNER, or let another member own the auditor.
- **No free-text conclusion, so nothing to encrypt.** The catalogue binds every
  fact to a code, an identifier or a count; the conclusion is `TestResult` plus
  a CHECK-pinned basis code, and unit ids admit no space, `@` or `.`. Recorded in
  `encrypted-fields.ts` beside the audit models.
- **Findings link through a join table**, `AuditWorkpaperFinding`, the shape of
  `FindingEvidence` / `FindingRisk` / `FindingAsset` but with `findingId` a
  plain id bound by an insert trigger rather than a cascading key: the table is
  retained by the tenant purge and `Finding` is not, and no retained table may
  be reachable by a cascade from a purged one. Its only keys are to the tenant
  and its workpaper, both retained. Evidence and proposal references are plain id arrays,
  because both are purged on their own schedules and a regulatory record must
  outlive them; the control-test run is a plain id for the same reason.
- **`auditorAgentId` is a plain id too, with no foreign key** — found by
  `tenant-purge-retains-regulatory`. The tenant purge keeps every Regulatory
  artefact and deletes the register, so a NO ACTION key would have failed every
  purge of a tenant with a workpaper, and a CASCADE one would have destroyed the
  workpaper with its agent. `AgentKillSwitch.agentId` and
  `AgentActionReceipt.agentId` are the precedent. The insert trigger still
  refuses an id that is not an auditor agent of the same tenant, and both models
  are in `TENANT_PURGE_RETAINED`.
- **The first sample is binding, enforced by a trigger.** The procedures doc's
  gap row assigned the storage to this step. Each run writes a workpaper; the
  first that drew a sample for a (procedure, period) fixes epoch, seed
  fingerprint and ids, and the insert trigger refuses another under a per-key
  advisory lock. `getBindingWorkpaperSample` reads it back for 3c.
- **No workpaper route.** The writer is 3c's auditor, in-process on the
  control-test runner; the human review route belongs to 3d with its
  assignment rules. 3b ships the seams those steps call: record, link, stamp,
  the binding read, and list/get under `audits.manage`.
- **The review stamp is internal audit's.** THIRD line, an ACTIVE member,
  `audits.view`, a person, and not the auditor's owner — re-checked at stamp
  time, so an owner who has since been moved to THIRD is still refused.
