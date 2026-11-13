# 2026-11-13 — Inspect starts Tool Runner runs through an automation rule

**Commit:** `fix(evals): Inspect starts Tool Runner runs as the AUTOMATION trigger; the fallback key sends its workspace`

## Design

Since #5367 a profile key names the trigger that starts it, and the generic
`POST /api/t/<slug>/agent-runs` names none, so every Tool Runner sample the
harness started there was refused `PROFILE_TRIGGER_REQUIRED`. Owner decision
(2026-11-13): the harness starts those runs as AUTOMATION, through a real rule
the seed creates, the way production starts an unattended run. No new trigger,
no change to the trigger rules, no change to the generic route.

```
seed (scripts/inspect-seed.ts), per Tool Runner profile:
  profile version   allowedTriggers = [AUTOMATION]
  AutomationRule    ENABLED, author = OWNER
                    TASK_CREATED, filter: title in <the profile's sample inputs>
                    INVOKE_AGENT { agentId: profile agent, workflowKey: agent-profile:<id>@v<n>,
                                   inputMapping: { question: 'title' } }

harness (runner._start_through_rule), per sample, as the OWNER:
  GET  /agent-runs?agentId=<agent>            runs before
  POST /tasks { title: <sample input> }        -> TASK_CREATED -> automation-event-dispatch
                                                  -> INVOKE_AGENT -> agent-invoke-dispatch
                                                  -> startWorkflowRun(..., profileTrigger: AUTOMATION)
  GET  /automation/rules/<id>/executions      the execution whose triggerPayload.key = the task's key
  GET  /agent-runs?agentId=<agent>            the one new row, of the profile's run key
  ... then observed exactly as before (run, steps, proposals, kill drill)
```

The run executes as the profile's agent under the rule author's membership
(`agent-invoke-dispatch`), so the kill switch and breaker are asked before the
row exists, and `startWorkflowRun` applies the registration and residency
gates, the caps and the version's own trigger check. Nothing is bypassed.

## Files

| File | Role |
|---|---|
| `scripts/inspect-seed/fixtures.ts` | The trigger constants; each profile's `triggerTitles`, refused when a title cannot be a task title or would fire two profiles; profile agents are `startedBy: 'automation-rule'` with no key scopes |
| `scripts/inspect-seed.ts` | Versions allow AUTOMATION alone; `ensureAutomationRule`; no key for a profile agent; `automationRules` in the manifest |
| `evals/inspect/inflect_inspect/product.py` | `create_task`, `rule_executions`, `agent_runs`; the agent key is optional and `start_run` refuses without one |
| `evals/inspect/inflect_inspect/runner.py` | `_start_through_rule`; `SeedManifest.rule_id` |
| `evals/inspect/inflect_inspect/tasks.py` | Reads a key only for a run started with one |
| `evals/inspect/fixtures/product-contract.json` | The three new reads, held to the product's types |
| `.github/workflows/agent-evals.yml` | Keys only for Flue tenants; `ANTHROPIC_WORKSPACE_ID` with the fallback key |

## Decisions

- **`TASK_CREATED`, fired by the OWNER creating a task.** It is an event the
  product emits from a route the seed's OWNER already holds (`tasks.create`),
  and it carries a free-text field (`title`) the rule can map. Rejected:
  `RISK_CREATED` (task 1 counts risks), the re-trigger route (it replays the
  last execution's payload, so it cannot carry a sample's input), and a new
  firing route (a product decision this work does not make).
- **The rule's filter is the sample titles, not a hidden discriminator.** Six
  profiles share one event on one tenant; `title in [...]` makes the task's own
  title select the rule, so one task fires one rule, and the title the run
  records is the sample's input. A profile run ignores caller input (D-EV-7),
  so the title is provenance. A severity/priority pairing would have worked and
  said nothing.
- **The run is found among the agent's runs, not by its cause.** A directly
  fired `INVOKE_AGENT` passes `event.data.__parentExecutionId`, which only the
  chain and sub-flow dispatchers stamp, so the run row records `''`, not its
  execution. Under one sample in flight, the one new run of the agent with the
  profile's key is exact; two new runs, a run of another key, or one naming a
  different execution end the pass. A run naming the execution is accepted, so
  the harness keeps working if that lineage is ever recorded.
- **What ends the sample and what ends the pass.** A refused task, an execution
  that did not succeed, or no run within 120 s of a SUCCEEDED execution (the
  dispatch's three attempts finish well inside it) is a start the product
  refused: the sample is INCOMPLETE and the next one runs. A failed request or
  read once the task exists, or no execution by the deadline, may leave a run
  live that the harness cannot name, so the pass stops.
- **A profile agent holds no key.** Nothing presents one any more, and a key
  nobody uses is a credential with no purpose. The workflow refuses a key for
  a Tool Runner tenant rather than masking and passing it along.
- **The workspace header follows garak (#5498).** Only with the fallback
  organisation-level key; the job log names the key's source and whether the
  header was sent. Both engines read `ANTHROPIC_WORKSPACE_ID` in the worker,
  which inherits the start step's env.
