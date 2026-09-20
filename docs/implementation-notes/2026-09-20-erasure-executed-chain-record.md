# 2026-09-20 — a lawful erasure stops looking like tampering (#2682)

**Commit:** `(this branch) feat(audit): record DSAR erasures in the hash chain`

## The problem, restated precisely

DSAR erasure pseudonymizes by setting `AuditLog.userId → NULL`. `actorUserId` is
one of the ten `HASH_FIELDS` (`src/lib/audit/canonical-hash.ts`), and both chain
verifiers RECOMPUTE each `entryHash` from the row's current columns with
`actorUserId: row.userId`. So after a compliant erasure:

| | after a lawful erasure |
|---|---|
| stored chain | INTACT — the immutability trigger refuses any UPDATE that rewrites a hash |
| recomputed chain | BROKEN — `valid: false` at the first pseudonymized row |

`valid: false` with a `firstBreakAt` is exactly the signature
`tests/integration/audit-hash-chain.test.ts` uses to prove tampering is
detectable. The product could not distinguish "a data subject exercised their
right to erasure" from "someone altered the audit trail".

## The decision

Owner decision on issue #2682, 2026-09-20 — **record the erasure, and have the
verifier consult the record.** The three rejected alternatives and why are on
the issue. The property that makes this one right: the record is itself
hash-chained, so there is no second source of truth outside the chain's
protection.

Two constraints stated explicitly, both of which are where this could have
silently reintroduced the bug:

1. **Same transaction.** A record that could commit separately from the
   pseudonymization would leave de-attributed rows no record names — which is
   the bug, with extra steps.
2. **`userId`-only tolerance.** A general "ignore mismatches for listed rows"
   would let a tamperer hide arbitrary edits behind a lawful erasure.

## Design

### The commitment, and why a simpler design cannot work

The tolerance must accept only "the sole difference is `userId` going from the
hashed value to NULL". That cannot be verified directly: proving it needs the
old `userId`, and that is exactly what erasure destroys — SHA-256 does not give
it back.

So the record commits to the OTHER nine fields instead. For each named row it
stores

```
postErasureHash = H(actorUserId: null, + the row's nine other hashed fields
                    exactly as they stood at erasure time)
```

and the verifier — whose recomputation already uses `actorUserId: row.userId`,
i.e. NULL for a pseudonymized row — excuses the mismatch only when its own
recomputation equals that value. Any other edit to a named row changes the
recomputation and the tolerance refuses.

`postErasureHash` leaks nothing: it is a function of the POST-erasure row, so
anyone holding that row can recompute it. What it adds is WHEN it was computed —
inside the erasure transaction, inside the chain.

### The pre-erasure control does two jobs with one comparison

Before recording a tolerance for a row, `recordErasure` recomputes that row's
hash WITH the subject still attached and requires it to equal the stored
`entryHash`.

- **Security.** A row that already fails to recompute is already broken. Giving
  it a tolerance would let the erasure LAUNDER that break into a clean bill of
  health. Such rows are counted in `rowsWithoutTolerance` and named by nothing.
- **Derivation.** It proves the job reconstructs the writer's hash inputs
  exactly — in particular `occurredAt`, which the writer stores as
  `to_char(createdAt, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` and the job rebuilds
  from a `Date` through `toCanonicalTimestamp`. A wrong reconstruction shows up
  as "no row was excused", loudly, in the DB-backed test — never as a tolerance
  computed from the wrong bytes.

### Ordering, established rather than assumed

The record is appended at the TAIL of each tenant's chain. That is unaffected by
the pseudonymization: the trigger permits `userId` value → NULL and nothing
else, so no `entryHash` or `previousHash` anywhere moves, and the tip the entry
chains onto has the same hash it had before the erasure. The entry's own hash
therefore does not depend on whether it is written before or after the
`updateMany`.

It is written AFTER, for a different reason: the entry asserts these rows HAVE
been pseudonymized, and an assertion made before the statement that makes it
true is a prediction. The rows it names are READ before — `updateMany` returns a
count, not ids, and afterwards the rows are unfindable by `userId`.

The entry carries `userId: null` and `actorType: 'JOB'`. Had it carried the
subject, the `updateMany` (or the FK's `ON DELETE SET NULL`) would pseudonymize
the record itself — and the record is not in its own named set, so it would then
break the chain it exists to explain. It also would have re-identified the
subject in their own erasure record.

### Per tenant, because the chain is per tenant

A subject can have acted in several tenants, each with an independent chain. One
record in one tenant leaves every other tenant's verifier still reporting
tampering, so affected rows are grouped by `tenantId` and each group gets its
own entry in its own chain, naming only its own rows.

## Files

| File | Role |
|---|---|
| `src/lib/audit/erasure-record.ts` | NEW. The record's vocabulary, the payload builder, and the tolerance predicate — one implementation used by both verifiers. Carries the security argument. |
| `src/lib/audit/audit-writer.ts` | `appendAuditEntryWithin(tx, input)` extracted so a caller can append inside a transaction it already owns; `appendAuditEntry` is now that plus a transaction plus the outbound stream. `verifyAuditChain` consults the tolerance and reports `toleratedPseudonymizations`. |
| `src/lib/audit/verify.ts` | Same tolerance in `verifyTenantChain` — the verifier behind `GET /api/t/:slug/audit-log/verify`, i.e. the one an auditor actually runs. Range-filtered verifications issue one extra unfiltered lookup for the records, because the entry sits at the chain tail and a narrow window would not contain it. |
| `src/app-layer/jobs/dsar-erasure.ts` | `recordErasure` + the `findMany` that captures the rows to name; `ErasureDb` widened with the two raw methods the writer needs; receipt gains `erasureRecordIds` and `auditRowsTolerated`. |
| `tests/integration/dsar-erasure-audit-survival.test.ts` | The pinned test. Two assertions flipped deliberately; three live-tampering tests added. |
| `tests/helpers/dsar-erasure-probe.ts` | `UNVERIFIABLE_RAW_SQL` narrowed from "names AuditLog" to "could change or remove a row"; the `$queryRaw*` fake returns `[]` instead of `0`. |
| `tests/helpers/audit-cleanup.ts` | `tamperAuditRow` accepts `userId` and a NULL value, so "a userId nulled outside an erasure still breaks the chain" is provable AND restorable. |
| `tests/guardrails/dsar-workflow-coverage.test.ts` | B3 regraded: raw SQL by VERB and TABLE rather than by absence. |
| `tests/unit/dsar-erasure-execute.test.ts` | Fake widened; the call-order assertion now pins where the record sits relative to `updateMany` and `user.delete`. |
| `docs/dsar.md` | New subsection under audit-log pseudonymization. |

## Decisions

- **`verifyTenantChain` was taught too, though the decision named only
  `verifyAuditChain`.** `verify.ts` is what `GET /api/t/:slug/audit-log/verify`
  calls — it is how an auditor runs the verifier. Fixing only the other one
  would have left the user-facing half reporting tampering on a compliant
  system, which is the sentence the decision opens with. One shared predicate,
  two call sites.
- **The tolerance map is built from the rows already fetched**, not a second
  query, in the unfiltered case. There is no extra round trip and no second
  source of truth. `verifyTenantChain` issues the extra lookup only when a
  date range was asked for, and issues it AFTER the main query so callers that
  inspect `mock.calls[0]` still find the chain query there.
- **…and from the HASHED rows only.** The first cut read the tolerances off
  ALL rows, on the reasoning that a dishonest record breaks the chain at
  itself. It does not, if it carries no hash: both walks iterate the hashed
  subset, so a record with a NULL `entryHash` is never recomputed and never
  breaks anything, while still granting tolerances for rows the verifier DOES
  check — an unverified row excusing verified ones. That is not hypothetical:
  `entryHash` is nullable and `logAudit` plus the lifecycle jobs still
  `auditLog.create` rows with a caller-supplied `action` and no hash, which is
  why `unhashedEntries` is a counter rather than an impossibility. Both call
  sites now pass `hashedRows`, and the ranged lookup in `verify.ts` adds
  `AND "entryHash" IS NOT NULL`. `collectPseudonymizationTolerances` cannot
  enforce this itself — a `ChainRowForTolerance` carries no hash — so the
  restriction lives at the call sites and `tests/unit/audit-trail-verify.test.ts`
  pins each one against a hashed positive control.
- **A row named twice with different hashes is dropped entirely** rather than
  resolved to one of them. Two records disagreeing is not a state a lawful
  erasure can produce, and picking a winner would let a later forged entry
  overwrite an earlier honest one.
- **`appendAuditEntryWithin` does not stream to the SIEM.** `appendAuditEntry`
  streams after the commit, which is the only point the row is real; the
  in-transaction variant cannot know when (or whether) its caller commits, and
  streaming a row that then rolls back would tell a SIEM about an event that
  never happened. Said plainly in the function's docblock rather than left to be
  discovered.
- **The DB-free probe's raw-SQL rule was narrowed, not waived.** It fired on any
  raw statement naming `AuditLog`; the record must go through
  `appendAuditEntryWithin`, which is raw by construction and is the one writer
  `tests/guards/audit-structured-events.test.ts` permits. `UPDATE` / `DELETE` /
  `TRUNCATE` / `ALTER` / `DROP` still fire, and the probe's own C6 case — a raw
  `UPDATE "AuditLog" SET "userId" = NULL` — still reports `UNVERIFIABLE_RAW_SQL`.
- **The `$raw` surface test moved from counting to reading.** The survival
  suite asserted `touched` did not contain `$raw`; that and "route the record
  through the one sanctioned writer" cannot both hold. The teeth moved to the
  statements: no mutating verb, no table but `AuditLog`, plus a positive control
  that the audit INSERT really is in the graded population.
- **Restores in the tamper tests sit in a `finally`.** The first version
  restored on the happy path only; one test failed before its restore, left a
  `userId` NULL, and the NEXT test reported a `firstBreakId` that had nothing to
  do with what it had just done.

## What this does NOT claim

The chain is keyless. Anyone who can append to `AuditLog` can append a
well-formed `ERASURE_EXECUTED` entry at the tail and name rows they then
pseudonymize. That capability is not created here — it is the capability to
write audit entries at all, which the privilege gate restricts (`app_user` has
UPDATE on `AuditLog` revoked; erasure runs via `runInGlobalContext`). What this
removes is the FALSE POSITIVE, not the need for that gate.
