# 2026-11-25 — A Managed Agents response from another workspace fails the call (#5854, finding 4)

**Commit:** `fix(agents): …` (see the branch `fix/fix-5854-workspace-header`)

Owner decision of 2026-11-25, recorded on #5854:

> A Managed Agents response whose `anthropic-workspace-id` header names a
> workspace other than the configured one fails the call. A response without
> the header passes, and is counted (an OTel metric) and logged without ids.
> Refusing a missing header too waits for evidence from a real-workspace run
> (5H part 2) that every endpoint a run uses sends it. Make that a one-line
> switch: a source constant, not env.

The Step 5H adversarial read (`2026-11-23-step-5h-adversarial-read.md`,
"Briefly: the response's workspace on the run path") found that the engine
sent the header on every request and read the response's on none; only the 5a
Test compared it.

## Design

```
managedAgentsClientFor({ apiKey, workspaceId, runId })
    latch = newWorkspaceHeaderLatch()          one per client, so one per run
    middleware: managedAgentsOnlyFor
        request refusal (unchanged)
        response = await next(request)
        checkResponseWorkspace(response, { configuredWorkspaceId, endpoint, … })
            answeredWorkspace(headers, configured)    THE comparison (5a's Test asks it too)
            count agentic.managed_agents.workspace_header {endpoint, answered, response}
            MISMATCH (or MISSING while REFUSE_MISSING_WORKSPACE_HEADER):
                latch it; cancel the body; throw ManagedAgentsWorkspaceMismatchError
            MISSING: pass; log once per client (no ids)
    bindWorkspaceHeaderLatch(client, latch)

executeManagedAgentsRun
    mismatched() = workspaceMismatchSeen(client)       part of isStopped()
    segment start's unrecorded-session look   → mismatched? refuse by name
    agent / environment / reconnect retrieve  → mismatched? refuse by name
    sessions.create                           → mismatched? look for it as a lost create, fail by name
    the stream (open, history, reopen)        → a stop, never a drop: not reopened
    the stop                                  → skipped: the session is not driven
    finally: settleSession                    → reads and delete sent; each answer checked on its own
    settlement: abort, kill, MISMATCH, breaker, cap, guard, …

cleanup.ts  outcomeOfError: mismatch first → WORKSPACE_MISMATCH (never done, halting)
```

The middleware is the one place every Managed Agents response passes: the
engine's driver, provisioning, the clean-up and the reconciliation all build
their client with `managedAgentsClientFor`, for the tenant's own workspace and
for `inflect-hosted` alike. The SDK hands middleware the `Response` before it
reads the body, so the event stream's initial headers are checked before any
event is parsed.

## Files

| File | Role |
| --- | --- |
| `src/lib/ai/anthropic-workspace.ts` | `answeredWorkspace`: the one comparison (MATCH / MISSING / MISMATCH) |
| `src/app-layer/integrations/providers/anthropic-workspace/index.ts` | The 5a Test asks `answeredWorkspace` instead of comparing inline |
| `src/lib/agentic/managed-agents/workspace-header.ts` | The switch, the typed error, the per-client latch, `checkResponseWorkspace` |
| `src/lib/agentic/tool-runner/client.ts` | Named routes (`managedAgentsEndpointOf`); the middleware checks every response; the latch is bound to the client |
| `src/lib/agentic/managed-agents/execute.ts` | The run stops on the latch, never drives the session after it, and fails `managed_agents_workspace_mismatch` |
| `src/lib/agentic/managed-agents/cleanup.ts`, `src/app-layer/usecases/managed-agents-cleanup.ts` | `WORKSPACE_MISMATCH` outcome: never done, halts a pass |
| `src/app-layer/usecases/agent-profile-provision.ts` | Provisioning names the refusal `WORKSPACE_MISMATCH` |
| `src/lib/observability/integration-metrics.ts` | `agentic.managed_agents.workspace_header` |
| `tests/helpers/managed-agents-faux.ts`, `scripts/e2e-anthropic-workspace-faux.mjs` | The fauxes echo the request's workspace; a switch sends none or another |

## Decisions

- **One latch per client, read by the engine.** A mismatch can be heard by a
  call whose caller swallows errors (the crash-window listing, the stop's
  drain, the settle). The latch makes "this run heard from another workspace"
  a fact the run reads at every decision point, rather than one each `catch`
  must remember to look for.
- **The settle still sends its calls after a mismatch, and believes only the
  right workspace.** The alternative, refusing every request once latched,
  would leave a session undeleted after a transient misroute until the daily
  reconciliation. Each answer is checked on its own, so a delete counts only on
  an answer that names the configured workspace. A mismatched DELETE is
  recorded `SESSION_DELETE_FAILED` with `providerErrorType: 'workspace_mismatch'`
  and no status, which the failed-delete reconciliation retries with a fresh
  client; a mismatched 404 is not "already gone". The same rule holds in the
  clean-up pass (`WORKSPACE_MISMATCH`, halting, first in the reason order) and
  the lost-delete read-back (`unverified`: the error carries no status).
- **The session is not DRIVEN after a mismatch.** No queued call runs, the
  stream is not reopened (a mismatch is a stop, not a drop), and the stop
  sends no `is_error` answers, no interrupt and no drain read. The settle
  interrupts a running session only on a read it trusts.
- **A mismatched session create is looked for as a lost create is.** The
  session may exist in the configured workspace though the answer cannot be
  believed; the crash-window listing finds it by this run's metadata through
  answers from the right workspace and settles it. (The explicit
  `|| answered` is equivalent today, because the error carries no status; it
  is kept so the rule does not depend on that.)
- **Any mismatch fails the run, the settle's own included**, after an Abort
  and a kill and before everything else. A run whose session could not be
  shown deleted because the workspace answered as another is an incident the
  run's page must name, not a footnote in its ledger.
- **The error carries no status and the provider's text never.** Its `type` is
  ours (`workspace_mismatch`), so a ledger step names it. The run's sentence
  names no workspace: the configured id is the customer's, and the other is
  somebody else's. The log names the endpoint, method and status, never an id.
- **A missing header is counted by endpoint and response class.** The
  `missing` series per endpoint, beside `match`, is the evidence the owner's
  decision waits on. Logged once per client so a run with every response
  missing writes one line.
- **The metric lives in `integration-metrics.ts`**, beside the engine's other
  diagnostic counters; `tests/unit/epic19-coherence.test.ts` reads
  `metrics.ts` only, so it has no entry to add.
- **No E2E spec was added.** The E2E faux echoes the request's workspace on
  every `/v1/` answer (so the existing specs keep counting `match`) and takes
  `POST /__faux/workspace-answer?workspace=…&answer=none|other|echo`; the
  engine's behaviour is held by the Jest suites over the in-process faux.
