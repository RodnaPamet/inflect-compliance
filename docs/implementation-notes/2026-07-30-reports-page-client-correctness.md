# 2026-07-30 — Reports page: gating, run lifecycle, schedule edit

**Commit:** `<sha>` fix(reports): gate the write affordances, make the run lifecycle honest, surface what a schedule stores

Prompt 2 of the report-surface audit. Eight findings — but half of them had
already been partly or wholly fixed by an earlier pass, and the residuals were
the interesting part.

| Finding | Reality |
|---|---|
| R2.1 no permission gating at all | **Confirmed.** Zero `RequirePermission` on the page. |
| R2.2 all five mutations ignore `res.ok` | **Already fixed.** Every one checked and toasted. Residual: 3 of 5 had no *success* toast. |
| R2.3 run lifecycle invented and unpollable | **Confirmed.** |
| R2.4 schedule edit lies + under-shows | **Confirmed**, both halves. |
| R2.5 destructive convention | Delete already used `useToastWithUndo`. Residual: hand-painted danger styling, plus the SoA inversion. |
| R2.6 delivery-job starvation | **Already removed** by prompt 1. Residual: no ordering on the batch. |
| R2.7 form ergonomics | **Confirmed**, both halves. |
| R2.8 loading/error parity + busy scope | Templates list confirmed. Per-row generate busy already fixed; `SchedulesCard`'s was still shared. |

Verifying first was not ceremony: implementing R2.2 and R2.6 as written would
have meant rewriting code that was already correct, and re-introducing an
`if (!ctx) continue` branch that prompt 1 had just deleted.

## R2.1 — gating that matches what the server actually enforces

Every write on this page asserts server-side, and READER has
`reports: { view: true, export: false }`. The page rendered all eight write
buttons regardless, so a READER clicked, got a 403, and — before the earlier
fix added toasts — saw nothing at all.

The shape of the gate matters more than its presence:

- **`RequirePermission resource="reports" action="export"`** wraps every write:
  the three generate buttons, the new-template form, schedule create, and the
  edit/pause/delete row actions.
- **`UpgradeGate feature="PDF_EXPORTS"`** wraps PDF and PPTX **only**. CSV is
  deliberately outside it, because the server leaves CSV ungated (see the prompt-1
  note) — wrapping it would claim an entitlement the product does not sell, and
  the client would then be *stricter* than the API, which is the same class of
  lie as the original bug in the opposite direction.

This is only honest because #1759 landed the server-side `requireFeature` first.
A client gate over a free endpoint is decoration.

## R2.3 — the data was already on the wire

Two separate problems wearing one label.

**Unpollable.** Generation is fully synchronous inside the POST, so a run killed
by a serverless timeout is stranded in `GENERATING` with nothing to move it —
and there was no `refreshInterval` and no manual refresh. Fixed with SWR's
**function form** (`refreshInterval: (latest) => …`), which derives the interval
from the data, so polling stops on its own once every run settles. The first
attempt used `useState` + `useEffect`; lint correctly objected, and the objection
was right — the value is derivable, so it needed neither.

**Unexplained.** `errorMessage` was *already* stored by `generateReport` and
*already* returned by `listReports`. It was missing from the client `interface
Run` — so a red FAILED pill rendered with no cause and no way forward, and the
fix is three lines of type plus a span. The type was hiding data the server had
been sending all along.

The retry reuses `generate`, so entitlement and permission failures behave
identically to a first attempt; and the deep-dive scope comes from the failed
run's own `parametersJson`, not the row's current picker, so "retry" means retry.
That required threading an explicit scope override — `setDeepDiveRisk` followed
by `generate` in the same tick reads the *previous* state and silently generates
the wrong scope.

## R2.4 — a control that silently does nothing is worse than no control

`updateSchedule` patched `cadence` without recomputing `nextRunAt`, though
`computeNextRun` sits in the same file — so MONTHLY → WEEKLY left the row
rendering the old monthly date. Recomputed from **now**, not from the old
`nextRunAt`: the user has just re-declared how often they want this, and
anchoring to a date chosen under the previous cadence makes the first new run
arbitrary.

`startEdit` seeded only cadence and recipients, so `format` and the deep-dive
`riskId` were stored at creation and thereafter invisible — someone who scoped a
schedule to a single risk could not see what it was scoped to. Both are now
editable, which needed the PATCH schema and the usecase extended to accept them.

`deliveryDay` is shown **read-only**. `updateSchedule` does not accept it, and an
editable field that silently discards its value is a worse lie than an honest
read-only one.

## R2.5 / R2.7 / R2.8 — small, and one of them inverted a convention

`variant="destructive"` on the schedule delete instead of a ghost button
hand-painted with `text-content-error`: an inline colour override gets the text
but not the hover, focus ring or disabled treatment, so it read as destructive
only while idle.

The **SoA "Show gaps only" toggle used `variant="destructive"` as its active
state.** Nothing there deletes anything — it narrows a list. Using the danger
tone to mean "this filter is on" teaches the palette wrong, and a palette where
danger sometimes means "active" cannot warn. Now `primary`, plus the
`aria-pressed` it was missing.

Recipient parsing validates the same shape the server enforces, deliberately
permissively (`x@y.z`) — this is a typo-catcher standing in front of the real
check, not a second source of truth, and rejecting an address the server would
have accepted is the worse failure. The deep-dive scope picker moved **above**
the Create button: below an already-enabled Create, it was easy to never see, and
a deep-dive schedule created without a `riskId` silently runs portfolio-wide —
exactly what the comment beside `selectedIsDeepDive` says the field prevents.

## Decisions

- **A guard was updated, not weakened.** `report-schedule-gaps` pinned the exact
  literal `patch(id, { cadence: editCadence, recipients: emails })`, so *adding*
  a field broke it while the invariant held. It now asserts the fields
  individually — and gained three new assertions covering the gating, the
  polling and the surfaced schedule fields.

- **R2.6 needed almost nothing.** Prompt 1's synthetic principal removed the
  `if (!ctx) continue` that caused the starvation. What remained was the absence
  of any `orderBy` on the `take: 1000` batch, which made "which schedules run"
  whatever the planner returned. Now oldest-first, so the take is a fair queue.

- **Serial generation of up to 1000 schedules is left alone.** Parallelising PDF
  rendering risks memory exhaustion in a worker, and the ordering fix means a
  batch that runs out of time resumes from the most overdue rather than starving
  a fixed tail. Flagged rather than guessed at.
