# 2026-10-09 — Per-run resolutions and the durable crosswalk (Step 3c)

**Commit:** `(pending) feat(legacy-access): per-run resolutions and the durable crosswalk (Step 3c)`

## Design

```
runLegacyReconcile(ctx, { snapshotId })
        │
        ├─ IntegrationExecution (RUNNING)   ── the run IS this row
        │
        ├─ GATE 1  snapshot.status === COMPLETE   ─┐
        ├─ GATE 1b snapshot.rowCount > 0          ├─ refuse, write NOTHING
        ├─ GATE 2  latest HRIS sync PASSED        ─┘   (execution → PARTIAL)
        │          within ROSTER_FRESHNESS_MS
        │
        ├─ accounts  ← LegacyAccount (this snapshot)
        ├─ roster    ← Employee
        ├─ directory ← ConnectedIdentityAccount + IdentityAccountLink   READ ONLY
        │               GATE 3, per link: lastVerifiedAt fresh AND contradictedAt null
        ├─ aliases   ← LegacyIdentityAlias WHERE status = ACTIVE        READ ONLY
        │
        ├─ reconcile({ ..., config: step4aExtensions(roster, convention) })
        │
        ├─ LegacyAccountResolution × N   (chunks of 500, keyed per RUN)
        └─ execution → PASSED + metric per outcome
```

Gates 1 and 2 refuse the whole run. There is no partial reconciliation, because a
partial one produces resolutions for some accounts and silence for others — and
silence is indistinguishable from `UNMATCHED` on the surface a reviewer reads.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/legacy-access.prisma` | `LegacyAccountResolution` (immutable, per run) + `LegacyIdentityAlias` (durable crosswalk) |
| `prisma/schema/enums.prisma` | `LegacyResolutionOutcome`, `LegacyMatchMethod`, `LegacyAliasStatus` |
| `prisma/migrations/20261009080000_legacy_resolutions_and_crosswalk/` | Both tables, three enums, the RLS triple on each, and `@@unique([id, tenantId])` on `IntegrationExecution` |
| `src/app-layer/usecases/legacy-reconcile.ts` | The three gates, the readers, the run writer |
| `src/lib/observability/integration-metrics.ts` | `recordLegacyReconcileOutcomes` + `recordLegacyReconcileRefused` |

## Decisions

- **`IntegrationExecution` IS the run.** It already records when the run started,
  when it finished, what triggered it and how it ended. Inventing a sibling table
  to mean the same thing is how two records of one event come to disagree.

- **Resolutions are keyed `(executionId, accountKey)`, not
  `(snapshotId, accountKey)`** — and this is where the design document and the
  step brief appear to differ. The design says "one immutable result per account
  per *snapshot*"; the brief's hardening says "a second run writes a new set and
  never updates the old one". Those cannot both be uniqueness constraints: per
  snapshot, a second run must either update or be refused, and the hardening rules
  out updating. So the brief's reading is operative and the design's phrasing is
  read as "scoped to the snapshot it resolved". Recorded per global rule 1.

- **No update seam, deliberately.** "Why was this account suggested to that person
  in March?" is a question about what the engine saw in March — the roster has
  since moved, links have gone stale, aliases have been confirmed. An updated row
  cannot answer it.

- **The roster gate reuses `OBSERVATION_FRESHNESS_MS`** rather than defining its
  own number. The design says it is "modelled on `NO_FRESH_LINKS`", both feeds are
  nightly (HRIS 04:00, directory 03:00), and two days tolerates one missed night.
  Two constants expressing one idea — "somebody re-observed this recently" — would
  drift apart silently, and the drift would show as a reconciliation trusting a
  roster the leaver pass had already given up on.

- **The freshness constant is imported from `identity-write-target.ts`, not from
  `identity-leaver-pass.ts`**, following the joiner's precedent. Importing the pass
  drags the writer factory, both provider writers and `undici` into the graph for
  one number — and for THIS module that is sharper than graph size: legacy code
  must never write a directory table, so pulling the writer factory into its
  import graph is the wrong direction even with no call site.

- **A refusal records `PARTIAL` on the execution, not `ERROR`.** The run reached a
  verdict about whether it was safe to resolve, which is what it was asked to do.
  `ERROR` reads as "the reconciler is broken" on a surface where "the roster is
  stale" is the actionable fact.

- **Only `TERMINATED` maps to the engine's `'TERMINATED'`.** `ONBOARDING`,
  `OFFBOARDING` and `LEAVE` are all `'ACTIVE'`, matching what the leaver pass
  treats as terminated. Somebody on leave is still a person who can own an account,
  and calling them terminated would trip the temporal veto and manufacture an
  orphan.

- **`linkedEmployeeId` is null unless the link is FRESH.** Leaving the id present
  alongside `linkFresh: false` would leave correctness to whoever remembered to
  read the pair together.

- **Unlinked directory accounts are still passed in**, with `linkFresh: false`.
  The engine needs to know a login EXISTS in the directory to tell "ambiguous
  across connections" from "unknown"; dropping them would make every unlinked
  login look absent.

- **Two same-named `CanonicalAccount` types**, and the import is aliased because
  of it. The engine's is its INPUT shape — eight fields, `createdAt` an ISO
  string. `lib/legacy-access/canonical`'s is 2a's STORAGE shape — seventeen
  fields, `createdAt` a `Date`, and the exact shape the payload hash is defined
  over. Importing both unaliased compiles until one gains a field.

- **Evidence is stored as JSON.** Its shape is the engine's, not the database's: a
  signal is `{ kind, score, evidence }` and a candidate carries its own signals and
  vetoes. Normalising it would fix a shape 4a already extended once and 6b extends
  again, and the only query anybody runs is "show me why this resolved this way".

- **Plaintext, and that is a decision.** The evidence carries emails, employee
  numbers and account keys, because those ARE the evidence for the four strong
  signals. Same call as `ConnectedIdentityAccount.email` and 2a's `LegacyAccount`:
  the surface that exists to show a reviewer WHY cannot show them an opaque blob.
  `note` and `suspendedReason` are justified in `NOT_SENSITIVE` — both are
  system-generated, and the engine writes exactly one shape into `note`
  (`service token: <token>`, from the connection's own configuration).

## What the tests prove, and that they have teeth

36 assertions across two suites. Every gate mutation-proves: removing the
`COMPLETE` check reddens 3, the roster gate 3, per-link freshness 1, the
contradiction check 1, and the active-alias filter 1. Disabling RLS on the two new
tables reddens 12 of the 14 isolation assertions — the 2 that hold are the
unique-constraint and composite-FK cases, which correctly do not depend on it.

Three assertions carry explicit denominators, because each would otherwise pass
for a feature that never works at all: a fresh uncontradicted link DOES bridge, a
fresh PASSED sync from each of the three HRIS providers DOES resolve, and the
directory tables come out **byte-identical** after a run rather than merely
un-deleted.
