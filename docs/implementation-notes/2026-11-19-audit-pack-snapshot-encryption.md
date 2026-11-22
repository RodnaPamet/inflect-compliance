# 2026-11-19 — Nightly encryption of pre-#5150 audit-pack snapshots (#5455)

**Commit:** see the pull request that closes #5455.

## Design

#5150 added `AuditPackItem.snapshotJson` to `ENCRYPTED_FIELDS`, which encrypts
every write from then on and nothing written before. A `TEST_RUN` item frozen
before it still holds the tester's notes, the finding summary and the
executor's email in plaintext, and neither the read path nor either rotation
job will ever change that: all three act only on values that already carry a
`v1:`/`v2:` envelope.

`audit-pack-snapshot-encryption` is a scheduled job, daily at 02:23 UTC:

```
census (column, all tenants)
  └─ no plaintext? → record NO_PLAINTEXT / EMPTY_TABLE, census again, stop
discover tenants holding a plaintext snapshot
for each tenant:
  read Tenant { encryptedDek, previousEncryptedDek }
    previous set        → ROTATION_IN_FLIGHT (untouched)
    no DEK              → ensureTenantDek, re-read
  unwrap the DEK
  loop, keyset on id, one transaction per batch of 100:
    SELECT … FROM "Tenant" WHERE id = $1 FOR SHARE
      key moved / rotation started → KEY_CHANGED (stop for tonight)
    SELECT plaintext rows
    encryptWithKey(dek, value) → decryptWithKey → must equal value
    UPDATE … SET snapshotJson = ciphertext WHERE id = $ AND snapshotJson = value
  audit row AUDIT_PACK_SNAPSHOTS_ENCRYPTED (SYSTEM) when anything was written
  remaining = plaintext count for the tenant
census again; warn with the tenants left when plaintext remains
```

## Files

| File | Role |
|---|---|
| `src/app-layer/jobs/audit-pack-snapshot-encryption.ts` | The census, the per-tenant pass, the sweep and the executor body |
| `src/app-layer/jobs/schedules.ts` | The 02:23 UTC entry and why that minute |
| `src/app-layer/jobs/types.ts` | Payload type, payload map entry, `JOB_DEFAULTS` (one attempt) |
| `src/app-layer/jobs/executor-registry.ts` | Executor registration |
| `src/lib/observability/integration-metrics.ts` | `security.audit_pack_snapshot_encryption.pass` / `.rows` |
| `src/lib/security/encrypted-fields.ts` | The manifest's LIMITATION note now names the job |
| `docs/encryption-data-protection.md` | "Rows written before a column was encrypted" |
| `tests/integration/audit-pack-snapshot-encryption.test.ts` | Real-database proof, including the rotation race |
| `tests/regression/infrastructure-guards.test.ts` | Expected scheduled-job list |

## Decisions

- **Daily, not once** (owner decision). A one-shot script needs an operator
  with VM access; a daily job needs none, closes anything a bypass path writes
  in plaintext later, and costs two counts over the table a night once there
  is nothing left.
- **Raw SQL and an explicit DEK, not the extended client.** The extended
  client encrypts under the tenant DEK only with an ambient audit context; a
  job without one writes `v1:` under the global KEK, unlike every other row in
  the column. The rotation sweeps solve the same problem the same way.
- **`FOR SHARE` on the tenant row per batch.** The danger is a DEK rotation
  that starts after the job read the key: the rotation's sweep can pass a row
  before the job writes it under the old key, and the old key is then
  discarded. `rotateTenantDek`'s swap is an UPDATE of the tenant row, so it
  waits for the batch to commit, and the sweep then rewrites the batch's rows
  with the rest. The integration test holds a swap open, waits until the job
  is provably blocked on the lock (`pg_stat_activity`, not a sleep), commits
  it, and asserts `KEY_CHANGED` with the row untouched. Removing the in-batch
  check fails that test.
- **A tenant with no DEK is given one**, through `ensureTenantDek`, which is
  what its first application write would do. Skipping it would leave its rows
  plaintext indefinitely for no protection gained.
- **Counts are committed counts.** Each batch counts into its own record,
  added to the tenant's result only after the transaction commits, so a
  rolled-back batch reports nothing written.
- **Zero is reported with its reason.** Every run carries the column's census
  before and after, and a run that visits no tenant is a metric of its own
  (`no_plaintext` or `empty_table`), so "nothing to do" is distinguishable
  from "nothing read".
- **Conditional UPDATE.** A snapshot the application rewrote between the read
  and the write is left as the application wrote it (`changedUnderneath`).
- **No tenant label on the metric.** Which tenant still holds plaintext is in
  the job's warning log line, where a tenant id belongs.
