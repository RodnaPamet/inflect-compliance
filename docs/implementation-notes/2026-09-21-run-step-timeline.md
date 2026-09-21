# 2026-09-21 — The run step timeline

**Commit:** `<sha>` feat(agents): the run's step ledger gets a surface

## A ledger nobody could open

`getWorkflowRun` has returned the run **with its ordered steps** since the
engine shipped, and `GET /api/t/:slug/agent-runs/:id` has served them — its
docstring calls the result "a single run with its ordered step timeline".
Nothing read it. Every step the engine recorded was reachable by curl and by
nothing else.

So the expensive half — authorization, RLS scoping, ordering, decryption — was
already done. What was missing was a page.

## What the recon changed about the plan

Four plan bullets say "per step on the run timeline". Auditing the data first
found that **three of them have nothing to render**:

| Bullet | Reality |
|---|---|
| guard-verdict chip per step | `guardVerdict` / `guardRuleIds` / `guardInputDigest` are **`AgentProposal`** columns. There is no per-step verdict, and `AiDecisionLog` carries no `runId`/`stepSeq`/`proposalId` — it joins only by digest, and has no tenant-facing surface to link to. |
| `MODEL_CALL` / `TOOL_CALL` affordances | Neither kind is ever written. `recordStep`'s `kind` parameter is typed to the other four, and `DRIVER_IMPLEMENTED.flue` is false. |
| model calls show token cost | `WorkflowStep` has **no token column**. `costTokens` is a run-level accumulator. |
| run ↔ proposal backlink | `AgentProposal.runId` / `stepSeq` exist and **nothing writes them** — every production row is NULL both ways. |

This PR builds the surface and the two things that *do* have data behind them,
and deliberately builds none of the four above. Shipping a chip that renders
for zero rows is indistinguishable, to a reader, from a chip that is broken.

## Decisions

### Server-fetched, and an explicit projection

The sibling list page fetches on the client because it mutates. This page only
reads, so fetching in the server component deletes the loading branch, the
error branch, and the effect that would own them.

The projection is explicit because `getWorkflowRun` returns the whole row, and
the whole row includes `contextJson` — which the usecase hands back
**decrypted**. That is not something to put on the wire.

### The tool name is derived, and that is the subtle part

The driver's failure path records a step with **no `toolCalled`**. So a READ or
PROPOSE that threw has a NULL tool, and a chip reading the column alone is blank
on exactly the steps an operator opened the page to inspect — while the
successful steps that need it least are the only ones that show it.

`resolveStepTool` prefers the recorded value (it is what actually ran) and falls
back to `def.steps[seq].tool` (the driver indexes the same array). It is its own
module with its own test because the asymmetry is invisible in the happy path.

### An ordered list, not a table

The rows are heterogeneous — a checkpoint has an actor and no tool, a synthesis
has output and neither — so a table would spend four columns being empty to keep
them aligned. It also keeps the entire table platform out of a surface that
needs none of it.

### Payloads are inert text behind a disclosure

Step payloads are decrypted, agent-authored tenant content. They go through
`{}` so React escapes them, into a `<pre>` that preserves shape, and are never
parsed or injected.

### Two shared budgets were at or near zero

`border-border-default` is capped at 111 with a live count of 111 — **zero
headroom**, shared with every open PR. This page uses `cardVariants` and
`border-border-subtle` and adds none.

The guard-file budget sits at 710 against a `< 725` cap. This PR adds no file
under `tests/guards/`; its tests are a unit test and a rendered test, and it
extends an existing guard rather than writing a new one.

## The seven registrations a new detail page owes

Found by asking, not by reddening CI: `AGENTIC_ROUTES` + an inbound link
(`/agents/runs/${`) from outside the route's own directory, `SUBPAGES`,
`canonical-parents`, `ADOPTED_PAGES` (the **client** file, per the
`access-reviews` precedent — `page.tsx` is then covered via `adoptedDirs`), a
sibling `loading.tsx`, `breadcrumbs`, and copy keys in **both** locales.

Two more surfaced from the derived test population rather than the recon:
`detail-page-metastrip-adoption` (a `meta` prop obliges `<MetaStrip>`) and the
`rq4-10` cohort sweep (every SUBPAGE mounts a back affordance —
`back={{ smart: true }}` counts).
