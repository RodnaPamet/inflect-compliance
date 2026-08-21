# 2026-08-21 — `replaceEvidenceFile` refuses known-infected bytes

**Commit:** `fix(evidence): refuse known-infected bytes on the file-replace path`

## Design

Register #116 was filed as "the upload-time INFECTED verdict is computed,
audited against a filename, then discarded". Reproduced against `main` first:
that half is **closed**. #117 (`#2052`) made the dedup arm drain a PENDING row
with the fresh verdict, and #118 (`#2056`) widened `FileRepository.findBySha256`
to see INFECTED rows and put a refusal gate in `uploadEvidenceFile` that throws
`badRequest('FILE_INFECTED')` before the dedup arm runs. The behavioural suite
`tests/unit/evidence-infected-hash-dedup.test.ts` passes on `main` unmodified.

The second half was live. `replaceEvidenceFile` had **no SHA-256 lookup at all**
— #118's note named it as not addressed. So the "a verdict can arrive later, and
has to survive the next arrival of the same bytes" property that #118 built for
upload simply did not exist for replace:

```
upload  → scan → write → [known-infected gate] → dedup | create
replace → scan → write →         (nothing)     →        create
```

`scanUploadOrRefuse` does not close it. It reports what the engine knows at that
instant; the whole reason the AV webhook exists is that a signature can ship
after the bytes were first stored. Quarantine moves the row to
`status: 'FAILED'`, so on replace the condemned hash was invisible and the bytes
re-entered as a fresh FileRecord — this time chained under an *existing*
evidence row, one that may already carry an APPROVED badge (the replace path
resets APPROVED → SUBMITTED, but the row keeps its history, links and
retention). Under `AV_SCAN_MODE=permissive` that row is downloadable.

The gate is now ONE module-local helper, `refuseIfHashKnownInfected`, called by
both byte-accepting usecases. Behaviour on the upload path is byte-identical to
what #118 shipped — same lookup, same `FILE_QUARANTINED` action, same
`refused_known_infected_hash` disposition, same best-effort delete of the
just-written copy, same refusal thrown outside the write transaction.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/evidence.ts` | Extracts `refuseIfHashKnownInfected` from the inline upload gate; calls it from `replaceEvidenceFile` too |
| `tests/unit/usecases/evidence-replace-infected-hash.test.ts` | Drives the real usecase + real `findBySha256` against an in-memory FileRecord/Evidence table |

## Decisions

- **One shared helper, not a second copy.** The audit `action` and
  `disposition` are literal SIEM contract. Two copies drift, and a rule written
  against the upload wording would then miss the same threat arriving through
  replace. The only per-path difference is the `via` word in the human-readable
  detail line (`re-upload` / `replacement`), which no rule keys on.
- **Refuse, do not de-duplicate.** Replace still creates its own FileRecord for
  a CLEAN hash it has seen before — the `previousFileRecordId` chain is the
  version lineage, so reusing the canonical row would collapse it. The gate is
  only about INFECTED; dedup on the replace path is out of scope and was not
  added.
- **`findBySha256` untouched.** Its two-query shape (INFECTED first, then
  canonical STORED) is load-bearing for #118's tests; the new caller consumes it
  exactly as the upload path does.
- **Gate after `storage.write`, not before.** It needs `writeResult.sha256`,
  which is computed by the write. The copy that lands in the bucket is deleted
  best-effort on refusal, matching the dedup path — a failed delete leaks one
  orphan for the GC sweep and must not change the refusal the caller sees.
- **Not addressed:** draining a same-hash PENDING row with the replacement's
  fresh verdict (the #117 move). Replace has no reuse arm, so there is no
  natural place for it; it would be a new cross-row write with its own
  conditional-update semantics.
