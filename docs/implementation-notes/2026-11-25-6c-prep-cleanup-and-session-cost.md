# 2026-11-25 — 6c preparation: hosted clean-up on an own workspace, and session-hour cost

**Commit:** see the branch `feat/feat-6c-prep-cleanup-and-session-cost` for #4173
(owner decisions 3 and 4 of 2026-11-25). Both are built behind
`HOSTED_MANAGED_AGENTS_ACTIVE = false`, which this branch does not touch:
flipping it is Step 6c, not before 2026-12-24.

## Design

```
upsertIntegrationConnection ── commits ──▶ provider anthropic-workspace AND isEnabled?
                                               │
                     cleanUpHostedOnOwnWorkspaceConnected(ctx, connectionId)   never throws
                        readUncoveredHostedRecords: opt-in · OPEN hosted record ·
                        hosted provision / hosted run newer than the last DONE
                        hosted record's coversUntil
                        │ nothing → return
                        ├─ withdrawHostedOptInOnOwnWorkspace   (opt-in file: still its one writer)
                        └─ openConnectionRemovalCleanup(ctx, 'inflect-hosted')   (Step 5c, unchanged)
                                 constant false → record OPEN, HOSTED_NOT_ACTIVE, no request
                                 constant true  → recorded ids only, retried by data-lifecycle

hosted run ── SESSION_CREATED step (workspaceKind HOSTED) ──▶ hostedSessionsUnmetered + 1
          └─ settleSession: the status poll's sessions.retrieve is also the usage read
                 sessionUsageFrom(read) → active_seconds | READ_FAILED | STILL_RUNNING | NOT_REPORTED
                 meterHostedSession (before the delete, never throws)
                     known   → hostedSessionSeconds += s, hostedSessionsUnmetered − 1,
                               agent.hosted.session.seconds observes s
                     unknown → nothing written; agent.hosted.session.usage{outcome}
                 sessions.delete, whatever the meter did
```

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/hosted-managed-agents-own-workspace.ts` | when a saved own workspace has uncovered hosted records, withdraws the opt-in and opens Step 5c's hosted clean-up |
| `src/app-layer/usecases/integrations.ts` | calls it after the connection save commits, for an enabled `anthropic-workspace` connection |
| `src/app-layer/usecases/hosted-managed-agents-opt-in.ts` | `withdrawHostedOptInOnOwnWorkspace`: the opt-in column's second write, in its one-writer file, off only |
| `src/lib/agentic/managed-agents/session-usage.ts` | the usage parse and the two writes of the new columns |
| `src/lib/agentic/managed-agents/execute.ts` | counts a hosted `SESSION_CREATED`; reads the usage in the settle's poll and meters it before the delete |
| `src/lib/observability/metrics.ts` | `agent.hosted.session.usage` (by outcome) and `agent.hosted.session.seconds`, beside `agent.run.tokens` |
| `prisma/schema/agentic.prisma`, `prisma/migrations/20261125120000_hosted_session_usage/` | `WorkflowRun.hostedSessionSeconds`, `hostedSessionsUnmetered`, three CHECKs |

## Decisions

- **The figure is `usage.active_seconds`.** `BetaManagedAgentsSessionUsage` in
  `@anthropic-ai/sdk` 1.8.0 names it "the duration the session's runtime cost is
  priced on", counting concurrent threads once (`stats.active_seconds` sums
  each thread's own time, and is not it). It is optional in the type, so an
  absent value is unknown. `list_cost` beside it is also optional and was not
  used: it is a list price, not what Inflect is billed, and pricing belongs to
  the owner's cost reports, not to the run.
- **The read is the settle's own `sessions.retrieve`.** The settle already
  polls the status until the session leaves `running`; the last answer carries
  the usage. No new request, and the allowlist needed no change. A read taken
  while the session still ran is unknown (`STILL_RUNNING`): its time was still
  growing.
- **New columns, not an existing one.** `costTokens` is tokens and the only
  cost column; a session-hour figure in it would mix units. The per-tenant
  record is the run row, as 6b made it for tokens (`hostedManagedAgents` plus
  the costs). The ledger step was not used: its `inputJson` is encrypted, so a
  per-tenant sum would decrypt every step.
- **Two columns, because a run can have several sessions** (a person's resume,
  a lost create found again), and "unknown" must survive a later known read.
  `hostedSessionsUnmetered` counts a hosted session up when its
  `SESSION_CREATED` step is written and down when its usage is read, so a
  session that is never read, including one a dead worker left to the
  reconciliation, stays counted as unknown. `hostedSessionSeconds` is NULL
  until something is read, never 0 for "not known". A reconnected segment
  writes no second `SESSION_CREATED`, so a session is counted once.
- **A run in the tenant's own workspace records nothing**, held three times:
  the settle meters only a `HOSTED` route, both writes are `WHERE
  "hostedManagedAgents" = true`, and a CHECK refuses either column on a run
  not marked hosted.
- **The writes are not fenced by the run lease.** A worker that lost the run
  never reaches the meter (the settle returns on a takeover first), and the
  drain, which clears the lease to nobody, still settles and should still
  meter. The decrement is `GREATEST(… − 1, 0)`, so a read with no counted
  create cannot go negative.
- **The clean-up reuses Step 5c's `CONNECTION_REMOVED` record under
  `inflect-hosted`.** That is what the record says: Inflect's workspace was
  removed from this tenant, exactly as on an opt-out. No new trigger or reason
  value; the opt-in's audit row (`cause: OWN_WORKSPACE_CONNECTED`, the
  connection id) and the log line say why.
- **It runs only on uncovered hosted records**, by the clean-up's own scope rule
  (a provision or a hosted run created after the newest DONE hosted record's
  `coversUntil`, an OPEN hosted record, or the opt-in). So the first save of an
  own connection cleans up, and a rename, a second connection or a re-enable
  sends nothing for objects already removed. Re-archiving an archived agent is
  not known to be accepted by Anthropic, and an answer that is not done would
  keep a record OPEN for 30 days.
- **Connecting withdraws the opt-in** (recommended and built; an owner
  question). The tenant's own workspace already wins the resolution, so
  keeping the opt-in changes nothing while the connection lasts. What it would
  change is the moment the connection goes: a key rotated by remove and re-add,
  or a tenant leaving Anthropic, would send the next run's instructions and tool
  output to Inflect's US organisation without Zero Data Retention, under an
  opt-in given when the tenant had no account of its own. Withdrawing makes the
  return an owner's decision, taken again in person; the cost is one click for
  an owner who wanted the fallback. The write is a narrowing an ADMIN's save
  makes (the integrations save asks `canAdmin`), so it lives in the opt-in's
  one-writer file, can only turn the opt-in off, and is audited as the same
  action as an owner's change.
- **The opt-in is withdrawn before the clean-up opens**, so no new hosted run
  can be admitted while the clean-up runs; the own connection already wins the
  resolution, so this is belt and braces.
