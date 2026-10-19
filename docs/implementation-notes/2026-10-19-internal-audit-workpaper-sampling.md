# 2026-10-19 — Internal audit samples the auditor's workpapers (step 3d)

**Commit:** `feat(agentic): internal audit samples the auditor agent's workpapers (3d)`

Step 3d of the agentic IAM roadmap (#3677, part of #3658 · UC4). The auditor
agent (3c) re-performs audit procedures and writes workpapers (3b); this step is
the check on the auditor. A daily sweep draws the workpapers, assigns each to
a member of internal audit, that member re-performs it and answers once, a
dissent becomes a finding proposal somebody else decides, and the agreement
rate is a reported figure with its definition. Owner decisions of 2026-10-19 are
on the issue — the seven the step started from, and the answers to the five
questions its first version raised (who sets the rate, whether the dissenter
decides, how often the sweep runs, whether internal audit sees the whole queue,
whether an expired dissent proposal is raised again).

## Design

```
                 daily, 09:40 UTC
  AuditWorkpaper ──► jobs/audit-workpaper-sample-review.ts
  (3b/3c)              1. DRAW    isDrawnForReview(seed, epoch(period), id, rate)
                                  rate = TenantSecuritySettings.workpaperReviewSamplePercent (100;
                                         set only by internal audit, PUT …/sample-rate)
                       2. ASSIGN  assignReviewer: selectSample over ACTIVE THIRD-line
                                  members minus the auditor's owner, same epoch
                                  └─ nobody → UNASSIGNED + named reason
                       3. RE-DRAW only a PENDING row nobody can answer
                       4. HEAL    a dissent whose proposal was never raised
                                      │
                                      ▼
                       AuditWorkpaperSampleReview (one row per workpaper)
                                      │
  /audits/workpaper-reviews ──► usecases/audit-workpaper-sample-review.ts
  (internal audit: every row,    recordWorkpaperReview: assignee, person, ACTIVE
   others: their own; a Sheet,   THIRD, not the owner → CONCURRED / DISSENTED /
   form on your own row only)    INDETERMINATE once, codes only; sets the 3b stamp
                                      │ DISSENTED
                                      ▼
                       raiseDissentFindingProposal → createAgentProposal
                       (reviewer's session, NO_POLICY_CARD, HUMAN_AUTHOR)
                       → the ordinary queue → approveAgentProposal by a person
                         other than the dissenter (assertNotDissentAuthor)

  getWorkpaperReviewRate → report 6 `workpaper-review` of the governance pack
  (assurance.workpaper_*, each with its definition; rates over concluded only)
```

## Files

| File | Role |
|---|---|
| `src/lib/agentic/workpaper-review-sampling.ts` | Pure rules: the epoch, the per-workpaper keyed draw against a rate, the reviewer draw, eligibility, the pool digest, the agreement rate, the dissent proposal's text |
| `src/lib/agentic/workpaper-review-codes.ts` | The answers, the dissent codes and the refusal reasons, with no server imports so the page's form holds the same list |
| `src/app-layer/jobs/audit-workpaper-sample-review.ts` | The sweep — the only writer that creates or re-assigns a review |
| `src/app-layer/usecases/audit-workpaper-sample-review.ts` | Internal audit's standing; the list (overview or own) and read; the write-once answer; the idempotent dissent raise; the rate setter; the agreement rate |
| `src/app-layer/schemas/audit-workpaper-sample-review.schemas.ts` | The strict answer and rate schemas |
| `src/app/api/t/[tenantSlug]/audits/workpaper-reviews/**` | `GET` queue, `GET` one, `POST` answer, `PUT sample-rate` — `requirePermission('audits.view')` |
| `src/app/t/[tenantSlug]/(app)/audits/workpaper-reviews/*` | The review page: `EntityListPage` + `Sheet` with an inline `RadioGroup` / `Combobox` form, and the inline rate control |
| `src/app-layer/jobs/schedules.ts` | The daily entry and why daily cannot enlarge the sample |
| `src/lib/nav/page-segregation.ts`, `src/lib/nav/canonical-parents.ts` | The page is a sub-page of the audits hub, whose back affordance returns to `/audits` |
| `prisma/schema/audit-workflow.prisma`, `auth.prisma`, migration `20261019060000_audit_workpaper_sample_review` | The table, its CHECKs and triggers, RLS; the per-tenant rate column |
| `src/app-layer/usecases/agent-governance-reports.ts`, `src/lib/agentic/report-definitions.ts`, `pack-document.ts`, `ReportsClient.tsx` | Report 6 and its seven definitions |
| `src/app-layer/usecases/audit-workpaper.ts` | `stampWorkpaperReviewedInTx`, the 3b stamp shared with the answer |
| `src/app-layer/usecases/agent-proposals.ts` | The proposal-created audit row now says `USER` for a person's session with no key and no agent; every deciding path refuses the dissent's own author |

## Decisions

- **A keyed decision per workpaper, not `selectSample`'s rank over a run.** The
  owner asked for the keyed sampler at a configurable rate. A rank is taken over
  the population a run sees, and a workpaper population grows after every run (a
  re-run writes a new workpaper for an old period); re-ranking a grown population
  re-draws, so a workpaper passed over once is a fresh candidate every month and
  the sample creeps towards everything below 100%. Deciding each workpaper by
  `sampleScore` against the rate, with the epoch fixed by its period, re-derives
  identically on every sweep and is monotone in the rate. The rank's extra
  property for ASI09 — unpredictable even to a holder of the seed — is not needed:
  the party it would help is the auditor's second-line owner, who does not hold
  the master KEK, and at 100% there is nothing to predict. `selectSample` is still
  what draws the reviewer.
- **The rate is a per-tenant column, not a source constant.** "Lowered later
  without a code change" rules out a constant, and internal audit's sampling plan
  is per tenant, so not an env var. `TenantSecuritySettings` is where the other
  agentic per-tenant numbers live. Default 100, CHECK 1..100 (NOT VALID +
  conditional VALIDATE), and a missing or unreadable value reads as 100.
- **Only internal audit sets the rate** (owner decision, 2026-10-19). A person,
  ACTIVE, on the THIRD line, owning no auditor agent — the same standing as the
  overview, computed by one function. The second line operates the auditor, so
  a second-line setter would let the auditee choose how closely it is checked.
  The route sits under the review page's key, `audits.view`, because internal
  audit is often on the AUDITOR role and holds no admin key; the usecase is the
  gate. Authority is checked before the body is parsed, so a refused caller
  leaves its `AUTHZ_DENIED` row whatever it sent, and checked again under a
  per-tenant advisory lock so the audited "before" is the value replaced. The
  range was already a CHECK, so no migration changed.
- **Daily, not monthly** (owner decision, 2026-10-19). Monthly meant an item
  drawn before anybody was declared third-line waited up to a month. Daily
  costs nothing in sample integrity: each workpaper's draw is a fixed function
  of its score, the rate and its period's epoch, and one row per workpaper is a
  unique index, so a second run the same day writes nothing — the property the
  ASI09 rank does not have and the reason it stays weekly.
- **Re-draw, rather than strand.** An UNASSIGNED item is re-tried by every later
  sweep, and an assignee who stopped being eligible (left, moved off THIRD, came
  to own the auditor) is replaced, from the same epoch over the pool as it then
  stands. A valid assignment is never moved, so nobody can be reviewing a row
  that is pulled from under them. Without this the pilot's first month, swept
  before an OWNER declared anybody third-line, would be unreviewable forever.
- **Decision 4: the reviewer's own session raises the proposal, through
  `createAgentProposal`.** The queue's propose seam already takes person-
  originated proposals (the assistant, the AI-system conformity draft). The
  alternative, the MCP tool funnel as the auditor agent, would attribute
  internal audit's judgement to the auditee, spend the auditor's budgets, and let
  the auditor's kill switch or breaker stop the check on the auditor. With no
  agent and no key, `resolveApprovalRequirement` reads `HUMAN_AUTHOR` (one
  approver) and the pin is `NO_POLICY_CARD`; the guards, expiry, tiering and
  approval are the queue's own. No `Finding` is written here.
- **The dissenter never decides their own dissent's proposal** (owner
  decision, 2026-10-19), and it is enforced in the queue's usecase, not here:
  `approveAgentProposal` (which also carries an approval with edits),
  `rejectAgentProposal` and `bulkRejectAgentProposals` each refuse the person
  the review names as `reviewedByUserId`. Keyed off the proposal's origin ref
  and the REVIEW, not off who created the proposal, because a failed raise is
  healed by the sweep under a system context and the bar must hold then too.
  A ref naming a review the tenant does not hold refuses everybody. No second
  approval path: the same queue, minus one person.
- **An expired dissent proposal is not raised again** (owner decision,
  2026-10-19). The link is write-once; the expiry is itself the record that
  nobody decided, and a re-raise would overwrite that with a fresh queue entry.
- **Internal audit sees the whole queue** (owner decision, 2026-10-19). Every
  assignment and its status, the assignee named, so a lead can see what is
  waiting on whom and what is UNASSIGNED; answering stays the assignee's alone,
  and somebody else's row opens read-only. Anybody else with `audits.view` sees
  only their own. "Owns the auditor" includes an agent that has WRITTEN
  workpapers but is no longer marked, so unmarking it does not hand its owner
  the overview.
- **Exactly once without a cross-transaction write.** `createAgentProposal`
  commits in its own transactions, so the raise holds a per-review advisory lock
  in an outer transaction, returns the link if the row has one, otherwise looks
  up a proposal by origin ref (`proposedBySessionRef`, a plain column — the
  payload is encrypted, and the owner-orphan pass uses the column the same way),
  raises only if none exists, and links once. A raise that fails after the
  answer committed is raised by the next sweep under a system context.
- **The proposal-created audit row says `USER` for a person.** It said
  `API_KEY` for every non-job caller, which was false for the assistant and the
  conformity draft and would have been false for internal audit's dissent. Only
  a context with neither a key nor an agent changes label.
- **The answer sets the 3b review stamp.** 3b's docstring named this step's
  reviewer as the one who sets it. The stamp is conditional, so a workpaper a
  second-line member already stamped keeps that stamp and still gets its review.
- **Report 6, not three more figures in report 3.** Report 3 is whether humans
  approving agent proposals mean anything; this is whether an agent's audit work
  holds up when a human repeats it. Its own envelope keeps each report's
  definitions-cover-metrics check exact.
- **A Sheet with an inline form, and a secondary button.** The primary-button
  census sits at its ceiling of 175, and a dialog's last button must be primary.
  The reviewer reads the workpaper and answers in one place; the one action is
  `variant="secondary"`, so the census does not move.
- **The database refuses the same people the usecase refuses.** The assignee on
  insert and re-assignment, and the answerer, must hold an ACTIVE THIRD-line
  membership and not own the auditor agent (`audit_workpaper_sample_review_assert_reviewer`);
  the answerer must be the assignee (CHECK); the dissent codes are pinned to the
  vocabulary (CHECK). "The owner can never review" holds for a writer that skips
  the usecase.
