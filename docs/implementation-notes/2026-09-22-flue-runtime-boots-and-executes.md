# 2026-09-22 — The Flue loop executes in-process, and what that cost to learn

**Commit:** `<sha>` feat(agentic): the Flue runtime start plan, with its three defaults corrected

First time an agent loop has actually run in this repo. The audit's standing
criticism of this workstream was that points 1–5 were "unexercised scaffolding
rather than a working seam"; this is the measurement that ends that, and it
also finds the one thing standing between here and a driver.

## It runs, embedded, with no second service

`start()` from `@flue/runtime/node` boots the runtime in-process — its own
docstring: *"mirroring what a generated Flue server entry does at boot …
without any HTTP surface."* So the driver can live inside the request or job
that owns the run. No second deploy unit, no second thing to kill-switch.

Measured end to end against `fauxProvider`, with the model scripted to call a
tool and then answer:

```
REPLY   : "There are 42 controls."
toolRan : 1  args: {"framework":"ISO27001"}
calls   : 2
usage   : null
```

The tool received the arguments the model chose. That is the loop the plan is
adopting Flue for, running against this repo's `useTool` shape.

## Four constraints the API imposes, three of them defaults that are wrong here

**Agent functions must be SYNCHRONOUS.** The runtime refuses an `async` agent
outright — *"Move async work into tools, actions, or resource factories."*
Found by writing one, because nothing in the type signature says so. A driver's
agent function therefore does no I/O; everything it needs is resolved before
dispatch or inside a tool.

**`providers` omitted registers EVERY pi built-in.** *"Omitted registers every
pi built-in; an empty array registers none."* Every built-in means every vendor
pi ships an adapter for, each resolving its own ambient credential. With
`aiResidency: LOCAL_ONLY` a hard invariant, that is an egress surface created by
omission. The list must always be explicit — which is what
`runtime-bootstrap.ts` exists to guarantee.

**`db` defaults to in-memory, and that is the answer we want.** Unusually the
default is the safe one and the temptation is to override it. `@flue/postgres`
is refused by the plan because a second persistence path bypasses RLS, the
encryption manifest and the audit chain; `sqlite('./file.db')` is the same
objection in a smaller package. `WorkflowRun` is the system of record, and
losing the runtime's conversation cache on restart is correct — a resumed run
rebuilds from the sealed context chain, which is the thing that is governed.

**`agents` is fixed at start.** The runtime serves what it was started with and
`start()` throws if the process already has a runtime. So a run cannot assemble
its own agent; per-run variation travels as dispatch data. That is the safer
shape anyway: an agent function that cannot be built per request cannot have
its tool set widened per request.

## The blocker, and why it is not worth hacking past

**Jest cannot load `@flue/runtime`.** It is ESM-only with no `require`
condition, so jest's CJS resolver fails with "Cannot find module" — a
RESOLUTION failure, not a transform one, so the existing
`ESM_TRANSFORM_ALLOW_LIST` does not address it. `require.resolve` also fails
(`ERR_PACKAGE_PATH_NOT_EXPORTED`), which rules out the `moduleNameMapper` +
`require.resolve` pattern this config already uses for `react-grid-layout`.

So the driver's proving run cannot be an ordinary jest test today. The options
— an ESM jest project, a resolver, or a CI script outside jest — all change
module resolution or the CI job graph for **2040 test files**, which is a
shared-state change of exactly the kind that has broken this repo before. It
deserves its own diff and its own reviewer, not a footnote in a driver PR.

Until it is answered: the driver's decidable parts stay pure and unit-tested
(`model-selection.ts`, `runtime-bootstrap.ts`), and the loop itself is
evidenced by the transcript above rather than by a green test. Saying which is
which is the point.

## What this does NOT do

No driver, no `DRIVERS` entry, `DRIVER_IMPLEMENTED.flue` still false. Nothing
calls `start()` in `src/` — this note's subject is what a caller must satisfy
when one does.
