# 2026-09-06 — Sample-audit approved proposals, and expire stale ones (ASI09)

**Commit:** `<sha> feat(agentic): sample-audit approved proposals and expire stale ones`

## Design

OWASP **ASI09 — human-agent trust exploitation**. The product's whole safety
story for agentic writes is that an agent never mutates a record directly:
every write routes through `AgentProposal` for human approval. That control is
correct in DESIGN and, until this change, entirely UNMEASURED in practice — and
a rubber-stamped queue is strictly worse than no queue, because it manufactures
an auditable record of consent nobody actually gave.

Two things were missing, and they are the two halves of one argument.

**1. Nothing measured whether approvals were right.** Every signal the queue
emitted described its SHAPE — counts, latency, who clicked. All of them stay
green while a reviewer clears the list without reading it. The only instrument
that can see the difference is a second human re-reviewing an approval that has
already happened.

**2. Nothing bounded the queue's DEPTH.** Depth is the driver of the
rubber-stamping, so an unbounded queue belongs in the threat model rather than
in a housekeeping backlog. A proposal now carries a deadline; past it, it
cannot be approved.

```
propose ──► AgentProposal (PENDING, expiresAt pinned from the card's rung)
                 │
      ┌──────────┼───────────────────────────────┐
      │          │                               │
   approve    reject                    window closes
   (clock-    (clock-                           │
    checked)   checked)              agent-proposal-expiry (00:40 UTC)
      │          │                               │
  ACCEPTED/   REJECTED                        EXPIRED   ← terminal, nothing deleted
   EDITED                                      + AGENT_PROPOSAL_EXPIRED audit row
      │
      └──► agent-proposal-sample-audit (Mondays 09:30 UTC)
                 │  keyed rank draw over the last 30 days of approvals
                 ▼
           AgentProposalSampleAudit (PENDING)
                 │  answered by a human who is NOT the approver
                 ▼
        CONCURRED / DISSENTED(+codes) / INDETERMINATE
                 │
                 ▼
           disagreement rate  ← the number the subsystem is judged on
```

### Sampling: reproducible enough to test, not predictable enough to game

The tension is real and both horns are fatal. A draw nobody can re-derive
cannot be shown to be fair; a draw a reviewer can predict at approval time
measures their eyesight rather than the queue. `Math.random()` gives the second
property only; a public hash of the proposal id gives the first only.

Three independent properties get both, and only the third survives an adversary
who has read the source:

1. **Keyed.** The score is `HMAC-SHA256` under a per-tenant subkey derived from
   the master KEK (`deriveSubkey`). The seed is never stored, never rendered,
   never logged; only the epoch is persisted. Defeats a reviewer with the code.
2. **Epoch-bound.** The run's UTC date is mixed in, so "am I safe?" has one
   answer per run rather than one answer forever.
3. **Rank over a population** — the load-bearing one. A proposal is not selected
   by its score crossing a threshold; it is selected by being among the lowest
   scores IN THE POOL THE RUN DRAWS FROM, and that pool contains approvals made
   *after* it. So even holding the seed, nobody can know at approval time
   whether a proposal will be drawn: the answer depends on decisions nobody has
   made yet.

Reproducibility survives intact: given `(seed, epoch, candidates)`,
`selectSample` is deterministic. That triple is exactly what a test supplies
through the job's test-only `seed` / `epoch` options, and exactly what a
reviewer cannot assemble.

### Expiry and the tiering lane: does the clock run the same way?

Stated rather than left implicit, because the answer is not the intuitive one.

**The clock STARTS at propose time and NEVER restarts** — identically for every
rung. In particular it does **not** restart when a first approver signs a
proposal whose policy card requires a second. A window that restarts on partial
progress can be held open indefinitely by one person signing every seventh day,
which would leave the rung demanding the MOST scrutiny as the only one with no
effective deadline. That is the automation-bias failure wearing the costume of
the control meant to prevent it.

What DOES vary by rung is the window's **length**, read from `approvalRung` on
the `AgentPolicyCardVersion` the proposal already pins — no parallel tiering
input was invented. `SECOND_APPROVER` gets 14 days, `SINGLE_APPROVER` and
`AUTO_APPROVAL` 7, an absent card 7. Read it as "time to find the humans this
rung requires": a longer window **granted at the start**, never an extension
**earned by progress**. Those are different rules and only the first bounds the
queue.

### Expiry does not delete evidence

An expired proposal is the record of something an agent asked for and no human
ever agreed to — the raw material for "what is this agent trying to do that
nobody wants?", and the only trace that the queue was too long to serve. So
expiry is a status transition to a terminal `EXPIRED`, with `payloadJson`,
`rationale`, `guardVerdict`, `agentId` and `policyCardVersion` untouched and
`reviewedByUserId` left NULL, plus one hash-chained `AGENT_PROPOSAL_EXPIRED`
row. Nothing is hard-deleted; the retention doc classifies `AgentProposal` as a
business record with no age-based prune.

Rejection of an expired proposal is refused for the same reason: moving the row
to `REJECTED` would overwrite "nobody decided" with "somebody decided no", which
improves the record of a queue that was too slow. "Dispose of it" and "improve
the record" must not be the same click.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/proposal-expiry.ts` | The window ladder and its arithmetic. Pure, no server imports (an admin client renders the same windows). Owns the "clock never restarts" reasoning. |
| `src/lib/agentic/proposal-sampling.ts` | The keyed rank sampler, the dissent-code vocabulary, and the sample-size ladder. Pure; takes the seed as an argument so it is testable without a key. |
| `prisma/schema/agentic.prisma` | `AgentProposal.expiresAt` + `@@unique([id, tenantId])` + `@@index([status, expiresAt])`; new `AgentProposalSampleAudit` model. |
| `prisma/schema/enums.prisma` | `SuggestionItemStatus.EXPIRED`; new `AgentSampleAuditOutcome`. |
| `prisma/schema/auth.prisma` | Tenant back-reference for the new model. |
| `prisma/migrations/20260906090000_agent_proposal_expiry_and_sample_audit/` | Additive `ALTER TYPE … ADD VALUE`, the nullable column with no backfill, the new table with the full RLS policy triple + `FORCE ROW LEVEL SECURITY`, and two CHECK constraints. |
| `src/app-layer/usecases/agent-proposals.ts` | Pins `expiresAt` at creation from the pinned card version's rung; refuses approve/reject on a closed window (403 + `AUTHZ_DENIED`); adds the window to the conditional claim predicate; adds `EXPIRED` to `NON_REVIEWABLE_STATUSES`. |
| `src/app-layer/usecases/agent-proposal-sample-audit.ts` | Reading the queue, answering an audit (with the not-the-approver refusal), and the disagreement rate. Deliberately has **no** create path. |
| `src/app-layer/jobs/agent-proposal-expiry.ts` | The nightly sweep: backfill, then a bounded batch of conditional claims plus one audit row each. |
| `src/app-layer/jobs/agent-proposal-sample-audit.ts` | The weekly draw. The ONLY write seam for `AgentProposalSampleAudit`. |
| `src/app-layer/jobs/{types,executor-registry,schedules}.ts` | Payload contracts, executors, cron entries (00:40 daily / Mondays 09:30). |
| `src/app/api/t/[tenantSlug]/agent-proposals/sample-audits/{route.ts,[id]/route.ts}` | GET the queue + the rate; POST one answer. Usecase-gated, matching the existing agent-proposals routes. |
| `tests/guards/sample-audit-single-draw-seam.test.ts` | A sample audit is DRAWN, never chosen — exactly one create site, and it uses `selectSample`. |
| `docs/data-retention.md` | Reclassifies `AgentProposal` (business record, expiry ≠ deletion) and classifies `AgentProposalSampleAudit`. |

## Decisions

- **The approval refusal reads the CLOCK, not the status.** The sweep runs
  nightly, so a closed window sits on a row that still reads `PENDING` for up to
  a day. A status-only check would have made the deadline enforced by a cron's
  punctuality rather than by the deadline. The sweep is therefore *bookkeeping*:
  a dead worker costs tidiness, never safety. The window is also in the
  conditional claim predicate, so a deadline passing between the read and the
  write loses the claim rather than creating a record.

- **`expiresAt` is pinned, not computed at read time.** Same discipline as
  `policyCardVersion`: a card edit must not silently move the deadline of a
  proposal already in flight, in either direction. Recomputing would let a
  policy change retire a live proposal, or resurrect one whose window had closed.

- **NULL `expiresAt` means "no deadline recorded", never "expired".** The
  migration deliberately does not backfill (SQL cannot resolve a proposal's
  approval rung). The sweep stamps a deadline a **full window from now** rather
  than from `createdAt` — computing it from `createdAt` would mass-expire the
  backlog on the first run after deploy, an outage wearing the costume of a
  control. The grace is one-time by construction.

- **`EXPIRED` is a new enum value rather than a reuse of `REJECTED`.**
  `ALTER TYPE … ADD VALUE` is the additive, rolling-deploy-safe half of the enum
  hazard (a `RENAME` is what makes old containers fail with SQLSTATE 42704), and
  only new code writes the value. Collapsing "nobody decided" into "somebody
  decided no" would fabricate the review this whole subsystem exists to record
  honestly.

- **Dissent is recorded as stable CODES, not free text.** The subject under
  review is agent-authored content living in an encrypted column; a note field
  is the obvious place to quote it, and a quote in a plaintext operator surface
  is that content leaving the store it was put in. Codes also aggregate — "which
  KIND of wrong" is the question that changes an agent's policy card, and prose
  does not answer it at scale. Consequently the new model needs no entry in the
  encryption manifest and no rich-text sanitiser.

- **The re-reviewer may not be the approver.** Without it the approver marks
  their own approval `CONCURRED` and the rate goes to zero exactly in the
  tenants where rubber-stamping is worst, because there the approver is the only
  person looking. Refused as a 403 with a hash-chained `AUTHZ_DENIED` row — an
  authority question, not a request-shape question — and the check sits ABOVE
  the already-answered check so the refusal is recorded even when two people
  race for the same audit.

- **`disagreementRate` is `null`, never 0, over an empty answer set.** Zero
  reads as "nobody disagreed", which is what a perfect record and an unread
  queue both produce. `answered` and `pending` are returned alongside it so a
  caller cannot render a percentage that cannot be wrong. For the same reason
  the sample floor is 1: a tenant with any approvals at all gets one drawn,
  because "0 disagreements over 0 samples" is a measurement that never ran.

- **`PENDING` is not an answer a reviewer may write, and `INDETERMINATE` is.**
  The first would let a decided audit be returned to undecided — the only way
  the rate could be revised downward after the fact. The second is its own
  bucket rather than being folded into either side, because "the evidence was
  insufficient to judge" is a finding about the queue, not a vote about the
  proposal.

- **Weekly, not nightly, for the sample audit.** A candidate is any approval in
  the last 30 days *not already sampled*, so a daily draw of ~10% of the
  remainder converges on re-reviewing nearly every approval within the month —
  which turns a sample into a second full review queue and reinvents the depth
  problem. The cadence is the calibration, not the slot.

- **The sampler is the only write seam, enforced structurally.** If a human
  could open an audit on a proposal of their choosing, the selection could be
  steered toward approvals somebody already wanted re-examined and the rate
  would describe that choice rather than the queue. The guard also pins that the
  seam picks via `selectSample`, so "one seam" cannot become "one seam that
  takes the newest three".

- **Two cron entries, no ordering relationship — stated explicitly.** CLAUDE.md
  warns that declaration order in `SCHEDULED_JOBS` is not execution order, so
  the absence of a dependency is written down: the sweeps act on disjoint
  populations (`PENDING` vs already-approved) and neither reads what the other
  writes.

- **The sampler reads once across every tenant and groups in memory.** Not for
  speed — a per-tenant `findMany` inside the tenant loop is a Prisma READ in a
  loop, which the D1 query-shape guardrail refuses, and refuses for the reason
  it bites here: the loop's length is the number of tenants, so the cost is
  invisible in every fixture and unbounded in production.

- **`@@index([status, expiresAt])` is deliberately not tenant-leading.** It is
  the only such index on `AgentProposal`, and it exists because the expiry sweep
  runs system-wide: a tenantId-leading composite would be a prefix that query
  never supplies. Every per-tenant read still goes through the existing
  tenant-leading composite.

- **`tenantId` is named at every log sink, never spread.**
  `local/no-raw-prompt-logging` cannot read the keys of a spread object, so the
  idiomatic `...(tenantId ? { tenantId } : {})` registers in this repo's own
  census as an unanalysable field bag — the exact shape a prompt would hide in.
  The two new jobs write `tenantId: tenantId ?? null` instead, and the guard's
  measured constants were re-derived in the same diff (holes 84 → 93, sinks
  39 → 49) rather than nudged.
