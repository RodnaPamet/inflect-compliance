# 2026-09-23 — Flue run state lives in memory, and that is a ratified deviation

**Commit:** `<sha>` docs: record the ratified deviation on Flue session state

## What the plan asked for, and what shipped

The integration plan describes per-run agent state as something the product
holds. What shipped holds it in a **per-process in-memory map**
(`src/lib/agentic/flue/run-binding.ts`), keyed by run id, with
`takeRunBinding` removing the entry when the run claims it.

**The repo owner ratified this on 2026-09-22**, with the condition that
`WorkflowRun` remains the system of record. This note exists because that was a
decision rather than an oversight, and a decision nobody wrote down reads as an
oversight six months later — at which point the obvious "fix" is to persist the
binding, which would be a regression.

## Why the deviation is forced, not chosen

`run-binding.ts`'s own docstring carries the full argument and is the place to
read it. In short, two runtime constraints meet:

- `start({ agents })` fixes the agent set at boot and throws if the process
  already has a runtime, so there is ONE agent function and a run cannot bring
  its own;
- agent functions must be **synchronous**, so the function cannot load the
  policy card or the tool manifest itself.

Everything a run's agent needs must therefore be resolved before dispatch and
readable synchronously during it. The runtime's own per-instance channel,
`useInitialData()`, is — in its own words — "part of the instance's durable
record stream" and "not a secrets channel". An `McpInvocation` is exactly what
must not go there: it carries the tenant, the principal, the permissions and
the API key id, plus closures that would not survive serialisation. So
`initialData` carries the run id, which the ledger already records, and the
invocation stays in this process addressed by it.

## What the deviation does and does not cost

**Does not cost:** the audit trail, the run ledger, the budget, or any
authorization decision. None of those live in the binding.
`WorkflowRun` + `WorkflowStep` are written through the single write seam and
are hash-chained; a binding holds only the *resolved tool list* and the model
specifier, both re-derivable from the run row and the register.

**Does cost:** a run cannot survive the process that started it. If the worker
restarts mid-run, the binding is gone and the run cannot be resumed — it settles
through the shared halt path like any other failure. That is acceptable because
a Flue run is short and because the alternative (persisting a capability) is
worse than the outage it prevents.

**Does cost, more quietly:** the binding is per-process, so a run is pinned to
the worker that dispatched it. Nothing today routes a run elsewhere mid-flight,
and if anything ever does, this is the constraint it will meet first.

## What would change the answer

A run that must survive a restart, or an agent set that must vary per run
without a process-wide `start()`. Either makes the in-memory binding
insufficient rather than merely unfashionable — and at that point the thing to
persist is the *inputs* that let the binding be rebuilt (run id, agent id,
resolved manifest version), never the `McpInvocation` itself.
