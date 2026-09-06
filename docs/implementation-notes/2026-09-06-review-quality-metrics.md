# 2026-09-06 — Review-quality metrics for the agent-proposal queue (ASI09)

**Commit:** `feat/agentic-8b — feat(agentic): measure whether approvals on the agent-proposal queue mean anything`

## Design

The product's safety story for the agentic path is propose-not-commit: an agent
never mutates a record, every write lands in `AgentProposal` as PENDING, and a
human approves it. That control was correct in design and entirely unmeasured in
practice. A queue rubber-stamped under volume is worse than no queue: it
manufactures a hash-chained, non-repudiable record of consent nobody gave, in
the one store the retention policy promises never to erase.

Nothing new is stored. Every input already existed — `AgentProposal.createdAt`,
`reviewedAt`, `reviewedByUserId`, `status`, `agentId`, and the
`policyCardVersion` pin that resolves to `AgentPolicyCardVersion.approvalRung`.
There is no model, no migration, no backfill. The finding was that nothing read
these columns this way, not that a table was missing.

```
AgentProposal rows (decided, in window)
        │
        │  + rung resolved from the PINNED (card, version), never today's card
        ▼
usecases/agent-review-quality.ts        ← the only seam: reads, joins, alerts
        │  ReviewObservation[]
        ▼
lib/agentic/automation-bias.ts          ← pure: no prisma, no clock, no crypto
        │  ReviewQualityReport
        ├──▶ GET /api/t/:slug/admin/agents/review-quality   (admin.agent_registry)
        ├──▶ /t/:slug/admin/agents/review-quality           (server component)
        └──▶ AGENT_REVIEW_BIAS_DETECTED audit row, deduped on a signal digest
```

### The one thing that decides how every number is read

`reviewedAt - createdAt` is **not review time**. It is queue latency *plus*
review time, because `createdAt` is when the agent proposed, not when the human
opened the row. So the distribution is informative from ONE end:

- the **lower** tail is a hard upper bound on diligence — a proposal decided
  four seconds after it was created was reviewed in at most four seconds, and
  no confound can flatter that;
- the **upper** tail measures **backlog** — a proposal decided nine days later
  says the queue was ignored, and nothing at all about how long anyone looked.

So the engine reports p50, p10 and the fastest decision, and deliberately emits
no p90 and no mean. Both would be real numbers, both would move on a dashboard,
and neither would answer a question anybody has.

### Estimates vs observations — the distinction the sample floor rests on

- An **observation** is a fact about something that happened: this reviewer's
  fastest decision was 3s; these five approvals landed inside 41s. One
  occurrence is enough.
- An **estimate** summarises a population: this reviewer approves 94% of what
  they see. Over four decisions that number can only be 0, 25, 50, 75 or 100 —
  it is the last click wearing a percent sign.

`MIN_REPORTABLE_SAMPLE = 10` gates estimates and nothing else. It is derived,
not picked: refuse a rate when one more decision would move it by more than ten
percentage points, i.e. `1/n > 0.10` ⟺ `n < 10`. The refusal is a **value** in
the returned shape — `{ reported: false, reason: 'INSUFFICIENT_SAMPLE',
observed, required }` — and the page prints "4 of 10 decisions needed" where the
percentage would sit. A metric that silently vanishes at n = 4 looks exactly
like a reviewer with nothing to answer for.

Bursts and implausibly-fast decisions are observations, so **no sample floor
gates them**. A reviewer whose entire history is one burst of six is the
clearest case this exists to surface, and a floor would be precisely what hid
them.

### The bulk-approval boundary

Five approvals by one reviewer inside sixty seconds, window inclusive at both
ends, runs maximal and non-overlapping. Five in a minute is twelve seconds each
including the page interactions, against a queue that renders the whole proposed
payload as JSON. Four is fifteen seconds each — fast, and not proof.

### What this cannot answer, said out loud

`UNOBSERVABLE_REVIEW_QUESTIONS = ['DIFF_EXPANSION']`, carried in the API
response and rendered above the numbers. "Was the content looked at before it
was approved" is **not observable today**, for three checkable reasons:
`AgentProposalsClient` renders the payload unconditionally in a `<pre>` (no
expand affordance, so no expansion event exists); nothing writes a view/open
audit action or automation event; and `AgentProposal` has no column to hold the
answer. `tests/guards/agent-proposal-review-observability.test.ts` asserts all
three against the live schema and source, so the declaration cannot outlive its
reason.

No proxy was invented, and the tempting ones are each worse than nothing:
time-to-decision is already reported on its own terms and does not become an
expansion signal by being renamed; payload size against latency would let a long
proposal launder a fast approval; and a client-side "seen" ping is a self-report
from the browser of the person being measured.

### The alert

One `AGENT_REVIEW_BIAS_DETECTED` audit row per outstanding finding, deduplicated
on a SHA-256 digest of the `(code, subject)` pairs over a 24-hour lookback. The
digest deliberately excludes `observed` and `sampleSize`: those tick up on every
new decision, so including them would make every read a "new" finding and the
dedupe would suppress nothing. A new subject crossing a threshold is a new pair
and does land.

Every field on the row is a code, an id or a count. It is also spelled as member
reads off one prepared object, so `local/no-raw-prompt-logging` resolves every
value position at the sink rather than counting it as a hole — measured: the new
usecase contributes one recognised sink and zero holes, so the guard's
`MEASURED_HOLES` / `KNOWN_UNANALYSABLE` need no edit and its holes-per-sink
ratio improves.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/automation-bias.ts` | The pure engine: thresholds, signal vocabulary, percentile, burst detection, per-reviewer / per-agent report, the unobservable declaration. No server imports. |
| `src/app-layer/usecases/agent-review-quality.ts` | The seam: reads decided proposals, resolves the pinned approval rung in two bounded queries, computes, and writes the deduplicated alert. |
| `src/app/api/t/[tenantSlug]/admin/agents/review-quality/route.ts` | `GET`, gated `admin.agent_registry` by the existing `admin/agents(/.*)?` subtree rule. `?days=` 1..365. |
| `src/app/t/[tenantSlug]/(app)/admin/agents/review-quality/page.tsx` | The admin surface. Prints the refusal where a rate would go, and the blind spot above the numbers. |
| `src/lib/nav/page-segregation.ts` | Classifies the new page as a SUBPAGE. |
| `messages/en.json`, `messages/bg.json` | The surface's copy, including the per-signal labels and the unobservable explanation. |
| `tests/guardrails/admin-route-coverage.test.ts` | Registers the new admin route. |
| `public/openapi.json` | Regenerated — the route walker publishes a stub for the new path. |

## Decisions

- **No new model, and that is the point.** Adding a `ReviewQualityMetric` table
  would have created a second copy of facts `AgentProposal` already holds, with
  a backfill, an RLS triple and a retention classification, all to answer a
  question a query answers. The measurement gap was never a storage gap.

- **`admin.agent_registry`, not a new permission key.** Deciding which agents
  may act and judging whether the human gate on what they propose is real are
  one authority. It also must not sit behind `admin.agent_tool_exposure`, which
  an operations team routinely holds — this surface names people. The existing
  subtree rule matches, so no `route-permissions.ts` edit was needed, exactly as
  for `admin/agents/:agentId/coverage`.

- **The rung is read from the pin.** `AgentPolicyCardVersion` is append-only so
  that "what did the policy say when this was proposed" stays answerable. Reading
  the agent's current card would reconstruct today's rules wearing an old version
  number — the failure that column's own docstring exists to prevent.

- **`SECOND_APPROVER_UNRECORDED` is a measurement, not an enforcement.**
  `AgentPolicyCardVersion.approvalRung` can declare `SECOND_APPROVER`, and
  `AgentProposal` carries exactly one `reviewedByUserId` — so every proposal
  under that rung is unevidenced by construction, and the metric counts them
  rather than pretending the declaration held. Enforcing two approvers is a
  schema change and a different piece of work; naming the gap is this one.

- **The alert is pull-based, and the note says so rather than hiding it.** It
  fires when the report is computed, i.e. when an admin opens the page or a
  client calls the endpoint. A tenant that never looks is never told. The honest
  fix is a scheduled pass, which is a background job with its own subsystem
  checklist; `computeAgentReviewQuality(ctx, { alert: true })` is the same seam
  either way, which is why the alert lives in the usecase rather than the route.

- **Nearest-rank percentiles, never interpolation.** Every value the engine
  returns is a latency that actually occurred. An interpolated p50 of 7.5s over
  the pair (5, 10) is a decision nobody made, and the first question an admin
  asks a finding is "show me the one".

- **Bursts are maximal and non-overlapping.** Six approvals in forty seconds is
  one burst of six, not two overlapping fives, and no approval is counted into
  two bursts — an admin reading "3 bursts" needs that to mean three occasions.

- **Signals are sorted before they leave.** The alert dedupe hashes them, and an
  order that depended on which reviewer's rows happened to arrive first would
  make every read look like a new finding.
