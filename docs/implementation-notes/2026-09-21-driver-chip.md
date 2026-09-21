# 2026-09-21 — The driver chip: which engine ran this

**Commit:** `<sha>` feat(agents): show which engine a run used, and which one an agent would use

Phase 1, point 1's frontend bullet: *"A driver chip on the Overview tab at
`/agents/[agentId]` and on run rows at `/agents/runs`."*

## Why this could not be built until now

`WorkflowRun.driver` landed hours earlier. Before that the only driver values
available to a UI were the tenant's *configuration* and the definition's
*request* — and rendering either as "the engine that ran this" is the exact
false claim `selectRunDriver` was written to prevent. A chip reading
configuration would relabel finished runs every time an operator flipped a
switch.

So the run list reads the column off the row and never re-resolves.

## Two surfaces, two different questions

|  | question | source |
|---|---|---|
| `/agents/runs` row | which engine **walked this run** | `WorkflowRun.driver`, recorded at the run's start |
| `/agents/[agentId]` Overview | which engine **this agent's runs would use** | `resolveDriverForTenant`, resolved live |

They are deliberately not the same value. A finished run keeps the engine it
had; the agent's Overview answers what would happen if you started one now.

## Decisions

### The chip renders for STATIC too

Rendering only for `FLUE` is cheaper and looks correct while one engine exists.
It also makes *"this run used the static engine"* and *"this row predates the
column"* indistinguishable — the single distinction the chip is for. The test
that would fail a render-only-when-interesting implementation is the first one
in the file, and it is named for that.

Neither variant is a health colour: `neutral` for static, `info` for flue. The
engine is not good or bad news.

### The Overview chip carries the REASON

`driverReason: null` means the configured driver *is* in force. Every other
value names the term that narrowed it. Showing the engine without the reason
tells an operator who has switched Flue on that they are running static, and
not *that this build has no Flue driver* — which is the only actionable half of
that sentence.

### The decision rides on the agent read, not a new endpoint

`getRegisteredAgent` already folds in `registrationEnforced`, a tenant-level
governance fact resolved in parallel with the row. The driver decision is the
same shape and joins the same `Promise.all`.

This matters because `tabs/types.ts` is a declared **single-writer seam** — "a
lane that finds it needs more should say so rather than add it" — and each tab
owns its own fetch. Threading a prop would have widened the one file six lanes
share; a second endpoint would have been a round trip for one enum.

## What is NOT here

The run **timeline** does not yet show tool name, scope, guard verdict or the
`MODEL_CALL` / `TOOL_CALL` affordances. Those are points 2, 4 and 5's frontend
bullets, and they describe a per-step surface that does not exist yet — the run
list renders rows, not steps.
