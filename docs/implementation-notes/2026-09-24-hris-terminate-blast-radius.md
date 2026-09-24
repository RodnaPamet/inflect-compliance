# 2026-09-24 — HRIS departure reconcile: a blast-radius bound

**Issue:** #2838

## The defect

`usecases/hris-sync` closes a pass by marking every `source: 'HRIS'` employee the
pass did not touch `TERMINATED`:

```ts
where: { tenantId, source: 'HRIS', status: { not: 'TERMINATED' }, syncedAt: { lt: passStartedAt } }
```

So **absence from a feed is departure from the company**, at that one statement,
with nothing able to tell the two apart. A transfer that changes which roster a
person appears in — a department-scoped feed, a report filter edited in the HRIS
— is indistinguishable from leaving.

That is not a mirror-only problem. `identity-leaver-pass` selects exactly
`status: 'TERMINATED'`, and on a tenant at `AUTOMATIC` that drives a real
`accountEnabled: false` against Entra or a `userAccountControl` write against a
domain controller, unattended. The hop is proven: an AD account was disabled by
the scheduled 05:00 pass on 2026-09-24 (#2749).

## What was already right

```ts
const passSawRows = roster.length > 0 || Boolean(conn.syncPassStartedAt);
```

This refuses the catastrophic shape — an empty or failed fetch does not wipe the
roster — and the `Boolean()` rather than `!== null` is load-bearing, because an
absent marker read as "resumed" would make the guard unconditional. It is
preserved verbatim and now carries a regression pin of its own, including the
resumed-pass counter-case.

The hole is narrower: the **partial** roster. Rows arrived, so the pass "saw
rows", but the set is a subset — the normal shape of a scoping change.

## Design

The reconcile is MEASURED before it is applied, inside the transaction that
already carried the sweep and the cursor clear:

1. lift the sweep's `where` to a name (`reconcileWhere`) so the count and the
   write are handed the SAME object — measuring one set and writing another is
   how a rail authorises a batch it never looked at (#2498);
2. `proposed = count(reconcileWhere)`; zero is always allowed;
3. `livePopulation = count({ tenantId, source: 'HRIS', status: { not: 'TERMINATED' } })`
   — the same table and source, one predicate narrower;
4. refuse the WHOLE sweep when `proposed > TERMINATE_SHARE_FLOOR && share > MAX_TERMINATE_SHARE`.

## Decisions

- **The numbers could not be measured, and saying so is the finding.** Read-only
  against production on 2026-09-24: `Employee` holds ONE row across ten tenants,
  `source = 'MANUAL'`; `source = 'HRIS'` is ZERO; there is no enabled HRIS
  connection at all (the two live `IntegrationConnection` rows are `entra-id`
  and `active-directory`). Positive control on the same session — `Control` 892,
  `ConnectedIdentityAccount` 37, `User` 24, `Tenant` 10, psql role is superuser
  so FORCE RLS is not filtering. A number presented as measured would have been
  invented.

  What the measurement DOES settle is which rail binds at today's scale: the
  nearest real population (37 directory accounts over ten tenants) puts a
  typical tenant in single digits, where 10% is below the floor and the share
  rule is silent by construction. The cap costs nothing today; it is calibrated
  for the first real roster.

- **The value is the sibling reconcile's.** `identity-sync`'s
  `MAX_DEPROVISION_SHARE` is 0.1 with `DEPROVISION_SHARE_FLOOR` 5, itself
  matched to the write breaker's `MAX_DISABLE_SHARE`. All three answer the same
  question; a third threshold would leave an operator holding three numbers with
  nothing to tell them apart. Separate CONSTANTS, because the cost of firing
  differs per rail and they must be free to move apart.

- **No absolute per-run cap** — the one place `checkDisableBlastRadius` does not
  fit. Its `MAX_DISABLES_PER_RUN = 50` counts an ACT and can go down; this
  number counts a STANDING BACKLOG (rows untouched since the pass began).
  Refusing does not clear it, so the count only grows, and an absolute cap over
  a growing count fires once then refuses forever while looking deliberate
  (#2290).

- **Per-tenant, forced rather than chosen.** `Employee` carries no
  `connectionId` column, unlike `ConnectedIdentityAccount` whose reconcile IS
  per-connection — there is nothing to scope by. What makes that safe is a rail
  one layer up: `upsertIntegrationConnection` refuses a second ENABLED HRIS
  connection per tenant, so the tenant's HRIS population and this connection's
  population are the same set by construction
  (`tests/integration/hris-connection-cardinality.test.ts`). A corollary worth
  recording: the issue's "a move to a business unit served by a different HRIS
  connection" variant cannot arise today for that reason.

- **Employees are left in their current status, not moved to an intermediate
  one.** `OFFBOARDING` exists in `EmploymentStatus` and is tempting, but it is a
  value the roster ITSELF writes — `providers/hris/employment-status.ts` returns
  it and the upsert mirrors `e.status` straight through. A reconcile writing
  `OFFBOARDING` would make a genuine feed-reported `OFFBOARDING`
  indistinguishable from "we refused to judge this row", destroying the signal
  an operator needs. It would also perform part of a probably-wrong action on
  exactly the input just declared untrustworthy — the argument
  `identity-write-breaker.ts` already makes against trimming to the cap.

- **Fails CLOSED, and the asymmetry is the argument.** On refusal the mirror
  over-reports people as present, so a real leaver's account is not disabled on
  schedule — a visible gap, recoverable by the next correct pass. The other
  direction is not recoverable on the same clock: a wrongful `TERMINATED` is
  read by the 05:00 pass before anybody reviews it, and re-enabling a disabled
  account is a human action in the customer's directory.

- **The refusal surfaces on four channels**, because one that only logs is one
  nobody sees: the `IntegrationExecution` row goes `PARTIAL` (never `PASSED`),
  carries the reason in `errorMessage` and
  `terminateRefused`/`terminateProposed` in `resultJson`; the run logs at WARN
  instead of the success INFO; and `errorMessage` + `departed` ride the returned
  `HrisSyncResult` for the queue. `clearAuthFailure` still runs — the roster
  read succeeded, so a "credential revoked" banner would be false.

- **The cursor is cleared on a refusal too.** The roster read FINISHED; it is
  the reconcile that was held, so there is no page to resume. Left set,
  `passStartedAt` would stay pinned to the refused pass's instant on every later
  run, and each pass would widen the set it proposes while never advancing.

- **The zero-roster arm deliberately still reports `PASSED`.** Aligning it with
  `identity-sync` (which reports `PARTIAL` + a `zero_enumeration` refusal there)
  is a real improvement but out of scope for #2838, and
  `tests/unit/roster-read-within-lock-lease.test.ts` pins the current `PASSED`.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/hris-sync.ts` | the two constants, the measured reconcile, the refusal surfacing |
| `tests/unit/hris-terminate-blast-radius.test.ts` | behavioural proof — refusal, allow, the two positive controls, the `passSawRows` regression pins |
| `tests/unit/sync-transaction-shape.test.ts` | `employee.count` added to the fake-db op census |
| `tests/unit/roster-read-within-lock-lease.test.ts` | `employee.count` added to the passthrough fake db |
