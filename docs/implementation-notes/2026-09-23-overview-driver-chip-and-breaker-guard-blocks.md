# 2026-09-23 — The Overview driver chip, and guard blocks on the breaker tab

**Commit:** `<sha>` fix(agents): make the Overview driver a chip, and show guard blocks on the breaker tab

Two phase-1 audit findings, both of the same species: a plan bullet whose
frontend half was reported as delivered while the surface it names could not
state the fact.

## Finding 1 — the Overview "driver chip" was not a chip

Plan point 01 asks for *"a driver chip on the Overview tab at `/agents/[agentId]`
AND on run rows at `/agents/runs`"*. The run-rows half shipped as a real
`<StatusBadge>` with `tests/rendered/agent-run-driver-chip.test.tsx` behind it.
The Overview half shipped as a `<Fact>` wrapping a bare `<span>` of translated
text — while eight sibling files under `agents/[agentId]/` already render enums
as badges, so the convention was available on that very page.

`OverviewTab` now renders the engine as a `<StatusBadge size="sm">` with the
same tone pairing the run rows use — `neutral` for static, `info` for flue,
neither a health colour. The reason stays beside it as quiet text, because the
reason is the actionable half: `driverReason: null` means the configured driver
is in force, and every other value names the term that narrowed it.

The tone map is per-surface rather than shared. `AgentRunsClient` keys on the
uppercase `WorkflowRun.driver` column (the engine that *walked a finished run*);
this keys on the lowercase decision `resolveDriverForTenant` returns (the engine
this agent's runs *would* use). Two spellings of one idea, deliberately not the
same value — see the 2026-09-21 note's table.

**Why nothing caught it.** `tests/rendered/agent-overview-tab.test.tsx` asserted
`getByText(OV.driverValue.static)`, which passes identically for a badge and for
plain text. The replacement asks the component for its own class contract
(`statusBadgeVariants({ variant, size })`) and checks the element holding the
label carries it, so reverting the chip to text reddens.

**The 2026-09-21 note.** `docs/implementation-notes/2026-09-21-driver-chip.md`
heads a section *"The Overview chip carries the REASON"*. That sentence
described a chip the code did not render, and it was true of the REASON only.
Implementation notes are historical and not edited, so the correction is
recorded here instead: the Overview chip existed as a claim from 2026-09-21 and
as a chip from this commit. Everything else in that note — including the
run-row decisions and the "not a new endpoint" rationale — was accurate.

## Finding 2 — "Flue blocks show up there for free" was wrong

Plan point 04 reads *"The Circuit breaker tab already exists at
`/agents/[agentId]` — Flue blocks show up there for free once wired."*

They did not, and the reason is structural rather than a missing wire. The tab
reads `getAgentCircuitBreaker`, which reads exactly two things: the
`AgentCircuitBreaker` row and `AgentBehaviourWindow` rows. A Flue guard block
writes **neither**:

* the guard fires in the tool sandwich, BEFORE the funnel, so the blocked call
  queues nothing and writes no `AgentProposal`;
* it never reaches `authorize.ts`, so `recordAuthorizedCall` never runs and no
  `AgentBehaviourWindow` row is written for it.

So both of the tab's evidence surfaces — the ledger strip and the baseline
figures — are blind to a block by construction. #2781 taught `latchOnGuardBlock`
to count `WorkflowStep` rows with `guardVerdict: 'QUARANTINED'` scoped through
`run: { agentId }`, but that count is transient: it decides whether to latch and
is then discarded. Below the threshold a blocked agent left no mark anywhere on
this surface; at or above it, the only mark was a trip whose signal rendered as
the raw enum `GUARD_BLOCK`, because `signalLabel` had no arm for the code its
own latch writes.

**What "show up there" means here.** The count that trips the breaker, reported
beside the threshold it is counted against — not a new ledger of block events.
Blocks are already durable as `WorkflowStep` rows with the verdict on them; what
the operator could not see was the figure the breaker is actually judging.

**The number is surfaced, not re-derived.** `countGuardBlocksInWindow` is
extracted from `latchOnGuardBlock` in `circuit-breaker-store.ts` and takes its
Prisma client as a parameter, so the detector calls it with the base client
(there is no tenant transaction at the MCP boundary) and
`getAgentCircuitBreaker` calls it with the RLS-scoped one. A second count
written in the usecase would have been a second definition of the population,
free to disagree with the one that actually stops the agent — and the number
that disagrees is the one the operator is reading. Dropping `stepBlocks` from
the sum reddens the detector's tests and the panel's together, which is the
evidence that it is one number rather than two that happen to agree.

The hour the count covers is deliberately NOT repeated on the block: the
payload already carries `currentWindowStart`, and the count is bounded by it.

**Rendered without the `breaker &&` gate**, unlike every other fact on the state
card. An agent whose every call the guard refused has no behaviour windows and
no breaker row at all (the row is created on the first AUTHORIZED call), so
gating the figure on the row would hide it from exactly the agent it is about.
Zero is shown rather than hidden for the same reason: a surface that prints the
figure only when it is non-zero is indistinguishable from one that cannot see
blocks.

## A gap this does NOT close

`latchOnGuardBlock` latches with `updateMany({ where: { state: 'CLOSED' } })`, so
an agent with no `AgentCircuitBreaker` row cannot be tripped by guard blocks at
all — the row is created by `openBreakerGate`, on the authorization path a
blocked Flue call never reaches. The count now makes that state visible (blocks
climbing past the threshold with the breaker still reading "never observed"),
but it does not change the latch. That is a behavioural decision about when a
breaker row should exist, not a display fix, and it is left for whoever takes
it deliberately.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/OverviewTab.tsx` | the driver `<Fact>` renders a `<StatusBadge>`; `DRIVER_VARIANT` tone map |
| `src/lib/agentic/circuit-breaker-store.ts` | `countGuardBlocksInWindow` extracted and exported; `latchOnGuardBlock` calls it |
| `src/app-layer/usecases/agent-circuit-breaker.ts` | the same count joins the payload as `guardBlocks { inWindow, threshold }` |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/CircuitBreakerTab.tsx` | renders the count ungated, and labels the `GUARD_BLOCK` signal |
| `messages/en.json`, `messages/bg.json` | four keys: the fact label, the `{count} of {threshold}` value, the explanation, the signal label |

## Decisions

* **The tone map is duplicated across the two driver surfaces, not shared.** The
  run row keys on `STATIC` / `FLUE`; the Overview keys on `static` / `flue`. One
  shared map would need a normalisation step whose only job is to hide that the
  two payloads are different facts.
* **The guard-block count is a `count`, not a page of block rows.** The panel's
  question is "how close is this agent to the latch", which is a number. A
  ledger of blocks would be a second, unbounded read for a surface that already
  has one.
* **The threshold travels on the payload**, like `windowsToTrip` beside it. A
  constant retyped in the client agrees with the latch by coincidence; the
  identity subsystem has already paid for that once.
* **The unit test refuses the Prisma singleton with a throwing mock** rather
  than stubbing it. Importing the store pulls the base client into the usecase's
  module graph, and a future edit that counted through it instead of the
  tenant-scoped client would read past RLS while every assertion still passed.
