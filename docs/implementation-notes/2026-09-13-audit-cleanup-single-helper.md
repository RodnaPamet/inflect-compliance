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

1. **CLEANUP** — `deleteAuditRowsForTenants` / `deleteAuditRowsByActionLike` /
   `deleteOrgAuditRowsForOrganizations`, all routed through one private
   `withAuditTriggersDisabled`. The bulk: 121 call sites.
2. **TAMPER** — `tamperAuditRow` / `tamperOrgAuditRow`, also under the bypass.
   The hash-chain suites forge a stored column and assert the recorded
   `entryHash` no longer matches, i.e. that tampering is detectable. Forging
   requires the trigger off. 3 call sites.
3. **REFUSAL** — `attemptAuditUpdate` / `attemptAuditDelete`, deliberately
   WITHOUT a bypass. These are the detector for the trigger itself:
   `audit-immutability.test.ts` asserts they reject with `IMMUTABLE_AUDIT_LOG`.
   12 call sites. Giving these a bypass would delete the only evidence the
   trigger works — the same reasoning the guard file already records for the
   DSAR erasure oracle.

121 + 3 + 12 = **136 call sites across 103 files under `tests/`** (101 of those
are jest suites; `global-teardown.ts` and `stress/helpers/stress-env.ts` are
not), counted on the branch
rather than inferred from the base-commit statement count — the two are not the
same number, because three sites that had no literal statement at base (the
interpolated-table files) acquired one, and `#2531`'s teardown landed after the
base commit. The 136 is one grep for the seven exported names against the
working tree; the statement counts are one grep against `f31514057`, which is a
commit this branch has merged past — both are derivable, but only one of them is
derivable from the thing the heading is describing.

The two pre-existing raw-SQL scans in
`tests/guards/audit-immutability-guardrails.test.ts` widen from `['src']` to
`['src', 'tests']`, with that one module exempt (two further scans join them —
the interpolated-table shape below, and TRUNCATE). The
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

## Three more spellings the regex could not see (found in review)

An adversarial review of the PR ran four mutations the author had not, and three
came back GREEN against the patterns first shipped here. None is exotic:

| spelling | why it missed | status |
| --- | --- | --- |
| `DELETE FROM "OrgAuditLog" …` | both literal patterns required `AuditLog` directly after the optional quote; the interpolated scan requires a `${` | **fixed** — `(?:Org)?` |
| `DELETE FROM "public"."AuditLog" …` | same, with a schema qualifier in the way | **fixed** — optional qualifier |
| `TRUNCATE TABLE "AuditLog"` | no pattern existed, and a BEFORE-**ROW** trigger never fires on a statement-level TRUNCATE — so this one needs no bypass at all | **fixed** — `RAW_TRUNCATE` + its own scan |

The Org one is the finding that mattered, because this PR is what brought
`OrgAuditLog` into scope (`deleteOrgAuditRowsForOrganizations`,
`tamperOrgAuditRow`, and the migrated Org sites) — so this PR was the one leaving
that trail unguarded. A complete `SET LOCAL session_replication_role = 'replica'`
transaction around a literal Org delete, dropped into an ordinary test file, left
the guard suite 11/11 green. With the fix it is RED, naming that file; the
byte-identical statement inside the helper stays green, so the derived exemption
still covers what it is meant to.

Widening cost nothing: across the whole scanned population not one existing file
newly matches, and the only literal Org statement in the repo is the helper's
own, already covered by the derived exemption.

**The fourth mutation is still open, and is recorded rather than fixed.**
`AUDIT_TABLE_AS_STRING` is evaluated per-file, so the interpolated-table scan
only fires while the table-name array and the `DELETE FROM "${table}"` that
consumes it sit in the SAME file. Re-run here against the **widened** patterns
rather than quoted from the review — the list in one new module, the loop in
another — and the guard is still GREEN 13/13. That is precisely the shape this
PR exists to close,
and its closure here is an accident of co-location: moving `TENANT_CHILD_TABLES`
into a shared constants module would reopen it silently. Closing it needs import
resolution rather than another regex, so the guard header states it as a live
residual instead.

## Files

| file | role |
| --- | --- |
| `tests/helpers/audit-cleanup.ts` | NEW. The sole sanctioned raw audit DML, and the only `session_replication_role` set for it |
| `tests/guards/audit-immutability-guardrails.test.ts` | raw scans widened to `['src','tests']`; derived exemption; scans for the interpolated-table and TRUNCATE shapes; exemption self-check; pattern discrimination proof |
| `tests/e2e/global-teardown.ts` | `'AuditLog'` removed from `TENANT_CHILD_TABLES`; helper called before the loop so the Tenant DELETE is not blocked |
| 102 other files under `tests/` | migrated to the helper |

**103 migrated files, 105 `.ts` files changed.** The three rows above account for
the difference: the helper is new and the guard is not a migrated call site, and
`global-teardown.ts` is one of the 103, listed separately because its change is
not the ordinary one. An earlier revision of this table left the reconciliation
implicit and the "102" was read as the migration total in three other places.

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
not just audit rows.

Classified mechanically at the base commit, the 134 statements are three
different things: **113** carried the bypass and worked, **12** are the
immutability assertions (deliberately unbypassed, asserting the trigger
refuses), and **9** were simply BROKEN — no replica-role transaction anywhere,
so the statement raises the moment the table is non-empty. Be exact about the
shape of those nine, because "9 files carrying a raw audit DELETE" is not what
the set difference says: **eight** files carry a raw `DELETE FROM "AuditLog"`
with no bypass (one statement each), and the ninth is an `UPDATE "AuditLog"` —
the DSAR oracle, on a mocked client. So eight reach a real database and now work
through the helper; the ninth reaches none and stays put. The guard header names
all nine.

An earlier draft of this note said "24", carried forward from a classification
that counted `withTriggerDisabled(async (tx) => …)` as unbypassed. It is a
local wrapper whose own body sets the replica role, so those sites always
worked. The number above is re-derived from the base commit.

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
