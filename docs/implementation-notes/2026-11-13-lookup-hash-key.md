# 2026-11-13 — Lookup hashes on a dedicated, non-rotating key

**Commit:** `fix(security): email lookup hashes on a dedicated LOOKUP_HASH_KEY` (issue #5071)

## Design

`hashForLookup` keyed its HMAC on a subkey of `DATA_ENCRYPTION_KEY`, with no
previous-key fallback. Rotating the master key therefore changed every stored
email hash, and every sign-in by email missed its account. The owner decided
(2026-11-13) on a separate, non-rotating key plus a one-time recompute.

- `LOOKUP_HASH_KEY` (optional, ≥32 chars). When set, `hashForLookup` derives
  its HMAC key from it (HKDF info `inflect-lookup-hash-v1`). When unset, it
  uses the master-derived key exactly as before, so merging changes nothing.
- `recomputeLookupHashes(db)` walks the four hash columns
  (`User.emailHash`, `AuditorAccount.emailHash`,
  `UserIdentityLink.emailAtLinkTimeHash`, `VendorContact.emailHash`),
  recomputes each from the row's own plaintext (decrypted by the PII
  middleware), and writes only the ones that differ, with raw SQL.
- `scripts/recompute-lookup-hashes.ts` runs it at every app container start,
  as entrypoint step 1a. It does nothing without the key. It is fatal on
  failure, because serving with mismatched hashes is worse than not starting.

## Files

| File | Role |
| --- | --- |
| `src/lib/security/encryption.ts` | `getLookupHashKey`, `lookupHashKeyIsDedicated` |
| `src/lib/security/lookup-hash-recompute.ts` | the idempotent recompute |
| `scripts/recompute-lookup-hashes.ts`, `scripts/entrypoint.sh`, `scripts/build-worker.mjs` | container-start step |
| `src/env.ts`, `deploy/docker-compose.prod.yml` | the variable, passed to app and worker |
| `docs/epic-b-encryption.md` | env table + rotation pre-flight |

## Decisions

- **Optional, not required.** Watchtower deploys a merged image without the
  operator. A required variable would have crashed production on the next
  pull. Setting it is an operator step: add it to `.env.prod`, then apply the
  Compose change.
- **Recompute at start, not dual-hash reads.** About forty call sites look up
  by hash. Matching either of two hashes at each would be a wider and riskier
  change than one idempotent pass that runs before the server listens.
- **System users skipped.** `sys_<tenantId>` rows carry `system:<tenantId>`, a
  value no lookup by email can compute, by design (#4400).
- **`keyedChangeDigest` stays on the master key.** It answers "did this value
  change", not "find this row", and its docblock already accepts re-keying on
  rotation.
