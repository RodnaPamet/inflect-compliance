# 2026-09-22 — The Flue driver executes a run

**Commit:** `<sha>` feat(agentic): execute a run on the Flue engine, under the same caps

Phase 1, points 1–5: the driver seam gets its second engine. `DRIVER_IMPLEMENTED.flue`
stays **false** — mapping a driver and enabling it are separate facts, and the flip
should be a diff that changes one line and nothing else.

## The shape the runtime forced

Four constraints, none negotiable, and together they decided the design:

| constraint | consequence |
|---|---|
| agent functions must be **synchronous** | everything a run's agent needs is resolved before dispatch and read synchronously during it |
| `agents` is fixed at `start()` | there is ONE agent function; per-run variation travels as dispatch data |
| `providers` omitted registers **every** pi built-in | the list is always explicit — omission would be an egress surface under `LOCAL_ONLY` |
| `@flue/runtime` and `pi-ai` are **ESM-only** | the execution half sits behind one dynamic import |

## The execution path

    driver.ts        resolve the tenant's residency → plan → refuse, or…
      └─ await import('./execute')          ← the ONE dynamic edge
           execute.ts   boot → check the specifier is registered → resolve the
                        invocation → compose the budget → wrap tools → bind →
                        dispatch → record → charge → settle

`runFlueDriver` reads `TenantSecuritySettings` itself rather than taking a
seventh argument, so it satisfies `RunDriver` exactly and `DRIVERS` stays a
plain map. A driver needing its own signature would make the map's value type
per-driver, and `selectRunDriver` could no longer return "a driver" at all.

## Decisions

### The caps are the same caps, charged where this engine can be charged

An agentic loop is precisely the thing run caps exist for: it decides for
itself how many tools to call and how long to keep going. So `execute.ts`
builds the SAME `createRunBudget` the static driver builds, seeded the same way
from what earlier segments spent (`actionsAlready`, `proposedItemsSoFar`) — a
run with three human checkpoints must not get four budgets.

The charge points differ because the engines differ. The static driver charges
per declared step; this one charges inside each tool call, because on this
engine a tool call IS the unit of work. Both counters move together, as the
static driver moves them, one call per step.

**A ceiling worth naming:** `RUNTIME_MS` can only be charged BEFORE dispatch. A
submission is one call and nothing here interrupts a model mid-turn, so a run
that starts inside its wall clock can finish outside it. The per-tool charge
bounds how far past, since every subsequent call re-checks. The upgrade path is
an `AbortSignal` into the dispatch.

### A cap that fires mid-dispatch is latched, not thrown out

A throw from inside a tool is, to the runtime, a tool error the model may
simply try around. So the halt is recorded in a latch, every subsequent call is
refused outright, and the run is settled at the cap once the submission
settles. The latch also wins over a tidy-looking reply: a submission that
finished politely after being refused its tools is not a completed run, and
reporting it as one would hide the ceiling.

### `MODEL_CALL` and `TOOL_CALL` finally have a writer

They have been in `WorkflowStepKind` since the provenance migration with none —
recorded as a deliberate gap in the 2026-09-21 exhaustiveness note, because the
static driver cannot meet them: they are not shapes a definition declares but
facts about what an engine DID.

Both go through `recordStep`, the single write seam, so each carries its
hash-chained audit row exactly as a static step does. The TOOL_CALL row records
the model's **arguments** — deliberately, because that is the reviewable half
and it is recorded nowhere else: the funnel's audit row carries the tool name,
the policy-card version and the manifest digest, not the input. That was
checked rather than assumed; the first draft of this note claimed the funnel
already captured them, and it does not.

The MODEL_CALL row records token counts and **not** the reply text. Agent
output becomes an `AgentProposal` if it becomes anything, and that row is
guarded, diffed and reviewable — a copy in the step ledger would be un-guarded
model output in a second, unreviewed place.

### Usage arrives through response metadata, not a callback

`AgentReply` carries no usage. The settled totals reach agent code only through
`useResponseFinish`, whose return value is deep-merged onto the response
metadata — which the reply *does* carry. So the agent reports and the driver
records. The alternative, a callback closed over driver state, would put
Prisma-reaching code in the one module that must stay loadable under the ESM
project.

### Tools are WRAPPED, never re-implemented

The guard sandwich, the funnel and the funnel's audit row all live inside the
closure `flueToolsFor` built. A second path to the tool would be a path around
all three. The wrapper adds the ledger row and the budget charge and delegates
everything else.

### Providers are registered under OUR ids, once, at boot

A provider id is the left half of the `"<provider-id>/<model-id>"` specifier,
which makes it the routing decision — and routing is what `aiResidency`
governs. Under `inflect-external` / `inflect-local` the id says what the
residency IS and the vendor is an implementation detail behind it. A deployment
with no external credential registers no external provider at all, so there is
no route to resolve against even if a specifier were wrong.

Auth resolves from the value passed in rather than ambient `process.env`: pi's
built-in factories read their vendor env var themselves, which would mean a key
merely present in the environment creates a working external route regardless
of what the deployment decided.

**A second ceiling worth naming:** `resolveFlueModel` honours a per-tenant
`localModel`, but providers are registered once at boot — mutating the registry
per run is the exact race `model-selection.ts` exists to avoid. So a tenant
override is only servable if the deployment registered that id. Rather than
fail inside pi mid-run, `flueModelIsRegistered` answers it before dispatch and
the run is refused with `flue_model_not_registered`, which names the gap.

### The boot is lazy, and that is a concession

`runtime-bootstrap.ts` says the boot site belongs with process lifecycle. This
process has no such site: Next.js offers no after-boot hook that runs in every
target, and the BullMQ worker that will own run execution does not exist yet.
Booting at module top level would start a runtime in every process that imports
the module, `next build` included.

So it is memoised on the first run that needs it, with the promise stored
BEFORE it is awaited — `start()` throws if the process already has a runtime,
which makes "exactly once" a correctness requirement, not an optimisation. A
failed boot clears the memo, because caching a rejection would make one
transient failure permanent for the life of the process.

## Three shared helpers came out of the static driver

`haltRunAtCap` joined `updateRun`/`failRun` in `run-settlement.ts`, and
`proposedItemsSoFar` joined `getRunRow` in `run-store.ts`. How a run reaches a
terminal state, and how much it has already proposed, are not properties of one
engine — two drivers answering them separately would drift. Both bodies moved
byte-identical, and that was verified rather than asserted.

## What the guards learned

**A new guard, `flue-esm-modules-stay-off-the-static-graph`.** Three docstrings
claimed the ESM packages were unreachable from the ordinary graph, and nothing
enforced it. It walks static import edges from the roots ordinary suites load —
reachability, not a file allowlist, because a list of "files that may import X"
says nothing about who imports *those* files. A planted static edge from
`driver.ts` to `./execute` turns three of its tests red.

It also had to distinguish **value** imports from `import type`: two modules
name an ESM package type-only, are erased at runtime, and are correctly in the
ordinary graph. Both lists are asserted, so "safe because it is type-only" stops
being true visibly rather than silently.

**`flue-refused-capabilities` was reporting the documentation.** Its violation
scan read raw text, so `execute.ts`'s docstring explaining why the packages are
imported *statically* — which quotes the dynamic form it does not use — tripped
the dynamic-import sentinel. Fixed by masking at the read seam with `codeOf`,
which its own `setProvider` scan already did. The cheapest way to satisfy an
unmasked detector is to delete the explanation, which is the wrong trade every
time. The control is two-sided: masked, the prose mention is gone AND the real
refused import is still caught.

**The Class D ratchets caught two real sloppinesses.** `toMatch(/haltRunAtCap\(/)`
matches eight sites in the static driver, including the docstring that merely
mentions it — an ambiguous needle satisfied by any one of them. Re-anchored on
the import, which occurs once and is the stronger claim anyway: the driver
reaches the SHARED halt path, not a same-named local.

The un-analysable ratchet then flagged one site, and the fix was the one it asks
for: **narrow the read.** `functionBodyOf(driver, 'runFlueDriver')` instead of
the whole file takes the site out of the measured population entirely and
asserts something stronger — the dynamic import is on the execution path, not
merely somewhere in the file. No baseline was raised.

**`no-raw-prompt-logging` grew four pairs**, one of which is a relocation. Holes
went 156 → 159 and sinks 88 → 91, both re-measured rather than estimated; the
ratio tightened (1.747 from 1.773), so the detector did not lose power.
