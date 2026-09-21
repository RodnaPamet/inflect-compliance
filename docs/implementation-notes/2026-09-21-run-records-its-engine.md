# 2026-09-21 — A run records which engine walked it

**Commit:** `<sha>` feat(agentic): a run records which engine walked it

## The audit row named an engine it had not asked the executor about

`startWorkflowRun` resolved the driver, wrote it into the hash-chained trail
under a key whose comment reads *"Which engine walked this run"*, and then
called `executeFrom` **without it**. The parameter carried
`= STATIC_DRIVER`, so the executor took the default and `selectRunDriver` was
handed `static` no matter what the tenant was configured for.
`resumeWorkflowRun` resolved nothing at all and passed nothing.

Today every answer is `static`, so the entry is true by coincidence. The
coincidence ends the moment `DRIVER_IMPLEMENTED.flue` flips: the trail would
say `flue` for a run the static engine walked — in an append-only row, about
precisely the question an incident review opens it to ask. That is the failure
`selectRunDriver` was written to prevent, reintroduced one layer up.

## Three facts, because three parties have a say

A single value cannot explain an engine choice:

| key | what it answers |
|---|---|
| `driverRequested` | what the DEFINITION asked for |
| `driverAllowed` | what the DEPLOYMENT permits (env ∧ tenant ∧ implemented), with `driverReason` naming why when that is not what was configured |
| `driver` | what actually WALKED it — the intersection |

A definition cannot widen its own authority, so `driver` is never more than
either of the others.

This also makes the divergence **testable today**. `driverAllowed` cannot be
anything but `static` until a second driver exists, so a test watching only
that key would be pinning a constant. `driverRequested` is settable now — a
definition may ask for `flue` — so the suite registers one that does, and the
run records the request, the refusal and the engine that really ran.

## `WorkflowRun.driver`

NOT NULL with a default, unlike `agentId` and `policyCardVersion`, and the
difference is that this one can be backfilled **truthfully**. Those two use
NULL for "the question was not asked yet" because inventing a value for an old
row would put a fiction in the register. Every run that has ever executed was
static — `DRIVERS` maps only `static`, and `DRIVER_IMPLEMENTED.flue` has been
false for the whole life of the `AgentDriverMode` enum — so `STATIC` is a fact
about the existing rows rather than a placeholder standing in for one.

It records the engine at the run's START, the same deliberate narrowing
`policyCardVersion` documents. A resume re-resolves, so once a second driver
exists a run spanning an operator's toggle could walk its later segments on the
other engine; the resume's own audit entry is where that becomes visible, and
per-segment truth would belong on `WorkflowStep`.

## Decisions

### The parameter default is gone

`executeFrom`'s `permittedDriver` was `= STATIC_DRIVER`. A default is exactly
how a resolved, audited decision came to be dropped on the floor — both call
sites omitted the argument and the fallback made that look deliberate. It is
now required, so "forgot to pass the driver" is a build error. Proved by
deleting an argument: `TS2554: Expected 6 arguments, but got 5`.

No test could have caught that one. With `static` the only reachable value,
passing it and not passing it produce identical behaviour — the compiler is
the only mechanism that can hold this, which is why the fix is a signature and
not an assertion.

### A resume re-resolves rather than inheriting

A resume is a fresh authorization moment — it already re-resolves the
invocation and the policy card. An operator who switched the tenant off a
driver between the checkpoint and the approval meant it.

### The driver values are bound to locals, not called at the sink

`no-raw-prompt-logging` can read an identifier and cannot open a call, so
`requestedDriver(def)` spelled inside `detailsJson` added a new *kind* of blind
spot ("call to a helper this rule cannot open") rather than just a bigger
number. Hoisted, the four new fields are ordinary bound identifiers.

`MEASURED_HOLES` moves 150 → 154 and `MEASURED_SINKS` does not move, which is
the shape of a diff that adds fields to two already-swept calls rather than a
new call. The delta was measured per file rather than inferred from the total:
`workflow-runs.ts` holds 4 holes before and 8 after, with every other file
unchanged — so there is no inherited slack in the new number.
