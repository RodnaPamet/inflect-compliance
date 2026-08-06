# RQ3 — Risk Quantification Roadmap (Complete) <!-- docs-accuracy-allow: capstone/index of COMPLETED work; "Roadmap" is the wave codename, not a future promise -->

<!-- docs-accuracy-allow: status banner explaining the title is a shipped-wave codename -->
> **Status: authoritative** — capstone/index for the completed RQ3 wave (delivered 2026-06-11 → 2026-06-13). "Roadmap" in the title is the wave's codename; the cohort below is shipped.

**Status:** delivered 2026-06-11 → 2026-06-13.
**Author:** Claude (autonomous mandate).
**Scope:** all 10 RQ3 PRs (#1023–#1032) plus the six OB-* polish points
(#1033–#1038) and this capstone (#1039).

This document is the architecture record for the RQ3 wave. It exists
to make the cohort discoverable from one URL: every PR, every
implementation note, every ratchet, every architectural decision.

---

## The thesis

The risk register before RQ3 spoke two languages — qualitative bands
(L × I, 1–5 each) and quantitative loss (SLE × ARO, FAIR). They sat
side-by-side without conversation. The qualitative side flattered the
math (a sum of mean ALEs looked like a forecast), the quantitative side
hid behind the qualitative chrome (no exec ever saw the loss
distribution). Sensors fired but updated nothing; controls accumulated
without anyone asking what a € of mitigation bought. Beautiful surfaces,
silent decisions.

RQ3 closes the gap. Every analytical view now leads with the loss
distribution; every signal updates a downstream conclusion; every
control carries a price that can be compared against the value it
protects; every board pack starts from a position that's a number, not
a colour.

---

## The shape

```text
┌─────────────────────────────────────────────────────────────────┐
│  POSITION                  RQ3-1, RQ3-3, RQ3-9, RQ3-10          │
│  the loss distribution     simulated LEC; orchestrator;          │
│  takes the stage           board view                            │
├─────────────────────────────────────────────────────────────────┤
│  LANGUAGE                  RQ3-2, RQ3-4, RQ3-OB-A                │
│  range-first, tail-aware   PERT triples; "bad year" register;    │
│  one voice                 tenant currency, dates, pluralization │
├─────────────────────────────────────────────────────────────────┤
│  VIEWS                     RQ3-5, RQ3-6                          │
│  honest visualisation      histograms beside heatmaps;           │
│                            loss-event register                   │
├─────────────────────────────────────────────────────────────────┤
│  LOOPS                     RQ3-7, RQ3-8                          │
│  sensors update beliefs    KRI ⇄ assessment; mitigation ROI      │
├─────────────────────────────────────────────────────────────────┤
│  POLISH                    OB-B / OB-C / OB-D / OB-E / OB-F      │
│  respect the user          skeletons, deep-links, closed loops,  │
│                            a11y, unified first-run               │
└─────────────────────────────────────────────────────────────────┘
```

---

## The cohort

| # | Slug | PR | Implementation note | Ratchet | Closes |
|---|------|----|---------------------|---------|--------|
| 1 | RQ3-OB-A — one voice | (pre-cohort) | [`2026-06-11-rq3-ob-a-one-voice.md`](implementation-notes/2026-06-11-rq3-ob-a-one-voice.md) | `tests/guards/rq3-ob-a-one-voice.test.ts` | #1033 |
| 2 | RQ3-1 — simulated LEC | merged | [`2026-06-12-rq3-1-simulated-lec.md`](implementation-notes/2026-06-12-rq3-1-simulated-lec.md) | `tests/guards/rq3-1-simulated-lec.test.ts` | #1023 |
| 3 | RQ3-2 — range-first | merged | [`2026-06-12-rq3-2-range-first.md`](implementation-notes/2026-06-12-rq3-2-range-first.md) | `tests/guards/rq3-2-range-first.test.ts` | #1024 |
| 4 | RQ3-3 — portfolio honesty | merged | [`2026-06-12-rq3-3-portfolio-honesty.md`](implementation-notes/2026-06-12-rq3-3-portfolio-honesty.md) | `tests/guards/rq3-3-portfolio-honesty.test.ts` | #1025 |
| 5 | RQ3-4 — tail-aware language | merged | [`2026-06-12-rq3-4-tail-language.md`](implementation-notes/2026-06-12-rq3-4-tail-language.md) | `tests/guards/rq3-4-tail-language.test.ts` | #1026 |
| 6 | RQ3-5 — histograms beside heatmaps | merged | [`2026-06-12-rq3-5-histograms.md`](implementation-notes/2026-06-12-rq3-5-histograms.md) | `tests/guards/rq3-5-histograms.test.ts` | #1027 |
| 7 | RQ3-6 — loss-event register | #1046 | [`2026-06-12-rq3-6-loss-event-register.md`](implementation-notes/2026-06-12-rq3-6-loss-event-register.md) | `tests/guards/rq3-6-loss-event-register.test.ts` | #1028 |
| 8 | RQ3-7 — KRI ⇄ staleness loop | #1049 | [`2026-06-12-rq3-7-kri-staleness-loop.md`](implementation-notes/2026-06-12-rq3-7-kri-staleness-loop.md) | `tests/guards/rq3-7-kri-staleness-loop.test.ts` | #1029 |
| 9 | RQ3-8 — Mitigation ROI | #1050 | [`2026-06-12-rq3-8-mitigation-roi.md`](implementation-notes/2026-06-12-rq3-8-mitigation-roi.md) | `tests/guards/rq3-8-mitigation-roi.test.ts` | #1030 |
| 10 | RQ3-9 — Dashboard orchestrator | #1051 | [`2026-06-12-rq3-9-dashboard-orchestrator.md`](implementation-notes/2026-06-12-rq3-9-dashboard-orchestrator.md) | `tests/guards/rq3-9-dashboard-orchestrator.test.ts` | #1031 |
| 11 | RQ3-10 — Risk Board page | #1052 | [`2026-06-13-rq3-10-board-page.md`](implementation-notes/2026-06-13-rq3-10-board-page.md) | `tests/guards/rq3-10-board-page.test.ts` | #1032 |
| 12 | RQ3-OB-B — polish | #1054 | [`2026-06-13-rq3-ob-b-polish.md`](implementation-notes/2026-06-13-rq3-ob-b-polish.md) | `tests/guards/rq3-ob-b-polish.test.ts` | #1034 |
| 13 | RQ3-OB-C — tab deep-links | #1053 | [`2026-06-13-rq3-ob-c-tab-deep-links.md`](implementation-notes/2026-06-13-rq3-ob-c-tab-deep-links.md) | `tests/guards/rq3-ob-c-tab-deep-links.test.ts` | #1035 |
| 14 | RQ3-OB-D — closed loops | #1055 | [`2026-06-13-rq3-ob-d-closed-loops.md`](implementation-notes/2026-06-13-rq3-ob-d-closed-loops.md) | `tests/guards/rq3-ob-d-closed-loops.test.ts` | #1036 |
| 15 | RQ3-OB-E — a11y | #1056 | [`2026-06-13-rq3-ob-e-a11y.md`](implementation-notes/2026-06-13-rq3-ob-e-a11y.md) | `tests/guards/rq3-ob-e-a11y.test.ts` | #1037 |
| 16 | RQ3-OB-F — unified first-run empty | #1057 | [`2026-06-13-rq3-ob-f-first-run.md`](implementation-notes/2026-06-13-rq3-ob-f-first-run.md) | `tests/guards/rq3-ob-f-first-run.test.ts` | #1038 |

---

## The load-bearing decisions

These are the choices a reader needs to understand the codebase
post-RQ3. Each links to the implementation note where the rationale
lives.

- **The loss-exceedance curve is simulated, not ranked.** Pre-RQ3 the
  dashboard's "LEC" was a coverage statement wearing a probability
  chart's clothes. RQ3-1 demoted it; the only LEC on any surface is the
  Monte Carlo run. (RQ3-1, RQ3-3.)
- **Sum-of-means is the subordinate line.** The dashboard headline is
  `portfolioP80`. The Σ of mean ALEs survives only as a tooltip-flagged
  subordinate line that says "this isn't a forecast". (RQ3-3.)
- **`getStatusTone(score, 'score-0-25')` is dead.** Heatmap tone reads
  the tenant's CANONICAL matrix-config bands via `resolveBandForScore`.
  A second source of truth for risk-score colouring was drift waiting
  to happen. (RQ3-9.)
- **One orchestrator per page.** The risk dashboard collapsed six
  `useEffect` waterfalls into one `useTenantSWR('/risks/dashboard')`.
  Per-slot failure-soft is preserved; matrix is fatal-on-throw (the
  heatmap can't render bandless). The board page (RQ3-10) consumes the
  same orchestrator. (RQ3-9, RQ3-10.)
- **Sensors update beliefs.** RQ-6's KRIs were wired to nothing. RQ3-7
  added `SIGNAL_MOVED` to the staleness detector: a KRI breach NEWER
  than the last assessment marks the risk stale. Un-breaching is silent
  (no-noise contract). The KRI page deep-links a breached, risk-linked
  reading directly to the assessment tab. (RQ3-7.)
- **Mitigation ROI has an honest-null contract.** `Control.annualCost`
  + a pure ROI module produce a tagged-union verdict (`ok: true, value`
  | `ok: false, reason: NO_COST | NO_EFFECTIVENESS | NO_QUANT_RISKS`).
  No fabricated zero ever lands on a board pack. (RQ3-8.)
- **The board page is the dashboard's stripped sibling.** Five
  questions: position, appetite, top contributors, best-value controls,
  hygiene. Same data source, same failure-soft semantics, board-altitude
  framing. (RQ3-10.)
- **Server composes the toast.** The accept-suggestion flow recomputes
  the residual server-side AND composes a one-liner from those
  recomputed values, returned as `accepted.summary`. The toast reads
  the response, never client draft state. (RQ3-OB-D.)
- **The bridge knows where you've been.** "Quantify this risk →" adapts
  to "Review the FAIR analysis →" when `fairAle` already exists. Same
  callback, different framing. (RQ3-OB-D.)
- **Grid promise honoured.** `role="grid"` contracts arrow-key nav;
  RiskMatrix now delivers it with roving tabindex + clamped Arrow /
  Home / End. Reduced-motion is respected on the cell's literal
  `duration-150`. The residual-baseline warning announces itself via
  `role="status"` + `aria-live="polite"`. (RQ3-OB-E.)
- **One first-run nudge.** `<RiskFirstRunEmpty>` is the canonical empty
  shape; the risks list, dashboard, and board all converge on it. The
  CTA deep-links to `/risks?create=1` (auto-opens the modal) or accepts
  an `onCreateClick` escape hatch for the page that mounts the modal
  locally. (RQ3-OB-F.)

---

## How to extend this

When you add a new risk-quantification surface:

1. **Read the dashboard.** RQ3-9 made the orchestrator the canonical
   data source. New widgets should consume a slot of the existing
   `DashboardPayload`, not fire a new fetch. If the slot you need
   doesn't exist, extend the orchestrator (in one place, in one PR).
2. **Honest-null or don't ship.** Every numeric surface on a tenant
   with empty inputs MUST render a typed "not enough data yet" copy
   (see RQ3-8's `describeRoiGap`, RQ3-10's per-card empty states).
   A fabricated zero is the bug RQ3 exists to prevent.
3. **Test the behaviour, not the diff.** Cover the new contract with a
   test that would fail if the contract broke — a rendered test, a
   usecase test, a round trip. Reach for a `tests/guards/` source-text
   ratchet only for an invariant no runtime test can express, and read
   [the epic-ratchet lifecycle](../CLAUDE.md#epic-ratchet-lifecycle)
   first: a ratchet that pins one PR's diff fires on refactors and
   nothing else.
4. **Write the implementation note.** `docs/implementation-notes/`
   gets a new `YYYY-MM-DD-<slug>.md` per substantive PR; this capstone
   table indexes them.

---

## Per-PR ratchet coverage

The cohort shipped one `tests/guards/rq3-*.test.ts` ratchet per
implementation note, mirroring the slug — `rq3-9-dashboard-orchestrator.test.ts`
guards the contract that `2026-06-12-rq3-9-dashboard-orchestrator.md`
describes.

**That convention is retired** — see
[the epic-ratchet lifecycle](../CLAUDE.md#epic-ratchet-lifecycle). Each
of these files pins the shape of one PR's diff, so by construction it
fires on refactors rather than on regressions, and several assert UI
prose and loop-variable names. They are being retired in tranches as
their intent is re-expressed behaviourally; the surviving ones are the
assertions no runtime test can make.

The underlying simulation infrastructure carries its own pre-cohort
ratchet at `tests/guards/rq3-monte-carlo.test.ts` (RQ-3 epic; the
Monte Carlo loop the RQ3 cohort builds on). RQ3-1 onward read its
output; the cohort's PRs don't modify the engine itself.

---

## What this isn't

- **Not a tutorial.** This file links the architecture record; it does
  NOT teach the FAIR taxonomy or the Monte Carlo loop. For that read
  [`docs/risk-quantification.md`](risk-quantification.md) (the epic-
  level architecture record that pre-dates the RQ3 cohort).
- **Not the test plan.** Per-PR test coverage lives in the individual
  implementation notes.
- **Not the release history.** `CHANGELOG` + the merged-PR list on
  GitHub are the canonical timeline. This file groups the cohort
  thematically.

---

<!-- docs-accuracy-allow: guidance for future RQ4/RQ5 waves to mirror this completed cohort's shape -->
*Generated as part of RQ3-11 (the capstone PR). Subsequent
risk-quantification waves (RQ4, RQ5, …) should keep the parts that
earned their keep — one implementation note per substantive PR, one
capstone synthesis at the end — and drop the one that didn't: a
structural ratchet per note. See
[the epic-ratchet lifecycle](../CLAUDE.md#epic-ratchet-lifecycle).*
