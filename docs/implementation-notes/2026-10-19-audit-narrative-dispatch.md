# 2026-10-19 — The daily dispatch of the auditor agent's narrative run (#3749, part C)

**Commit:** see the pull request for #3749 part C.

## Design

```
08:50 UTC  audit-narrative-dispatch            (system-wide; tenantId scopes it)
  candidates: workpapers with no narrative, written ≥ 24 h ago      (drainPages)
  per tenant: the oldest whose period has ENDED → its period, its auditor
  batch reads: the auditors, their list_audit_workpapers grants,
               narrative runs started in the last 20 h
  per tenant, in order — the first that fails names the outcome:
    already_ran_today · auditor_not_found · auditor_not_active ·
    auditor_unscored · tool_not_granted · engine_not_flue ·
    auditor_kill_switched · auditor_breaker_latched ·
    owner_cannot_read_workpapers
  ctx = JOB, userId = the auditor's owner, agentId = the auditor,
        permissions = what the owner holds today        (agent-invoke-dispatch)
  startWorkflowRun(ctx, 'audit-narrative', { periodLabel })   → dispatched
  agentic.audit_narrative.dispatch { outcome }  per decision, or nothing_to_narrate
```

The run then goes the way part B made it go: the mount gate pins
`iam-audit-procedures`, Flue offers the read surface alone, and the capture
holds the answer to the record when the run settles. This job writes nothing
itself.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/jobs/audit-narrative-dispatch.ts` | the decision per tenant, and the BullMQ body |
| `src/app-layer/jobs/types.ts`, `schedules.ts`, `executor-registry.ts` | the payload, the retry policy, the 08:50 schedule, the registration |
| `src/lib/observability/integration-metrics.ts` | `agentic.audit_narrative.dispatch` |
| `tests/guards/fan-out-bucket-matches-schedule.test.ts` | the job excused as a dispatcher by name only, with the reason |

## Decisions

- **One period per tenant per day, oldest first.** A period holds more
  workpapers than one answer carries (six), and each run skips what is already
  narrated, so a large period is narrated over several days. Picking the oldest
  un-narrated workpaper's period means a backlog drains in order rather than the
  newest month starving the oldest.
- **Only an ENDED period, and only after 24 hours.** The procedure plans run on
  the 2nd; the narrative should read a period whose procedures have all
  written their workpapers. A period still open is no candidate at all, not a
  refusal: it is not yet narratable, which is different from a tenant that
  cannot be dispatched.
- **The spacing window is read from the runs table, not a BullMQ bucket.** A
  tenant that started a narrative run in the last 20 hours is skipped, whoever
  started it, a person on demand included. That is what makes the job safe to
  retry (`attempts: 3`), and it is why the fan-out bucket guard excuses this
  job by name rather than checking a bucket it does not have.
- **As the auditor agent, under its owner's permissions TODAY.** The same two
  facts `agent-invoke-dispatch` keeps apart: the actor is a JOB carrying the
  agent's id, and the authority is what the agent's owner holds when the job
  runs, resolved fresh. An owner who has lost both `audits.workpaper_view` and
  `audits.manage`, or the membership, is refused rather than borrowed.
- **The static engine is refused, not dispatched.** A static run reads the
  workpapers and writes no narrative, so a daily static run would be a row a
  day that can never do the one thing it is for. `engine_not_flue` tells the
  operator what to change.
- **Every refusal is a distinct operator action.** Risk-assess the auditor,
  grant it the read tool, give its owner the view key, lift a kill, close a
  breaker. Folding any two would send the operator to the wrong screen. The
  cheap checks run before the driver, kill and breaker reads, and the owner's
  context is resolved last, because it is the most expensive.
- **A night with nothing to narrate is counted.** One `nothing_to_narrate`
  per run that found no candidate, so a quiet night is told apart from a job
  that never ran.
- **08:50 UTC.** Before internal audit's sampling sweep and its working hours,
  so a narrative is on the review sheet when the queue is read, and off the
  08:00 jobs.
