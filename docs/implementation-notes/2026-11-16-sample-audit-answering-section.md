# 2026-11-16 — answering the retrospective sample audit

**Commit:** `(this PR)` feat(agents): answer retrospective sample audits on the review-quality page

## Design

OWASP ASI09's instrument is a second human re-reviewing an already-approved
agent proposal. Everything behind it was built: the sampler draws the sample,
`recordSampleAuditOutcome` records the answer with the four-eyes refusal, and
`getSampleAuditDisagreementRate` reports THE NUMBER. What was missing was a way
to answer one through the product — the route existed, no surface called it — so
the rate could only ever report "nothing answered", which is the one reading an
auditor cannot use.

This adds the answering section to `/agents/review-quality`, which already gates
on `admin.agent_registry` — the same key both sample-audit routes take, so the
page and its data agree with no new permission decision.

The shape of the change is one rule in two places rather than two rules:

```
src/lib/agentic/sample-audit-answerability.ts   pure; no Prisma, no ctx
   sampleAuditSelfReviewBasis()  ── who counts as the approver
   sampleAuditAnswerRefusal()    ── the write's three refusals, IN ITS ORDER
        │                                    │
        │ read by the WRITE                  │ read by the READ
        ▼                                    ▼
recordSampleAuditOutcome()            listSampleAuditsForReview()
   403 + AUTHZ_DENIED                    per-row `refusal`, ids dropped
                                              │
                                              ▼
                                         page → panel (strings only)
```

An admin page offers a write only where the server takes it (#4467). The hardest
of the three refusals — the caller approved the proposal under review — is a
fact about rows the queue does not contain, so the page needs a server read that
resolves it. `listSampleAuditsForReview` reads the proposal's `reviewedByUserId`
and its counted signatures, hands them to the shared predicate, and returns the
VERDICT. The identities never leave the server.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/sample-audit-answerability.ts` | The two pure predicates both callers read |
| `src/app-layer/usecases/agent-proposal-sample-audit.ts` | Write now reads the predicate; adds `listSampleAuditsForReview` |
| `src/app/t/[tenantSlug]/(app)/agents/review-quality/page.tsx` | Reads the queue, resolves both labels, renders the section |
| `src/app/t/[tenantSlug]/(app)/agents/review-quality/SampleAuditQueue.tsx` | The client panel — renders strings, holds the form's own pairing rule |
| `messages/{en,bg}.json` | `agents.sampleAudit.*` — outcomes, the seven codes, the three refusals |

## Decisions

- **The predicate was EXTRACTED rather than copied.** A page-side copy is a copy
  that forgets the first signer of a two-approver proposal, which is exactly the
  defect #5112 fixed in the usecase — and a copy that forgets it offers an Answer
  button to the approver. The integration suite now asserts the read and the
  write agree on that case by name.

- **The refusal ORDER is part of the extracted rule.** The write asks the coarse
  write tier, then self-review, then already-answered. So an approver opening a
  row somebody else has closed is told they may not review their own approval —
  the true reason, and the one that leaves an `AUTHZ_DENIED` row — rather than
  being told about a race.

- **Three refusals are the server's, two are the form's, one is nobody's.** The
  server's arrive per row and render as a reason with NO control (never a
  disabled button that posts and fails). The outcome/codes pairing is the form's,
  because it is a property of the form rather than of the row. The race is
  deliberately held by neither: only the server's conditional claim on
  `outcome: 'PENDING'` can settle it, and the panel treats that refusal as
  somebody's answer rather than as a retryable failure.

- **A new read rather than an option on the existing one.** The extra `select` is
  a join per row. The API route serves callers who want the queue;
  the page is the only caller that needs the verdict.

- **Both labels are resolved on the server.** The kind catalogue is
  `agents.proposals.kind.*`, which the proposal queue already owns, and the agent
  names come from the page's existing name lookup — the queue's agent ids were
  added to it rather than given a second query. The panel renders strings and
  holds no catalogue.

- **The section sits OUTSIDE the `decided === 0` branch.** That branch is about
  the decision window; an audit drawn weeks ago is still open and still somebody's
  to answer, so hiding the queue on a quiet window would hide exactly the backlog
  the surface exists to show.

- **The audit row's `basis` field kept its literal ternary.**
  `tests/guards/no-raw-prompt-logging.test.ts` counts a field bound to an
  identifier as a position it cannot analyse, and binding `basis` to the
  predicate's return moved its measured hole count by one. The refactor was meant
  to move where the verdict is COMPUTED, not to make what reaches a hash-chained
  row less legible to the scanner that reads that path, so the sink re-derives a
  boolean and the emitted row is byte-identical to the one before it.

- **The submit button is `secondary`.** It is one row's inline confirm on a report
  page, not the page's own action, and the ghost Cancel beside it carries the
  hierarchy. The primary-count ceiling is a repo-wide budget; spending one here
  would be spending it on the Nth row.

- **The queue read is NOT a rate surface.** `getSampleAuditDisagreementRate` is
  THE NUMBER and this page is where it belongs, but putting it on the page is a
  separate decision and a separate diff — the section here is the answering
  affordance only. An answer calls `router.refresh()` so a rate rendered later
  cannot describe the moment before the click.
