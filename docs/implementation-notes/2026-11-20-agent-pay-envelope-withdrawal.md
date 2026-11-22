# 2026-11-20 — Agent Pay 1.4: a recertification pack proposes withdrawing a spending envelope

**Commit:** see the pull request for #5333 (stacked on the register-surfaces change).

## Design

The owner answered the four questions the register-surfaces note left open
(decisions of 2026-11-20 on #5333):

1. A pack proposes WITHDRAWING an envelope on any of four grounds, and records
   which: it expires before the end of the review window; it is still
   SUSPENDED_REQUESTED after the agent's kill switch fired; it was never
   reviewed; the harness no longer shows the agent able to pay. Answers to the
   follow-ups: the last is confirmed by a person, never derived from a scan;
   and "before the end of the review" includes the campaign itself.
2. Withdraw only — never a lower limit.
3. Accepting it under `access_reviews.decide` may write the withdrawal through
   the envelope writer, on a narrowly scoped internal path, and opens a task for
   the agent's owner to revoke the token at the token requestor.
4. A new sibling table with its own one-way triggers; the grant narrowing is
   not altered.

```
READ step   readAgentRecertificationEvidence ── spendingAuthority[] (built with the register surfaces)
SYNTHESIS   planAgentReviewPacks ── packs[].spendingWithdrawals = spendingWithdrawalsFor(subject)
prepare     checkedPlan (re-derived, refused on mismatch) ──▶ AccessReviewAgentSpendingWithdrawal rows

decide      POST …/agent-spending-withdrawals/:id   (access_reviews.decide)
            decideAgentSpendingWithdrawal
              reviewer-or-admin, never the owner (frozen or current), claim PENDING → ACCEPTED/REJECTED
              ACCEPTED ─▶ withdrawSpendingAuthorityForRecertificationInTx   (agent-spending-authority.ts)
                            lock agent FOR SHARE · read the row on that rail
                            declaredAt differs  → ENVELOPE_REDECLARED (left alone, no task)
                            already WITHDRAWN   → ENVELOPE_ALREADY_WITHDRAWN (+ task)
                            otherwise CAS updateMany → WITHDRAWN, close the widened finding (+ task)
                            task: TaskRepository.create in the same transaction, assigned to the
                                  current owner if an active member
                         ─▶ stamp executedAt / executionResult / ownerTaskId once
              audit last: SPENDING_AUTHORITY_WITHDRAWN, TASK_CREATED, …_WITHDRAWAL_DECIDED
submit      a pending withdrawal refuses the subject's verdict (WITHDRAWALS_PENDING)
close       a pending withdrawal refuses the close (WITHDRAWALS_PENDING); the evidence
            document carries each subject's withdrawals
```

## Files

| File | Role |
| --- | --- |
| `prisma/schema/audit-workflow.prisma`, `auth.prisma` | `AccessReviewAgentSpendingWithdrawal` and its back-relations |
| `prisma/migrations/20261120120000_access_review_agent_spending_withdrawal/` | Table, CHECKs (owner not decider, grounds vocabulary, stamp consistency), one-way trigger, no `app_user` DELETE, RLS |
| `src/lib/agentic/agent-recertification.ts` | `SPENDING_WITHDRAWAL_GROUNDS`, `spendingWithdrawalsFor`, the plan's optional `spendingWithdrawals`, the evidence document's per-subject withdrawals |
| `src/app-layer/usecases/agent-spending-authority.ts` | `withdrawSpendingAuthorityForRecertificationInTx` and `auditRecertificationWithdrawal`, the internal path |
| `src/app-layer/usecases/access-review-agent.ts` | Writing the rows at preparation, `decideAgentSpendingWithdrawal`, the verdict and close holds, the read and the evidence rows |
| `src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/agent-spending-withdrawals/[withdrawalId]/route.ts`, `route-permissions.ts` | The decide route, `access_reviews.decide` |
| `src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/agent-spending-withdrawals/route.ts` | The reviewer's "it can no longer pay" confirmation (ground d), same key |
| `AccessReviewDetailClient.tsx`, `messages/{en,bg}.json` | The "Proposed spending withdrawals" table beside the narrowings |
| `src/app-layer/usecases/tenant-purge.ts`, `docs/data-retention.md` | Retained with the campaign, whole |

## Decisions

- **Ground (d) is a person's statement, never a scan's** (owner answer to the
  follow-up question, 2026-11-20). The only stored signal would be a scan that
  no longer reports the payment capability, and Agent Pay 2.3 found that the
  code reader reports `[]` where it cannot see — absence, not evidence. So the
  campaign's reviewer confirms "it can no longer pay" on a rail
  (`confirmAgentHasNoPaymentAbility`, `POST …/agent-spending-withdrawals`,
  `access_reviews.decide`), which opens a PENDING row with the ground
  `NO_PAYMENT_ABILITY_CONFIRMED` and `proposedByUserId`, decided like any other.
  A CHECK makes that ground stand alone, pairs it with its confirmer, and
  refuses the agent's owner as confirmer; `PackPlanSchema` refuses it in a plan,
  so no agent can put it there. It is offered only for an envelope the pack
  describes, not withdrawn when read, and with no row yet (`(packId, rail)` is
  unique; a planned proposal is decided instead), and only before the subject's
  verdict.
- **"Expires before the end of the review" has two grounds** (owner answer,
  2026-11-20: include the campaign itself). `EXPIRED_BY_WINDOW_END` is the
  pack's fact `expiredAtWindowEnd`, lapsed by the end of the observation
  window, which ends at the campaign's creation. `EXPIRES_DURING_CAMPAIGN` is
  `expiresDuringCampaign`: lapsing after that but by the campaign's due date,
  or by the read when the campaign has none or is overdue. The two never both
  apply. The field is optional, so evidence recorded before it re-derives to
  the same plan.
- **"Still SUSPENDED_REQUESTED after the kill" is the status alone.** Only an
  AGENT-scope kill or an orphan containment writes it
  (`requestSpendingSuspensionInTx`), and only a re-declaration or a withdrawal
  leaves it.
- **"Never reviewed" is `reviewedAt` null on the declaration now on the row.**
  A re-declaration clears the review, so a widened envelope awaiting its second
  person is "never reviewed" in the sense that matters: nobody else has
  reviewed what it now says.
- **The envelope is named by `(agentId, rail, declaredAt)`.** The row is one
  per agent per rail and re-declared in place, so `declaredAt` tells the
  declaration the pack read from a later one, which a second person may have
  reviewed since. Accepting withdraws only the one the pack read; a later one is
  `ENVELOPE_REDECLARED` and left alone, as a grant re-issued after a pack is not
  the one a narrowing deletes. A narrowing in place keeps `declaredAt`.
- **The task is written in the decision's transaction, as the reviewer.**
  Acceptance and the follow-up stand or fall together, unlike the kill switch's
  suspension task, which is best effort after commit because a stop control
  must not fail. The task carries the token reference in its (encrypted)
  description, as the suspension task does; no audit row and no withdrawal row
  carries it. An envelope already withdrawn on the register still gets the
  task: the register's withdrawal opened none, and the token may still live.
- **The internal path has no permission check of its own**, as the retirement
  cascade's effects have none, and can only move one declaration to WITHDRAWN.
  The single-write-seam guard pins that: the campaign file imports only that
  function and its audit from the writer, the function's one envelope write is
  a conditional `updateMany` to `WITHDRAWN`, and it writes no other table.
- **The plan's key is optional and absent for evidence without the section**,
  so a run recorded before it re-derives to the same bytes. The evidence
  document's key is absent for a subject with none, so a campaign closed before
  withdrawals existed recomputes to the hash it was filed with.
- **The worst page grows by 546 bytes** (three withdrawals, every ground, per
  agent): it seals at 231,176 of the 235,929 budget. `PACK_PAGE_SIZE` stays 2.
- **No new dissent code.** A second reviewer who thinks a withdrawal was
  wrongly decided has `DECISION_NOT_SUPPORTED_BY_PACK`; a withdrawal-specific
  code is a vocabulary change for the owner.
