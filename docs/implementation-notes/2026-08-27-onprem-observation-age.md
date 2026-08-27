# 2026-08-27 — the on-prem observation gets an age

**Commit:** `<sha> fix(identity): refuse a stale on-prem observation, not just an absent one`

## The finding, and why it is real

`ConnectedIdentityAccount.onPremStateObservedAt` is a `DateTime` and its schema
comment says why: it records **when** a provider last actually answered "is this
account synced from on-premises?". Both consumers reduced it to a presence check:

```ts
onPremStateObserved: Boolean(r.connectedAccount.onPremStateObservedAt)   // findLeaverCandidates
onPremStateObserved: row.onPremStateObservedAt != null                   // createSnapshotWriter
```

`resolveWriteTarget` then **allows** a Graph disable for an Entra account whose
`onPremisesSyncEnabled` is `null` *provided that flag is true* — because for
Entra a null that was ASKED means "cloud-only", which is writable. So a stamp
from any point in the row's history authorised a write.

### The backstop that isn't one

The candidate query's `lastVerifiedAt >= staleBefore` looks like it bounds this.
It does not, because the two facts are refreshed by different passes at
different scopes:

| Fact | Written by | Scope |
| --- | --- | --- |
| `IdentityAccountLink.lastVerifiedAt` | `reconcileIdentityAccountLinks` | **provider** — `findMany({ where: { tenantId, provider } })`, every account row the tenant holds |
| `ConnectedIdentityAccount.onPremStateObservedAt` | `identity-sync` upsert | **connection** — only the accounts *its own* enumeration returned |

One healthy connection's `PASSED` sync therefore refreshes `lastVerifiedAt` on
links pointing at rows a **different** connection observed and has not touched
since.

### Why `AMBIGUOUS_CONNECTION` does not cover it

`resolveDirectoryWriter` refuses `AMBIGUOUS_CONNECTION` when a tenant has more
than one connection for a provider — and that refusal fires at step 5 of
`runIdentityLeaverPass`, before any writer exists, so the *two-enabled-connections*
shape is genuinely unreachable. It was the right thing to check first.

It counts only **enabled** connections. `removeIntegrationConnection` is a soft
disable — `isEnabled: false`, nothing deleted — and:

* the dispatch (`isEnabled: true`) stops syncing that connection, freezing its
  rows' `onPremisesSyncEnabled` / `onPremStateObservedAt`;
* the deprovision reconcile is `connectionId`-scoped, so nothing ever sweeps
  those rows to `DEPROVISIONED`; they stay `ACTIVE` indefinitely;
* the FK is `onDelete: Cascade`, so *deleting* a connection would have removed
  them — disabling one does not.

So: **one** enabled connection (no ambiguity refusal) + one soft-disabled
sibling = candidates carrying a months-old observation with a link stamped
fresh last night. That is the reachable shape, and it needs no unusual operator
behaviour — re-wiring an Entra app registration produces it.

### Why DRY_RUN is where it bites

Above `DRY_RUN` the live Entra writer re-reads Graph and builds its own capture,
so a stale stored stamp is corrected before `disable` gates on it. `DRY_RUN` is
the rung every tenant is clamped at (`LEAVER_MAX_MODE`), and there the snapshot
reader opens no socket — the stored stamp is the only evidence in existence.
The seven-day observation artefact an operator is asked to promote a tenant on
would read "would disable" for an account whose on-prem state was last seen in
January.

## Design

One number, two predicates, applied at both producers of the boolean.

```
identity-write-target.ts   OBSERVATION_FRESHNESS_MS  ← the number
                           isObservationFresh()      ← fail-closed predicate
        │
        ├── identity-leaver-pass.ts    LINK_FRESHNESS_MS = OBSERVATION_FRESHNESS_MS   (alias)
        ├── identity-disable-account.ts  findLeaverCandidates → the rail's input
        └── identity-writer-factory.ts   createSnapshotWriter → the parity capture
```

The column is untouched. It stays a `DateTime`: when a directory answered has
forensic value that a boolean cannot carry, and the schema comment explains why.
`isObservationFresh` is the *rail's reading* of the timestamp, not a replacement
for it.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/identity-write-target.ts` | Owns `OBSERVATION_FRESHNESS_MS` + `isObservationFresh`; refusal text now covers "too long ago" |
| `src/app-layer/usecases/identity-disable-account.ts` | `findLeaverCandidates` maps through the predicate against one batch-wide instant |
| `src/app-layer/integrations/identity-writer-factory.ts` | Snapshot capture uses the same predicate; `AMBIGUOUS_CONNECTION` doc corrected (it said `connectionId` was nullable — it is `NOT NULL` since phase 2) |
| `src/app-layer/usecases/identity-leaver-pass.ts` | `LINK_FRESHNESS_MS` becomes an alias; module header corrected on the same stale nullability claim |
| `tests/unit/identity-write-target.test.ts` | Predicate: boundary, absence, garbage, ISO strings, future stamps, and the rail consequence with its control |
| `tests/unit/identity-disable-account.test.ts` | Fresh/stale mapping, the stale row STAYING a candidate, the select shape, the one-number assertion |
| `tests/unit/identity-writer-factory.test.ts` | Snapshot parity on age; removed a hardcoded `2026-08-27` that would have become a time bomb |
| `tests/integration/identity-onprem-observation-seam.test.ts` | The third state through the real query and real rows, plus its fresh-stamp control |

## Decisions

* **A stale row stays a candidate; it is not filtered out of the query.**
  Excluding it would delete it from the dry-run artefact with no refusal
  recorded anywhere, which reads identically to "this worker had no directory
  account" — the silent-nothing failure this subsystem keeps re-learning.
  Kept, it reaches `resolveWriteTarget` and is refused *by name*, in a row an
  operator can see.

* **`LINK_FRESHNESS_MS` is an alias, not a second `2 * 24 * 60 * 60 * 1000`.**
  Two copies of a bound mean the weaker one silently governs what a pass will
  act on. They are separate *predicates* over separate facts, deliberately
  sharing one *instant*.

* **The bound is inclusive (`>=`)**, matching the reading
  `lastVerifiedAt: { gte: staleBefore }` already gives the link.

* **A future stamp counts as fresh.** Nothing writes one — `identity-sync`
  stores its own `now` — so a forward stamp is clock skew between the worker
  that synced and the pass that reads. Refusing on skew would make the rail
  inert for a reason that has nothing to do with the directory.

* **One clock read per batch**, not per row, so a long page cannot straddle the
  boundary and have two accounts from the same sync disagree about it.

* **The snapshot capture was changed too, though nothing reads it yet.** Its
  existing comment states the case: `EntraIdDirectoryWriter.disable` gates on
  `priorState.onPremStateObserved !== true`, that gate is unreachable in DRY_RUN
  only because the usecase returns first, and hoisting it above the network is
  the natural next edit. A capture answering on presence while the rail answers
  on age would then refuse different accounts than the candidate query does,
  with each defensible on its own terms.

* **Two stale comments were corrected in passing**, both asserting
  `ConnectedIdentityAccount.connectionId` is nullable and that this is why the
  writer is resolved per provider. The column has been `NOT NULL` since phase 2;
  the real reason is that the *writer* is still per (tenant, provider). Those
  comments are what a future reader re-deriving this analysis would trust, and
  one of them is why the multi-connection shape looked unreachable.

## Not done here

`reconcileIdentityAccountLinks` remains **provider-scoped** while every other
write on this path is connection-scoped. That is the root cause; the age bound
is a rail in front of it. Making the reconciler connection-scoped touches link
creation, contradiction marking, and the `IdentityAccountLink.connectedAccountId`
unique — a larger change with its own migration questions about links to rows
whose connection is disabled. Worth filing separately.

A soft-disabled connection also leaves its `ConnectedIdentityAccount` rows
`ACTIVE` forever, which inflates the breaker's `population` count and can yield
two candidates for one human. Also out of scope here.
