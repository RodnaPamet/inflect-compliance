# 2026-09-04 — Powerpipe control summary: the real wire shape

**Issue:** #2301. Sits underneath #2284 (exit codes) and #2252 (auth trigger);
neither should land before this one.

## What was wrong

`aws-posture-provider.ts` declared a control's summary as
`{ status?: Record<string, number> }` and read `c.summary?.status` first. That
key does not exist on a control. The nesting is real, but it belongs to a
**result group**, not a control:

| object | Go type | JSON |
| --- | --- | --- |
| group | `controlexecute.GroupSummary` — `Status StatusSummary \`json:"status"\`` | `"summary": { "status": { … } }` |
| control | `controlstatus.StatusSummary` directly | `"summary": { "alarm":0,"ok":0,"info":0,"skip":0,"error":0 }` |

So the primary branch was dead against real output and every control fell
through to a row scan. An errored control has **no rows** — `setError` in
`control_run.go` does `Summary.Error++`, fills `RunErrorString` and moves
`RunStatus` to `"error"` without ever calling `addResultRow` — so its `results`
renders as `null`, the row scan found nothing, and the floor of the ladder was
`skip`. A benchmark whose controls had all failed on `InvalidClientTokenId`
therefore aggregated to `{ok:0, alarm:0, skip:N, error:0}`, and a run with no
alarms and no errors is a **PASS**.

## Establishing the shape

The output is not marshalled from the structs — it is rendered by a Go template,
so the template is the authority for key names and the struct tags for the shape
of each value. Read from `turbot/powerpipe` @ main on 2026-09-04:

- `internal/controldisplay/templates/json/output.tmpl` — applies the group
  sub-template to `.Data.Root`, so **the top-level object is itself a group**;
  there is no wrapper key. Emits `group_id, title, description, tags, summary,
  groups, controls` for a group and `summary, results, control_id, description,
  severity, tags, title, run_status, run_error` for a control. `controls` and
  `results` render `null` — not `[]` — when empty. `run_status` is a numeric map
  of `RunStatus` (`complete` → 4, `error` → 8).
- `internal/controlstatus/status_summary.go` — `StatusSummary` is flat with five
  counters, including **`info`**, which the old parser ignored entirely.
- `internal/controlexecute/result_group.go` — `GroupSummary.Status`, the nesting.
- `internal/controlexecute/control_run.go` — the `Summary` tag and `setError`.

The one thing that could not be established from source is whether any older
Powerpipe emitted the group form on a control. No evidence was found for it, so
no fallback was added; that shape now yields `unknown`, which fails loudly.

## Design

`aggregateStatus` asks three sources in order and each returns "no signal"
rather than guessing: flat counters, then rows, then the `run_error` /
`run_status` backstop. Only then does it decide between two floors, and keeping
them apart is the point of the change:

- a **well-formed but all-zero** counter block is a control that ran and matched
  nothing → `skip`, so an account with nothing in scope still passes;
- **nothing legible at all** → the new `unknown`, which joins `error` in the
  ERROR arm of both verdict ladders.

Collapsing those two is precisely what made the bug silent. `info` now counts as
passing, matching `StatusSummary.PassedCount() = Ok + Info`.

## Files

| file | role |
| --- | --- |
| `src/app-layer/integrations/aws-posture-provider.ts` | the parser; flat counters, the `unknown` status, the run-error backstop, the counts bucket, the verdict ladder |
| `src/app-layer/integrations/cloud-posture/powerpipe-core.ts` | the shared Azure/GCP ladder — same `unknown` arm |
| `tests/helpers/powerpipe-benchmark-fixture.ts` | the single source-cited fixture builder |
| `tests/fixtures/aws-posture-powerpipe-soc2.json` | the on-disk sample, reshaped |

## Decisions

- **The fixtures were the defect, not a missing test.** Six sites each built
  `summary: { status: { … } }` inline, so the suite validated the parser against
  its own assumption. All six now come from one builder that carries the upstream
  citation, because a shape written inline beside an assertion will drift back
  into agreeing with whatever the parser expects.
- **Reshaping the ordinary fixtures alone would not have caught it.** A healthy
  control has rows, and the row fallback returns the right answer whatever the
  summary looks like. The defect is only visible on a control with `results:
  null` — which is exactly the errored control. That fixture is what bites.
- **The group form is refused, not accepted as a fallback.** A permissive
  both-ways parser would make the bug undetectable again. Feeding a control the
  group shape now scores it `unknown` → ERROR.
- **Alarm still outranks error** at both the control and the benchmark level;
  that ordering was not part of the defect and both arms are non-passing.
- **The summary string now names error and unknown.** It read
  `0 ok / 0 alarm / 0 skip of 2` for a fully-failed run — every count that would
  have told an operator something was omitted from it.
