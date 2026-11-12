# 2026-11-12 — Tool Runner: the external-AI transfer gate, a resumed run's specification, and guard-before-cap

Issues #5364 and #5372.

## Design

**#5364: the Tool Runner asks the transfer gate.** The Flue engine asks
`externalResidencyRefusal` after it builds the tool offer and before its first
model call (#3872). The Tool Runner built the same offer (`toolRunnerToolsFor`
over `offerToolSet`, which reports `externalConnections`) and never asked, so a
run offered a read tool on an `mcp-server` connection marked `reachesBusinessSystem`
sent that system's rows to Anthropic with no acknowledgement on record. The
integration test reproduces it on unfixed code: the run settles COMPLETED with
two requests sent.

```
runToolRunnerDriver
  posturesFor(ctx)                one read: RESIDENCY_SELECT + EXTERNAL_AI_ACK_SELECT
  planToolRunnerRun → clientForRun → { client, providerId: TOOL_RUNNER_PROVIDER_ID }
  executeToolRunnerRun(..., client, { providerId, externalAiAcknowledgement })
    offer → empty-catalogue check → externalResidencyRefusal(...) → failRun | runner
```

The gate's route check was the deeper half. It returned "proceed" for any
`providerId !== FLUE_PROVIDER_IDS.external`, so it could not be wired to the Tool
Runner honestly: Flue's `inflect-external` is a pi-ai registration this engine
never touches, and any id of its own would have passed. The check is now
"proceed only on `FLUE_PROVIDER_IDS.local`": inside the deployment is the one
named route, and every other id, one the gate has never heard of included, is a
transfer.

The conformance suite gained the scenario and its positive control
(`business-data-transfer-refused-unacknowledged`,
`business-data-transfer-acknowledged-proceeds`), so the Flue engine, the Tool
Runner and any later hosted engine are held to it. Both adapters supply the
connection facts on a tool and the acknowledgement on the settings read; the
engines and the gate are real.

**#5372.1: a resumed run keeps its specification.** `runMessage` listed
`def.steps.slice(fromSeq)`. On a reasoning engine `fromSeq` is a ledger
position: `resumePositionOf` takes it from the committed `WorkflowStep` rows,
which are model and tool calls. A run resumed after one call lost its first
step; after as many calls as the definition has steps, it was sent "Cover the
following, in order." and nothing after it. Tests on both engines showed it at
seq 1, 2 and 7 or 9. `driver-plan.ts` had already recorded the same
incommensurability for the resume bound (#3602), and the flow branch of
`runMessage` already listed a flow whole for this reason. The parameter is
removed, so the message cannot depend on where a run resumed.

**#5372.2: the guard verdict before the caps.** In the Tool Runner loop the
token and wall-clock caps were charged before a non-CLEAN model answer's
verdict was noted. A QUARANTINED answer that also crossed a cap settled as a
cap halt: no breaker latch (`latchOnGuardBlock`) and no
`WORKFLOW_RUN_GUARD_BLOCKED` row. The verdict is now noted straight after the
call is recorded. `stopped()` then answers GUARD and the loop leaves before any
cap is charged. The kill is still read after it, and still wins at settlement.

**#5372.3: the guard's message names the engine.** `haltRunAtGuard` takes an
`enginePrefix` as `haltRunAtKill` does, and the Tool Runner passes
`'tool_runner'`. The gate's refusal takes one too.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/external-residency-gate.ts` | Inside is named (`local` only); `enginePrefix` and an engine-appropriate remedy in the refusal |
| `src/lib/agentic/flue/model-selection.ts` | `providerIdOf` docstring: an unparseable specifier is now "outside" to the gate |
| `src/lib/agentic/tool-runner/client.ts` | `TOOL_RUNNER_PROVIDER_ID`, returned by `clientForRun` |
| `src/lib/agentic/tool-runner/driver.ts` | `posturesFor` reads the acknowledgement with the residency; the plan carries the provider id |
| `src/lib/agentic/tool-runner/execute.ts` | The gate before the runner; the verdict before the caps; `haltRunAtGuard(..., 'tool_runner')` |
| `src/lib/agentic/drivers/run-settlement.ts` | `haltRunAtGuard` takes `enginePrefix` (default `flue`) |
| `src/lib/agentic/flue/run-message.ts` | `runMessage` lists the whole step list and takes no `fromSeq` |
| `src/lib/agentic/flue/execute.ts` | The one call site, without `fromSeq` |
| `tests/helpers/driver-conformance.ts` | Two transfer-gate scenarios; tools may carry connection facts; runs may carry the acknowledgement |

## Decisions

- **Inverting the gate rather than passing Flue's external id.** Passing
  `FLUE_PROVIDER_IDS.external` from the Tool Runner would have closed #5364 and
  left the hole: the next engine with its own id would pass the gate silently.
  The gate fails open on a route it does not know, and that is the wrong way for
  a transfer control. It is a fact about routing, which we own, not a claim
  about the world like `reachesBusinessSystem`, where NULL rightly proceeds.
  The only id that changes outcome is an unparseable Flue specifier, and such a
  run is refused as unregistered before the gate is reached.
- **The acknowledgement travels from the driver**, as on Flue: the question is
  what permitted this run, and the driver already holds the settings row. The
  engine's parameter is required, so a caller that forgets it does not compile.
- **The Tool Runner's refusal does not say "set LOCAL_ONLY".** A LOCAL_ONLY
  workspace refuses this engine outright, so that remedy would stop the run
  instead of serving it. Its message names the Flue engine under LOCAL_ONLY.
  Flue's message is unchanged.
- **Removing `fromSeq` from `runMessage` rather than ignoring it.** An ignored
  parameter named for a resume offset invites the slice back. A first segment
  (seq 0) gets exactly the message it always got, so no first-call decision
  digest moves. A resumed run's digest changes because its prompt changes,
  which is the fix.
- **The verdict is noted, not acted on, before the kill read.** Settlement
  order is unchanged (kill, cap, guard). A QUARANTINED answer crossing a cap
  now settles at the guard because the cap is never charged on that turn. A cap
  that latched earlier, at a tool, still outranks a later verdict. That is
  Flue's order (#4230) and is not changed here.
