# 2026-09-21 — Extracting the static run driver

**Commit:** `<sha>` refactor(agentic): extract the static run driver, with no behaviour change

Phase 1, point 1: *"Add `driver: 'static' | 'flue'` to `WorkflowDefinition`;
default static. Extract today's inline execution into `static-driver.ts` with
no behaviour change."*

This is the seam every other Phase 1 point hangs off. It adds no capability and
changes no behaviour — that is the whole requirement.

## Design

    workflow-runs.ts   start / resume / abort / get / list  +  executeFrom (dispatch)
    drivers/index.ts   selectRunDriver — definition's request ∩ what is permitted
    drivers/static-driver.ts   the step walk, moved verbatim
    drivers/run-store.ts       getRunRow — the one helper both halves need
    drivers/types.ts           the RunDriver contract

`workflow-runs.ts` went from **1226 lines to 474**. Seventeen declarations moved.

## What made the move safe to do mechanically

The dependency analysis, run before touching anything, with comments masked so
prose mentions did not count as calls:

- `executeSteps` transitively needs **16 local declarations**;
- **15 move cleanly** — nothing outside the walk calls them;
- exactly **one** is shared: `getRunRow`, read by `abortWorkflowRun` and by
  `loadRunAndDef` on the resume path.

A first pass without comment-masking reported seven shared helpers and
`startWorkflowRun` itself inside the closure — an inflated answer that would
have justified a much larger and riskier refactor. Masking first is what made
the real boundary visible.

## Decisions

### The moved code is byte-identical, and that is asserted

Every declaration was moved verbatim; a check compares each moved body against
the original file and confirms all **17 are byte-identical**, and that none
remain behind. "No behaviour change" is a claim worth being able to verify
rather than assert, and for a 750-line move it is the only claim that matters.

`runStaticDriver` is an alias of the moved `executeSteps` rather than a rename,
so the identity check compares like with like instead of against a diff that is
purely cosmetic.

### `getRunRow` gets its own module

It is the only helper shared across the seam. Leaving it in the usecase would
make the driver import from `app-layer`; moving it into the driver would make a
usecase read its own run row from a driver. One inverts the layering, the other
is merely confusing. A four-line `run-store.ts` is neither.

### The driver lives in `src/lib`, and the layering holds

The moved block's only `app-layer` dependency is the `RequestContext` **type**.
Four `src/lib/agentic/` modules already import it the same way, so this is
established practice rather than a new inversion. Everything else it needs was
already `@/lib/*`.

### A definition REQUESTS a driver; it cannot grant one

`WorkflowDefinition.driver` is optional and defaults to `static`.
`selectRunDriver` intersects it with what `resolveAgentDriver` permits — the
operator's env switch AND the tenant toggle AND `DRIVER_IMPLEMENTED` — and any
disagreement resolves to `static`. A workflow definition is configuration, so it
must not be able to widen its own authority.

`DRIVERS` maps only `static`. `flue` is absent rather than mapped to a stub,
which makes "only one driver exists" a compile-time fact instead of a runtime
surprise. `selectRunDriver` also reports the driver it actually chose, not the
one that was asked for, so an audit row cannot claim `flue` for a run the static
engine executed.

## Four guards this move owed, and what each taught

**`agentic-engine-coverage`** read `workflow-runs.ts` as "the engine" and
asserted things that had moved. Each assertion is now pointed at the half that
owns it — execution at the driver, lifecycle at the usecase — rather than at a
concatenation of both, which would let an assertion pass because the *other*
file satisfied it. The no-direct-writes invariant is checked against **both**,
since checking only the usecase after the walk moved out would have left the
half that actually runs tools unguarded.

It also carried a latent trap: `engine.slice(engine.indexOf('async function
recordStep'))`. When `recordStep` moved, `indexOf` returned `-1` and the slice
silently became the file's **last character** — every assertion under it then
ran against one byte. Replaced with `functionBodyOf`, which throws on a missing
name, because that is what it is.

**`schema-index-coverage`** reported `WorkflowStep` as a *stale* Layer C entry
and invited its deletion. It was not stale: the `findMany` moved into
`src/lib/agentic/drivers/`, which the guard does not scan. Deleting the entry
would have dropped index triage for a query that still runs. The scan now
follows the queries — a guard whose population silently shrinks when code moves
is the failure this repo keeps finding.

**`no-raw-prompt-logging`** needed the driver registered as a new
file-and-kind pair. Sink and hole counts are unchanged at 87 / 150: the code
moved *within* the same scanned population, which is what those numbers should
show.

**`assertion-needle-uniqueness-ratchet`** went +1 un-analysable, then −1. The
duplicated `expect(driver).not.toMatch(entityMutators)` has a variable needle,
so each such site is a blind spot the ratchet counts. Collapsing both halves
into one looped assertion net-removed a site, and the drift sentinel then
required `UNANALYSABLE_READ_BASELINE` to come down 1454 → **1453** in the same
diff — which is correct: a baseline above the live count is headroom a future
regression can spend on a green build.

## What this does not do

It does not add the `flue` driver, flip `DRIVER_IMPLEMENTED`, or change what any
run does. The seam exists; nothing new goes through it yet.
