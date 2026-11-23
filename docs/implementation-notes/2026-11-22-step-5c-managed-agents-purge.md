# 2026-11-22 — Step 5c: purge and DSAR reach the provider

**Commit:** `feat(agents): purge, connection removal and DSAR reach the customer's Anthropic workspace (Step 5c, #4166)`

## Design

Step 5b creates sessions and agents in a customer's own Anthropic workspace (shape
MA-C2). Step 5c removes them, by the ids Inflect recorded, on three triggers:

```text
tenant purge ──► cleanUpManagedAgentsBeforePurge ──(ONE attempt, 60 s)──► ManagedAgentsCleanup
                 (before the purge transaction)                           DONE | PURGED_KEY_DESTROYED_UNFINISHED
                                                                          (terminal; alert + metric)

connection removed ──► openConnectionRemovalCleanup ─┐
DSAR erasure commits ─► openDsarErasureCleanups ─────┼─► OPEN record ─► attempt now
                                                     │        ▲
data-lifecycle (03:00) ──► retryOpenManagedAgentsCleanups ────┘ until DONE, or ABANDONED after 30 days
                      └──► reconcileLostSessionDeletes   (sessions recorded DELETED that still exist)
```

The split is global rule 2's. `src/lib/agentic/managed-agents/cleanup.ts` holds
the calls and no Prisma: a pass is given recorded session and agent ids, lists the
crash window by recorded agent, deletes sessions, archives agents, and returns a
named outcome per item. `src/app-layer/usecases/managed-agents-cleanup.ts` reads
what was recorded, builds the client through `managedAgentsClientFor`, and stores
the result on `ManagedAgentsCleanup`.

What is "recorded":

- **Sessions**: 5b's `managed-agents-session` SYNTHESIS steps on `MANAGED_AGENTS`
  runs. A session is still Inflect's to delete when it was CREATED and never
  DELETED, or KEPT, or its delete FAILED. A DSAR erasure takes the KEPT ones only.
  `inputJson` is encrypted and the label is not a column, so the steps are read by
  kind and driver in the tenant's own context and decided after decryption.
- **Agents**: `AgentProfileProvision`, distinct by agent id per connection.
- **The crash window**: 5b records `SESSION_CREATED` after `sessions.create`
  returns. The installed SDK (`@anthropic-ai/sdk` 1.8.0, as pinned) has
  `sessions.list({ agent_id, include_archived, 'created_at[lte]' })`, so sessions
  are listed ONLY by a recorded agent. A listed session is taken only when its
  metadata (`sessionMetadataFor`) names this tenant AND a run the tenant holds,
  checked against `WorkflowRun`. The client refuses a session list with no
  `agent_id` (`SESSION_LIST_NOT_BY_AGENT`).

Owner decision 7 (2026-11-22) governs the purge. The retry could only authenticate
after the purge by keeping the customer's key, so Inflect never keeps it. The purge
attempts once with the key as it stands, before its transaction, under a deadline.
What remains goes, ids only, to a retained record that is never marked done.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/managed-agents/cleanup.ts` | The pass: crash-window listing, session delete, agent archive, outcomes, deadline, halting on a refused key |
| `src/app-layer/usecases/managed-agents-cleanup.ts` | The three triggers, the retry, the reconciliation, the dedicated connection reader, the record writes |
| `src/lib/agentic/tool-runner/client.ts` | Two whitelist entries: `GET /v1/sessions` (with `agent_id` only) and `POST /v1/agents/{id}/archive` (no body) |
| `src/app-layer/usecases/tenant-purge.ts` | Calls the purge clean-up before the per-tenant transaction; retains `ManagedAgentsCleanup` |
| `src/app-layer/usecases/integrations.ts` | `removeIntegrationConnection` opens the clean-up after the disable commits |
| `src/app-layer/jobs/dsar-erasure.ts` | `eraseUser` runs the kept-session clean-up after its transaction commits |
| `src/app-layer/jobs/executor-registry.ts` | `data-lifecycle` retries OPEN records and runs the reconciliation |
| `src/lib/observability/integration-metrics.ts` | `agentic.managed_agents.cleanup`, `agentic.managed_agents.lost_delete` |
| `infra/observability/grafana/provisioning/alerting/alert-rules.yml` | Alerts on an unfinished or abandoned clean-up and a failed lost-delete |
| `prisma/schema/agentic.prisma`, migration `20261122180000_managed_agents_cleanup` | The new table, RLS triple, CHECKs, no DELETE for `app_user` |
| `tests/helpers/managed-agents-faux.ts` | List, retrieve with metadata, archive, seeded foreign objects, unreachable and refused modes |

## Decisions

- **One record table, not ledger rows.** The purge deletes `WorkflowStep` and
  `WorkflowRun`, so an outcome written there would be purged with the thing it
  reports on. `ManagedAgentsCleanup` is classed a Regulatory artefact and retained:
  it is the record that a processor was told to delete, and of what it did not.
  Its one FK is to the retained `Tenant` tombstone (RESTRICT); `connectionId` is a
  plain id.
- **`AgentProfileProvision` is not retained.** The clean-up reads it before the
  purge transaction starts, and the record keeps every agent id it could not
  archive. Retaining provisions would keep nothing more.
- **Purge records are terminal by construction.** A CHECK refuses an OPEN purge
  record, so the retry cannot pick one up.
- **`PURGED_KEY_DESTROYED_UNFINISHED` is for the purge alone** (CHECK). A retried
  record that gives up ends `ABANDONED`.
- **30 days to ABANDONED is an implementation decision of this step**, not an
  owner decision. A 401/403 stays retryable, as the brief requires. Without a
  limit, a key the customer revoked would keep a record open for ever.
  `CONNECTION_GONE` abandons at once, because a row that is gone does not come
  back.
- **Done means removed or a 404.** `AUTH_REFUSED`, `PROVIDER_UNREACHABLE`,
  `PROVIDER_ERROR`, `RATE_LIMITED`, `PROVIDER_REFUSED`, `DEADLINE`,
  `LIST_TRUNCATED` and `SESSION_STILL_RUNNING` all keep the item. A session is
  read before it is deleted: a running one is not interrupted by the clean-up,
  which cannot see the run, and is retried.
- **A refused key or an unreachable provider halts the pass.** Every later item
  gets the same outcome without being sent, so one outage does not spend the
  purge's deadline on retries.
- **An agent is archived only after its crash-window listing succeeded**, so a
  later pass can still list its sessions.
- **An empty population is DONE with the outcome `NOTHING_RECORDED`**, never a
  bare DONE (invariant 5's shape), and a ledger read past `LEDGER_READ_CAP` is
  `LEDGER_TRUNCATED`, never done.
- **Each record covers what was recorded when it opened** (`coversUntil`). The
  ledger is re-read on every retry for runs created by then, with what earlier
  passes found (crash window) added and what they removed subtracted. An
  in-flight run's later KEPT step is still found, and a re-enabled connection's
  new sessions are not.
- **The purge closes the tenant's open records** `SUPERSEDED_BY_PURGE`. Their
  pending ids go into the purge's own attempt, because the purge takes their key.
- **DSAR scope.** The owner decided "every tenant where the person held a
  membership". A `TenantMembership` row is a RESTRICT blocker of the erasure, so
  none exists when it runs. The tenants are therefore read off the subject's own
  audit rows, which the erasure already reads before it pseudonymizes them;
  accepting an invite is such a row. **Gap:** a person given a membership by SCIM,
  SSO or org provisioning who never acted in that tenant leaves no row naming
  them there, and that tenant is not reached. The record names tenants and
  connections, never the person.
- **DSAR erasure has no operator entry point.** `eraseUser` is still called by
  nothing in `src/`, so this clean-up is reachable from tests only until an
  operator entry point for erasure exists. It is wired into `eraseUser` itself
  (the `afterCommit` default), so that entry point inherits it.
- **The outcome column is `outcome`, not `reason`.** The encryption extension
  fans a write to a model outside the manifest across every manifest field name,
  and `reason` is one. The first build stored ciphertext there and its CHECK
  refused it.
- **The reconciliation looks back seven days** over sessions recorded DELETED,
  for tenants not soft-deleted (#5017's rule for cross-tenant connection reads).
  A failed delete is metered and alerted. The next run retries it while it is
  still inside the window.
- **Nothing makes the engine selectable.** `DRIVER_IMPLEMENTED['managed-agents']`
  stays false. In production, no session or agent exists for this step to
  remove until Step 5d.
- **A disconnected workspace's agents are archived.** An archived agent cannot
  start a new session. Re-enabling the same connection row later (an update by
  id) keeps its provision rows, which then name archived agents, so a run would
  fail. Step 5d or 5e must handle that: re-provision, or refuse by name.
