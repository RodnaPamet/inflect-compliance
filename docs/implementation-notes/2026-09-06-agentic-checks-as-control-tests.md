# 2026-09-06 — the four agentic checks, as automated control tests

**Commit:** `<pending>` feat(agentic): four agentic checks as automated control tests

## Design

Nine prompts of agent governance produced state a person can look at — a policy
card, a tool pin, a review-quality report, a drill row. None of them produced
what an assessor asks for, which is not "show me your kill switch" but "show me
that it worked, last month, without anybody being asked". That is a control
test, and Epic G-2 has had a runner for one since it shipped.

So there is **no second runner and no new job**. Four checks, one handler,
registered on the seam `control-test-runner.ts` already exposed:

```
ControlTestPlan(automationType = INTEGRATION,
                schedule       = <cron>,
                automationConfig = { check: '<AGENTIC_CHECK_ID>' })
    │  control-test-scheduler (every 5 min) claims it when its OWN cron is due
    ▼
control-test-runner ──► agenticControlTestHandler ──► one AgenticCheckOutcome
    │
    ├─► ControlTestRun(COMPLETED, PASS | FAIL | INCONCLUSIVE)
    ├─► Evidence(TEXT, anchored on the plan's controlId)
    └─► on FAIL: Finding(NONCONFORMITY, OPEN) ← FindingEvidence ← that Evidence
```

The evidence attach and the Finding are the runner's, not the checks'. A fifth
way to raise a Finding would be a fifth thing to keep in step.

The four checks, and what each re-reads:

| Check | Reads | Covers |
| --- | --- | --- |
| `AGENTIC_POLICY_CARD_CONFORMANCE` | every card's HEAD version against the agent's tier ceiling, the register's declared data scope, and the live tool catalogue | ASI02, ASI03 |
| `AGENTIC_TOOL_MANIFEST_INTEGRITY` | every `McpToolManifestPin` against `hashToolManifest` of this build | ASI04 |
| `AGENTIC_REVIEW_QUALITY` | the report's own `loadReviewObservations` + the pure `computeReviewQuality` | ASI09 |
| `AGENTIC_KILL_SWITCH_DRILL` | the newest `AgentKillSwitchDrill` row, and its age | ASI08, ASI10 |

### The empty tenant gets a third answer

A control test that FAILS a tenant with no agents cries wolf at every customer
who has not adopted them. One that PASSES reports compliance nobody earned —
and it is the worse of the two, because it is silent.

Both are refused. A check with nothing to examine returns
`verdict: 'INCONCLUSIVE'` with `vacuous: true`, and the runner's existing
`isAttestingVerdict` — `PASS` or `FAIL`, never `INCONCLUSIVE` — then declines to
stamp `Control.lastTested`. The control keeps reading as DUE, the evidence row
says `Examined: 0` and `Vacuous: yes` in its first lines, and no Finding is
raised. Nobody is woken and nobody is credited.

That disposition was not invented here. `attestControlTested` already documents
it for a run that did not exercise the control; reusing it is what keeps the
agentic surface telling the same story as the rest of the product.

`vacuous` is a FIELD rather than an inference from `population === 0`, because
the two come apart: a review window holding four decisions is INCONCLUSIVE (the
engine's own `MIN_REPORTABLE_SAMPLE` refuses to estimate from it) but four
decisions is not nothing, and reporting it as "no agents here" would hide a
tenant that has begun. Bases distinguish them — `NO_DECISIONS_IN_WINDOW` vs
`BELOW_REPORTABLE_SAMPLE`.

### What these cost

The premise "four checks per tenant per tick, every five minutes" is not what
happens, and the difference is the whole budget argument.
`control-test-scheduler` ticks every five minutes; `control-test-runner`
executes a plan only on a tick where that plan's own cron says it is DUE. A
check on a daily cron costs nothing on 287 of the 288 daily ticks. The per-tick
cost is the existing `findDueTestPlans` scan across all tenants, capped at 500
rows; these checks add no row to it that an operator did not schedule.

What one FIRING costs, all inside the transaction the runner already opened:

- **policy-card** — 3 queries (agents, their cards, the head versions), bounded
  by `AGENT_SCAN_CAP` with `truncated` reported when the cap bites. Head
  versions are fetched in ONE `in` over the distinct version numbers and paired
  in memory, never per card.
- **tool manifest** — 1 query bounded by `PIN_SCAN_CAP`. The live hashes are
  computed once per process: the definitions ship with the build and cannot
  change under a running worker.
- **review quality** — 3 queries via the report's own loader, capped at
  `MAX_REPORT_ROWS` (5000). The expensive one. Put it on a daily cron.
- **kill-switch drill** — one count plus one index-served point read on
  `[tenantId, startedAt]`, and a second point read only when there is no drill
  at all.

No check reads in a loop and none is unbounded, which is what
`query-shape-guardrails` asks of anything under `src/app-layer`.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/services/agent-control-tests.ts` | The four checks, the ASI coverage table, the exemptions, the config parser, the handler and its registration. No logging sinks; it sits inside `local/no-raw-prompt-logging`'s scope so anything added later is held to digest discipline. |
| `src/app-layer/jobs/control-test-runner.ts` | `AutomationHandlerInput` gains `db` (the tenant transaction already open); `AutomationHandler` may return `null` to DECLINE; `controlTestRunnerExecutor` registers the agentic engine on first pickup. |
| `src/app-layer/usecases/agent-review-quality.ts` | `loadReviewObservations(db, tenantId, since)` extracted so the report and the control test read the same rows through the same three queries. |
| `tests/integration/agentic-control-tests.test.ts` | Each check through the real runner against a real database: healthy → PASS, seeded breach → FAIL + Finding, empty tenant → INCONCLUSIVE and not attested. |
| `tests/guardrails/agentic-evidence-coverage.test.ts` | Every ASI risk has a check or a written exemption; the population is parsed out of the shipped library. |

## Decisions

- **A handler may DECLINE, and that is why registering on INTEGRATION is safe.**
  `runnerHandlerRegistry` is keyed by `automationType`, so registering an
  INTEGRATION handler claims every INTEGRATION plan in the product. Without a
  decline the first narrow engine to land would have had to invent a verdict for
  plans it knows nothing about — and `INCONCLUSIVE` is exactly the "jargon
  no-op" the runner's own header already rejected once. `null` routes the plan
  to the manual path, precisely where an unregistered type goes, so a foreign
  plan is left exactly where it was before this existed.

- **The handler receives the runner's `db` rather than opening its own.** A
  nested `$transaction` would take a second pool connection to read rows the
  outer one can already see, under the outer transaction's timeout, and outside
  the RLS context the runner established. The one existing unit assertion that
  pinned the handler input exactly was updated rather than loosened — it now
  asserts `db` by identity against the mocked tx, so a handler handed some other
  client fails there rather than silently reading past the tenant boundary.

- **Registration lives in `controlTestRunnerExecutor`, not in
  `executor-registry.ts`.** Two reasons. A worker that never runs a control test
  does not pull the agentic service into its import graph. And — the load-bearing
  one — `executor-registry` registers by string key, and the repo's bounded-read
  helpers mask string literals before they scan, so a registration placed there
  could only be checked by grepping the whole file, which is satisfied by the
  same call sitting in any other executor. Anchored on a named exported function
  it cannot be: the ratchet reads `functionBodyOf(src, 'controlTestRunnerExecutor')`
  and additionally asserts the registration precedes the run.

- **The policy-card check exists because the write path cannot report these
  states.** `assertDataScopeRaiseWithinDeclaration` refuses only a WIDENING, and
  says so deliberately — a card already above the register's declaration is
  reachable, because narrowing `RegisteredAgent.dataAccessScope` is never refused
  and does not reach back to rewrite the card, and refusing the resulting VALUE
  would fight the operator repairing it. Likewise `assertDeclarationsExercisable`
  compares against the tier ceiling at WRITE time, so re-assessing an agent
  upwards silently puts its card above the new ceiling. Both are seeded as
  breaches in the integration test for exactly that reason.

- **`ERROR` on a drill is INCONCLUSIVE, not FAIL.** The
  `AgentKillSwitchDrill.outcome` column exists to keep "the control is broken"
  and "the drill could not run" apart; collapsing them would raise a Finding
  about the wrong thing. A stale PASSED drill, on the other hand, IS a failure —
  the drill runs nightly, so a newest-PASSED row two days old means the job has
  stopped, and a control whose self-test has stopped running is
  indistinguishable from one that is passing. An unrecognised outcome sorts to
  INCONCLUSIVE rather than falling through to PASS, the direction
  `coerceStoredMode` already takes for an unknown identity write mode.

- **The review-quality check calls the loader and the pure engine, not the
  usecase.** `computeAgentReviewQuality` writes a deduplicated ALERT audit row as
  a side effect, and a control test that alerts every time it runs is one nobody
  reads. Extracting `loadReviewObservations` rather than copying its three
  queries means the page and the control test cannot end up with two
  denominators — a report saying "no signals" beside a control test saying FAIL
  would be worse evidence than either alone.

- **The ratchet's population is parsed out of the library, never listed.** An
  upstream Top-10 revision that adds ASI11 turns it red on the day the library is
  updated. It pins BOTH directions by exact equality against `[]`: uncovered (the
  obvious one) and doubly-claimed — an exemption sitting beside a working check
  reads, to anybody auditing the list, as a risk nobody covers, and its prose
  will still be explaining why the thing is impossible long after somebody made
  it possible.

- **Four risks are exempt, and each names where its control actually lives.**
  ASI01 (goal hijack) and ASI06 (context poisoning) are judged per invocation, at
  the only moment anything can act on them; re-deriving either after the fact
  would mean re-running a guard over stored content, which this subsystem will
  not do. ASI05 (unexpected code execution) is a compile-time fact about the
  build — every tenant runs the same binary, so a scheduled read of a customer
  database would return the same answer for all of them and be evidence about CI
  wearing a tenant control test's clothes. ASI07 (inter-agent communication) has
  no transport in this build, so there is no state to drift; that exemption
  expires the day a multi-agent surface lands, and it is the only one about
  absence rather than about where the control lives.
