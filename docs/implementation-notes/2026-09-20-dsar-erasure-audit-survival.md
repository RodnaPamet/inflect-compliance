# 2026-09-20 — DSAR erasure: audit-row survival, the per-table split, and a chain finding

Closes the behavioural half of #2287 Stage 3. Two clauses were outstanding and
both are now covered by `tests/integration/dsar-erasure-audit-survival.test.ts`:
the rows-survive-with-`userId IS NULL`-**and-hash-chain-intact** assertion, and
the pseudonymize-vs-delete split asserted **per table** rather than as one
blanket claim.

## The gap, measured at the base commit

16 suites under `tests/integration` reference `entryHash` or `verifyAuditChain`.
**None of them runs `eraseUser`.** One suite runs `eraseUser` —
`dsar-erasure-rollback.test.ts` (#2651) — and it seeds its audit rows by raw
INSERT, so their `entryHash` is NULL and `verifyAuditChain` skips them. The two
populations were disjoint, so the chain question had never been asked.

## The finding: "hash chain intact" is two properties, and erasure splits them

Measured against real Postgres on a four-row chain (one SYSTEM row, two rows
attributed to the subject, one to a bystander), seeded through `appendAuditEntry`
so the rows are genuinely hashed:

| | before erasure | after erasure |
| --- | --- | --- |
| stored `entryHash` / `previousHash` | — | **identical, byte for byte**, every row |
| `previousHash[i] === entryHash[i-1]` | holds | **still holds** |
| `verifyAuditChain(...).valid` | `true` | **`false`**, `firstBreakAt` = the first pseudonymized row |

The stored chain survives because the database enforces it:
`audit_log_immutable_guard()` (20260917130000) permits an UPDATE only when
`to_jsonb(NEW) - 'userId' = to_jsonb(OLD) - 'userId'`, so a pseudonymization that
rewrote a hash is refused. History cannot be forged in the name of erasure.

Verification fails because `verifyAuditChain` does not read the stored links — it
**recomputes** each `entryHash` from the row's current columns, and `actorUserId`
is one of the ten `HASH_FIELDS` (`src/lib/audit/canonical-hash.ts`). A row hashed
while `userId` held the subject cannot recompute to its stored hash once `userId`
is NULL.

**So a lawful GDPR erasure is today indistinguishable from tampering to the only
chain verifier this product has** — it produces exactly the signature
`audit-hash-chain.test.ts` uses to *prove* tampering is detectable
(`tamperAuditRow` + a failed `verifyAuditChain`).

This note records the finding; it does not fix it, because every available repair
is a decision somebody has to take on the record:

- drop `actorUserId` from the hash — blinds the chain to an actor swap, and
  invalidates every hash already written;
- re-hash the pseudonymized row — precisely the forgery the trigger refuses;
- teach the verifier to accept a NULL `userId` — it would accept one from a
  tamperer too, unless erasures are recorded somewhere the verifier can check.

The test **pins** the current behaviour rather than papering over it, so a fix
must come through it and flip an assertion deliberately.

## The second finding, and it came from a mutation

`AuditLog_userId_fkey` is `ON DELETE SET NULL`
(`20260308190244_init/migration.sql:927`). Neutering the `where` on
`eraseUserWithin`'s `auditLog.updateMany` so it matched nothing left **every**
end-state assertion green except the receipt count: deleting the `User` row nulls
the attribution by itself, and that FK-driven UPDATE satisfies the immutability
trigger because it is exactly the permitted shape.

"The rows survive with `userId IS NULL`" is therefore **over-determined** — it is
true of an erasure whose pseudonymization step does nothing at all. The test now
carries the two things that discriminate: the receipt's own
`auditRowsPseudonymized` count (which an FK cascade cannot inflate) and the
recorded op ORDER (`auditLog.updateMany` is issued before `user.delete`).

This is not a defect in `eraseUser`. Belt and braces is right: the FK is what
makes a half-run erasure impossible to leave behind, and the explicit
`updateMany` is what produces auditable evidence of how many rows were affected.
But a test grading only the end state would certify the FK while claiming to
certify `eraseUser`.

## The per-table split, with a derived denominator

The table surface is **recorded from the run**, not listed in the test: the client
handed to `eraseUser` is a pass-through proxy over a real Prisma client that logs
every `(delegate, method)` pair. Denominator: **2 tables** — `auditLog`
(`updateMany` only, never a delete verb) and `user` (`findUnique` + `delete`),
each checked against the disposition declared for it in `ERASURE_DISPOSITIONS`. A
cascade that widened to a third table fails the surface test rather than going
unchecked.

**That covers a raw-SQL widening too, because the proxy was written to make it.**
An `$executeRawUnsafe` goes through no model delegate, so a proxy that bound every
`$`-prefixed method straight through to the target would record nothing and the
surface would still read `['auditLog', 'user']` — true of the first draft, and it
would have made the sentence above false for exactly the escape hatch a
hand-written cascade reaches for. Every `$` call except `$transaction` (recursed
into) and `$connect` / `$disconnect` (lifecycle, they reach no table) is now
recorded as `table: '$raw'` and then executed unchanged, the way the sibling probe
at `tests/helpers/dsar-erasure-probe.ts:314` already records it. `$raw` is not a
key of `ERASURE_DISPOSITIONS`, so it reddens the surface test on arrival. Proven
by mutation: an `$executeRawUnsafe` UPDATE added to `eraseUserWithin` turned
`TABLE SURFACE` red on `['$raw', 'auditLog', 'user']`; removed again, green.

What is still outside the net, stated rather than left to be found: a cascade that
reached a client the proxy never wrapped — a module-level `@/lib/prisma` import
instead of the injected `db` — is invisible here, because the recording begins at
the injection seam. That seam is the one `dsar-workflow-coverage.test.ts` covers,
by `jest.mock()`ing `@/lib/prisma` onto its own probe client.

## Files

| File | Role |
| --- | --- |
| `tests/integration/dsar-erasure-audit-survival.test.ts` | the whole of the above, 12 tests, order-independent |

## Decisions

- **The erasure runs once in `beforeAll`**, between a before- and after-snapshot,
  and every `it` reads captured state. Driving it from inside an `it` would
  cascade one breakage into every later test and make "which test reddened"
  unreadable. A throw is captured and graded by its own test for the same reason.
- **`options.db` rather than the default `runInGlobalContext` path.** Same
  `eraseUserWithin` cascade either way, and `dsar-erasure-rollback.test.ts`
  already drives the default path — injecting is what makes the surface
  observable at all.
- **Rows compared as `to_jsonb(row) - 'userId'`** — the trigger's own predicate,
  applied from the application side. It covers every column without naming one,
  so a column added next quarter is inside the comparison automatically.
- **The bystander is the over-anonymization control, not the SYSTEM row.** The
  SYSTEM row was already NULL before the erasure, so it cannot distinguish
  "untouched" from "nulled again".
- **Distinct millisecond per seeded row.** The chain's total order is
  `(createdAt, id)`; rows sharing a millisecond order by a random cuid, which can
  put the verifier's walk out of step with the order the appends chained in and
  break the chain for reasons that have nothing to do with erasure.
- **The `Promise<never>` tripwire needed no action.** Zero occurrences remain in
  `src/app-layer/jobs/dsar-erasure.ts` (positive control: one remains in
  `dsar-export.ts`, a different stub) and zero assertions anywhere mention it
  (positive control: **5** assertion-bearing `eraseUser` lines exist — lines
  carrying both `eraseUser` and `expect(`, being 4 in
  `tests/unit/dsar-erasure-execute.test.ts` and 1 in
  `tests/integration/dsar-erasure-rollback.test.ts`; re-derive with
  `grep -rn eraseUser tests/ src/ --include=*.ts | grep -c 'expect('`. The
  earlier figure of seven was wrong and matched no derivation; the absence it
  controls for is real, and 5 is enough of a population for a zero to mean
  something). One
  comment at `dsar-workflow-coverage.test.ts:101` records that A1/A2 were deleted
  — that is the handshake's record, not a live tripwire, and deleting it would
  erase why they went.
