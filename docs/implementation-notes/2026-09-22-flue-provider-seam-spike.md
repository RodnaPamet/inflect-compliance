# 2026-09-22 — The Flue provider seam is not safe per-run, and the safe shape

**Commit:** `<sha>` feat(agentic): choose a Flue model by residency, never a provider per run

The spike the integration plan's point 4 discussion asked for: *"provider
wrapper as a proven spike."* This is the proof, and the answer changes the
driver's design.

## The obvious integration is unsafe here

`@flue/runtime/internal` exposes `setProvider(provider)`, and its own docstring
invites the per-run shape: build a provider from the tenant's settings and
register it as the run starts.

The installed package holds its providers in a **module-scoped singleton**:

```js
let models = createModels();                 // dist/providers-*.mjs, module scope
function setProvider(provider) { models.setProvider(provider); }
```

So every call mutates one process-wide registry. Two concurrent runs in one
Node process race, and the loser executes against the winner's provider.

In this product that is not a performance bug. `Tenant.aiResidency = LOCAL_ONLY`
is documented in `ai/risk-assessment/index.ts` as *"a HARD invariant: the
factory MUST select a local provider"*. A lost race streams a LOCAL_ONLY
tenant's reasoning to an endpoint some other tenant registered a millisecond
earlier — an external egress with nothing on the run to show it.

## The safe shape, and why it exists

pi-ai's own contract is that *"providers own stream behaviour; `Models`
resolves auth and delegates each request **to the provider that owns the
model**"*, and `resolveModel` resolves a `"<provider-id>/<model-id>"` specifier
against the registered set. `useModel` takes exactly that string.

So the per-run decision moves **off the registry and onto the ask**:

| | |
|---|---|
| unsafe | one provider id, re-registered per run from tenant settings |
| safe | two provider ids registered once at init; the run picks a **model specifier** |

The registry never mutates after init, so there is no race to lose. This PR
adds the chooser (`resolveFlueModel`) and a guard that keeps the unsafe shape
out — `setProvider` has zero call sites in `src/` today, which is exactly when
that invariant is cheap to pin.

## It REFUSES where the risk-assessment factory falls back

`ai/risk-assessment/index.ts` degrades an unconfigured tenant to a
deterministic stub. Correct there: a knowledge-base template is a real answer.

A reasoning loop has no substitute. A stub-backed "agent run" would emit steps,
charge tokens and queue proposals that nothing reasoned about — worse than not
running, because the ledger would say it did. So an unconfigured run is refused
with one of three named, operator-actionable reasons rather than downgraded.

## Two things this note exists to stop the next author doing

- **Do not call `setProvider` per run.** The guard says so, and the reason is
  above rather than in a commit message nobody will find.
- **Do not read the residency after an external branch.** The LOCAL_ONLY
  short-circuit is first, the placement `getProvider` already uses: an
  invariant enforced after an external path has been evaluated is an invariant
  that depends on the order of a switch.

## What this does NOT do

It registers no providers and makes no model call. It decides *what a run may
ask for*; the driver that asks does not exist yet, and `DRIVER_IMPLEMENTED.flue`
stays false.
