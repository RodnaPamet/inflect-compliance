# 2026-08-18 — sync conflict policy, and the seam ServiceNow-outbound would commission

**Commit:** `(this PR)` feat(servicenow): conflict policy — every resolution is recorded

## The policy

A **conflict** is two systems of record holding different values for the same
field of the same entity, where both changed since the last sync. Resolving one
means **discarding one side's value**. In a product whose audit trail is
hash-chained specifically because divergence between records matters, that
cannot be something which happens quietly.

The strategy is per-mapping, on `IntegrationSyncMapping.conflictStrategy`,
defaulting to `REMOTE_WINS`:

| strategy | behaviour | when it is right |
|---|---|---|
| `REMOTE_WINS` | the remote value is taken; the local edit is discarded | the remote is the system of record for this entity — ServiceNow owns change records, we mirror them |
| `LOCAL_WINS` | the local value is kept; on PUSH it overwrites the remote, on PULL the incoming value is dropped | we are the system of record and the remote is a projection |
| `MANUAL` | the mapping is parked in `CONFLICT` with `errorMessage`, and neither side is applied | a human must adjudicate; nothing is lost, but the sync stops for that entity until someone acts |

`REMOTE_WINS` is the default because the first users of this seam are inbound
mirrors of a remote system of record. That default is **wrong** for any entity a
person edits in our UI, and choosing it there silently deletes their work every
sync — which is why the rate is now measurable per resolution rather than only
per conflict.

## Every resolution is recorded, and it cannot be switched off

`integration.sync.conflict` — a counter, labelled `provider` / `direction` /
`resolution`. Emitted from `BaseSyncOrchestrator.resolveConflict`, the single
point every resolution passes through.

**It is deliberately not routed through the orchestrator's injectable
`SyncEventLogger`,** and that is the defect this closes rather than a style
preference. That logger defaults to `noopSyncLogger`, so an orchestrator
constructed without an explicit logger discarded every conflict. The two wired
callers (`jobs/sync-pull.ts`, `usecases/webhook-processor.ts`) each pass one
only because somebody remembered to. A signal that is switched off by
*forgetting to switch it on* is not a signal — and the thing it exists to
surface is invisibility itself.

The structured log stays alongside it. They answer different questions: the
counter says *this is happening, how often, and which way it is being resolved*;
the log says *to what*. The counter deliberately carries no mapping id, entity
id or field names — a counter label is a metric series, and putting an entity id
on one is how an observability change becomes the outage.

`local_wins` / `remote_wins` are the rates worth alerting on, because they
resolve **silently**. `MANUAL` at least parks the mapping somewhere a person
will meet it.

## The risk finding behind the bidirectional decision

The roadmap described ServiceNow-outbound as *"the first connector that WRITES
to a remote system"*. That is false — SharePoint writes to Graph today from
user-triggerable routes. The correction is sharper than the claim:

- `BaseSyncOrchestrator.push()` (`sync-orchestrator.ts:236`) has **zero callers
  in `src/`**. Only `pull()` and `handleWebhookEvent()` are wired.
- SharePoint explicitly **refuses** the generic CRUD contract — its
  `createRemoteObject` / `updateRemoteObject` throw.
- `IntegrationSyncMapping.conflictStrategy` and `.version` are unexercised on
  the push path.
- The other write-capable client (GitHub) is not reached from any live path.

So ServiceNow-outbound is not "the first write". It is **the first user of an
unexercised seam** — a contract that exists, looks supported, and has never run.
That is a worse risk profile than "new code", because new code is not assumed to
work.

**The bidirectional decision stands** (it was made explicitly, and this note is
not a reversal). What the finding changes is sequencing and expectation:

- The inbound half is fully paved: twelve providers exercise registry → runCheck
  → mapResultToEvidence → evidence, with zero new seams. ServiceNow inbound
  added none.
- The outbound half means **commissioning `push()` as its first customer**, plus
  a trigger surface, a field-mapping UI and status-back — the remaining three
  roadmap items land together, not independently.

The prompt's own ordering (inbound first) is therefore right, and matters more
than it appeared to when it was written.

## Files

| file | role |
|---|---|
| `src/app-layer/integrations/sync-orchestrator.ts` | `resolveConflict` now records; `direction` threaded from both call sites |
| `src/lib/observability/integration-metrics.ts` | `recordSyncConflict` — the counter |
| `tests/unit/sync-conflict-policy.test.ts` | eight assertions, the load-bearing one being "records when no logger was injected" |

## Decisions

- **Counter, not audit row, for the resolution itself.** A conflict is an
  operational event about a *sync*, not a change to a compliance record — the
  underlying entity write already audits. Putting every `REMOTE_WINS` into the
  hash-chained trail would bury real entity history under sync noise. If
  `MANUAL` conflicts later need adjudication history, that belongs on the
  mapping row where the decision is made, not on the resolution.
- **`direction` is a label.** `local_wins` on a PULL discards the incoming
  remote value; on a PUSH it overwrites the remote. Same resolution, opposite
  consequence — an undirected count would be unreadable.
- **An unrecognised strategy resolves `remote_wins` and is still recorded**,
  matching the column default. A bad value should appear as a rate, not as
  silence.
