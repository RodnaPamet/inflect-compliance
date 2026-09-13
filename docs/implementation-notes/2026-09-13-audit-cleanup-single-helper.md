# 2026-09-13 — one audited helper for audit-trail cleanup in tests (#2523)

## Design

`AuditLog` and `OrgAuditLog` carry `BEFORE DELETE OR UPDATE … FOR EACH ROW`
triggers that raise SQLSTATE 23001 unconditionally. Tests nevertheless need the
rows gone, and the repo had grown a working bypass: a transaction that first
runs `SET LOCAL session_replication_role = 'replica'`, which turns the trigger
off for its duration.

Measured at the base commit (`f31514057`), by git rather than by hand:

| population | count |
| --- | --- |
| files under `tests/` using `session_replication_role` | 95 |
| files under `tests/` with a raw `DELETE … "AuditLog"` | 96 |
| raw audit DML statements under `tests/` (DELETE + UPDATE, both tables) | 134 in 100 files |
| files under `src/` with either idiom | **0** |

That is a different finding from #2510's. Those 25 Prisma-verb calls could
neither fail nor succeed; this bypass visibly works. The owner's decision was to
ALLOW it through exactly one documented helper and forbid the idiom everywhere
else — not to forbid it plus add a reaper, and not to change the foreign key.

**`tests/helpers/audit-cleanup.ts`** is that helper, and it is the only place in
the repo that writes raw SQL against an audit trail. It carries three groups of
entry point, because three different jobs need raw audit DML and a guard with a
single exemption only works if all three live behind it:

1. **CLEANUP** — `deleteAuditRowsForTenants` / `…ById` / `…ByActionLike` /
   `deleteOrgAuditRowsForOrganizations` / `…ById`, all routed through one private
   `withAuditTriggersDisabled`. The bulk: 118 statements.
2. **TAMPER** — `tamperAuditRow` / `tamperOrgAuditRow`, also under the bypass.
   The hash-chain suites forge a stored column and assert the recorded
   `entryHash` no longer matches, i.e. that tampering is detectable. Forging
   requires the trigger off. 3 statements.
3. **REFUSAL** — `attemptAuditUpdate` / `attemptAuditDelete`, deliberately
   WITHOUT a bypass. These are the detector for the trigger itself:
   `audit-immutability.test.ts` asserts they reject with `IMMUTABLE_AUDIT_LOG`.
   12 statements. Giving these a bypass would delete the only evidence the
   trigger works — the same reasoning the guard file already records for the
   DSAR erasure oracle.

The two raw-SQL scans in `tests/guards/audit-immutability-guardrails.test.ts`
widen from `['src']` to `['src', 'tests']`, with that one module exempt. The
exemption is **derived**: the helper exports its own `__filename` as
`AUDIT_CLEANUP_MODULE` and the guard runs it through `repoRelative`, exactly the
way it already resolves its own SELF skip. There is no allowlist array of
filenames — a rename moves the exemption with the file, and a deletion breaks
the guard's import rather than silently widening what is permitted.

## The spelling the regex could not see

`RAW_DELETE` wants a literal `DELETE FROM "AuditLog"`. Three files wrote the
same statement with the table name interpolated from a list:

```ts
const TENANT_CHILD_TABLES = [ …, 'AuditLog', … ];
for (const table of TENANT_CHILD_TABLES) {
    await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = $1`, id);
}
```

`tests/e2e/global-teardown.ts`, `task-source-reconcile-invariants.test.ts` and
`vendor-assessment-lifecycle.test.ts`. A widened textual scan reads all three as
clean. This is the raw-SQL twin of the `DYNAMIC_MODEL_INDEX_WRITE` shape #2510
recorded, so it gets the same treatment: a third scan,
`RAW_DML_ON_INTERPOLATED_TABLE` AND `AUDIT_TABLE_AS_STRING`, both halves
required. `'AuditLog'` was removed from all three lists and the helper called
explicitly instead.

**The first draft of that pattern was wrong in an instructive way.** Its UPDATE
arm was an unanchored `UPDATE\s+["'\`]?\$\{`, and it matched

```
`AMW Risk Update ${testRunId}`
```

— an English fixture title in `audit-middleware.test.ts`, three times in that
one file. "Update " before an interpolation is prose; `UPDATE "<x>" SET` is not.
The UPDATE arm now requires the trailing `SET`. `DELETE FROM` is specific enough
to stand alone.

## Files

| file | role |
| --- | --- |
| `tests/helpers/audit-cleanup.ts` | NEW. The sole sanctioned raw audit DML, and the only `session_replication_role` set for it |
| `tests/guards/audit-immutability-guardrails.test.ts` | raw scans widened to `['src','tests']`; derived exemption; third scan for the interpolated-table shape; exemption self-check |
| 99 files under `tests/` | migrated to the helper |
| `tests/e2e/global-teardown.ts` | `'AuditLog'` removed from `TENANT_CHILD_TABLES`; helper called before the loop so the Tenant DELETE is not blocked |

## Decisions

- **Lifted, not wrapped.** A helper that owns its transaction cannot be called
  with an interactive `tx` (Prisma's `ITXClientDenyList` removes `$transaction`,
  so `tsc` refuses it). Sites whose bypass transaction also deleted other tables
  keep that transaction and call the helper immediately before it. Those other
  tables disable a *different* trigger — the last-OWNER guard on
  `TenantMembership` — which is not this module's business and not policed.

- **Error handling preserved exactly.** 11 of the migrated deletes were
  `.catch()`-swallowed at HEAD, 4 of them because the catch sat on the
  transaction the statement was lifted out of. Those 4 had the catch restored on
  the helper call. The intended behaviour change is that the delete now *works*,
  not that a best-effort teardown now fails a suite.

- **No "delete everything" selector.** Every entry point is closed over a scope
  the caller owns. A bare `DELETE FROM "AuditLog"` on the shared `inflect_test`
  database is a different and much worse operation than the one this exists for.

- **Six hoists out of a loop were wrong, and `tsc` found four of them.** The
  mechanical transform moved a statement out of the `for` that bounded its loop
  variable. Four failed to compile (`Cannot find name 'tid'`); the other two were
  correct by construction because their loop enclosed the whole transaction.
  Auditing the remaining hoists against the loop structure at HEAD — rather than
  trusting the green `tsc` — is what closed that out.

## The tenant leak, measured

`AuditLog_tenantId_fkey` is ON DELETE RESTRICT, so audit rows a teardown failed
to delete also block its own `Tenant` delete: a suite leaks a Tenant row per run,
not just audit rows. 24 sites had a raw audit DELETE with no bypass at all, which
raises the moment the table is non-empty.

`tests/integration/audit-middleware.test.ts` run serially against the shared
`inflect_test`, counting tenants whose slug matches `amw-%`:

| run | teardown | `amw-` tenants | their audit rows | `AuditLog` total |
| --- | --- | --- | --- | --- |
| baseline | — | 1 | 0 | 184 |
| at HEAD | bare raw DELETE | **2** (+1) | **8** (+8) | **192** (+8) |
| with helper | bypass works | 2 (+0) | 8 (+0) | 192 (+0) |
| with helper, again | bypass works | 2 (+0) | 8 (+0) | 192 (+0) |

The suite reported 9/9 passing in every one of those runs, including the two
that leaked. The pre-existing `amw-e6567b84…` row in the baseline column is a
leak from some earlier run by somebody else — the behaviour in the wild, not a
fixture.
