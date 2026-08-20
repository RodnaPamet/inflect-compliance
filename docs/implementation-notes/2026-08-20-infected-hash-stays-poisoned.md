# 2026-08-20 — a quarantined SHA-256 stays poisoned

## Design

Quarantine and dedup disagreed about what a hash means.

The AV webhook condemns a file by moving `scanStatus → INFECTED` and
`status → FAILED` together, in one conditional `updateMany`. The SHA-256 dedup
lookup (`FileRepository.findBySha256`) matched `status: 'STORED'` only. So the
instant a file was quarantined, its hash fell straight OUT of the dedup index:

```
upload A  →  FileRecord(STORED, scanStatus PENDING)   ← in the dedup index
webhook   →  FileRecord(FAILED, scanStatus INFECTED)  ← no longer in it
upload A' →  findBySha256 → null → createPending      ← same bytes, new PENDING row
             …markStored → STORED / scanStatus PENDING
```

The re-uploaded row carries no verdict at all, and under `AV_SCAN_MODE=permissive`
a PENDING row is served. The upload-time scan does not close this: it reports what
the engine knows at that instant, and the entire reason the webhook exists is that
a verdict can arrive later. A verdict that arrives later has to survive the next
upload of the same bytes.

Two options were on the table. Stop setting `status: 'FAILED'` — **rejected**: the
atomic quarantine landed the same day (`av-webhook/route.ts`, #2039) precisely so
those two columns can never be observed apart, and
`tests/unit/av-webhook-quarantine-atomicity.test.ts` exists to hold that. Deleting
the spread would moot the test and reopen the split-write window.

Taken instead: **keep the quarantine exactly as it is and widen the dedup lookup**,
so an INFECTED row still owns its hash. `findBySha256` now answers "who already
owns this hash", not "is there a STORED copy" — a question with two possible
answers, the canonical copy or the condemned one.

The refusal itself sits in `uploadEvidenceFile` immediately after `storage.write`,
**outside** the transaction that follows. That placement is load-bearing: the
refusal is a security event, and an audit row written inside a transaction that
then throws rolls back with it. It is the same reason `scanUploadOrRefuse` audits
before it throws. The dedup block further down is untouched — its
`existingFile.status === 'STORED'` test still correctly declines to reuse a
quarantined row, and it is now unreachable with one.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/repositories/FileRepository.ts` | `findBySha256` matches the quarantined row too, INFECTED first |
| `src/app-layer/usecases/evidence.ts` | `uploadEvidenceFile` refuses known-infected bytes, audits, drops the copy |
| `tests/unit/evidence-infected-hash-dedup.test.ts` | drives the real usecase + repository against an in-memory FileRecord table |

## Decisions

- **Two narrow queries, not one `OR`.** When the same bytes were stored before the
  signature that catches them shipped, both rows exist — and then the verdict must
  win rather than whichever row `findFirst` happened to reach. Ordering that
  matters should not depend on the planner. The INFECTED probe rides the existing
  `@@index([tenantId, scanStatus])`; no schema change.
- **The gate re-reads the hash the dedup block will read again.** One extra
  indexed `findFirst` on a path that has just done network IO and a virus scan,
  bought in exchange for an audit row that survives the throw. Worth it.
- **Same error as the live refusal** — `badRequest('FILE_INFECTED', …)`, byte for
  byte what `scanUploadOrRefuse` throws. The caller should not have to care whether
  the verdict arrived just now or last week.
- **Same audit action** — `FILE_QUARANTINED`, with
  `disposition: 'refused_known_infected_hash'`. The webhook and the upload-time
  refusal already share that action string, so one SIEM rule covers every
  disposition of the same threat.
- **The just-written copy is deleted best-effort** before the throw. The bytes are
  known malware; leaving them for the GC sweep is worse than a swallowed delete
  error, and a failed delete must not change the refusal the caller sees.
- **Not addressed:** `replaceEvidenceFile` has no dedup lookup at all, so this gate
  does not cover it. It scans on the way in, but the same "verdict arrives later"
  gap applies to it and closing it means giving that path a hash lookup it has
  never had.
