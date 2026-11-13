# 2026-11-13 — DataSubjectRequest leaves the field-encryption manifest (#5107)

## Design

`DataSubjectRequest.rejectionReason` and `.fulfilmentNotes` were in
`ENCRYPTED_FIELDS`. The model is USER-scoped and has no `tenantId`, so the
middleware encrypted each value under whichever tenant DEK the ACTING request
carried (`v2:`), or the global key (`v1:`) with no tenant. The tenant-DEK
rotation sweep walks tenant-scoped rows only, so it never re-wrapped these: a
rotation followed by clearing `previousEncryptedDek` stranded them, and a
reader in a different workspace than the writer could not open them at all.

Owner decision (2026-11-13): take the model out of the manifest and turn the
stored values back into plaintext, rather than invent a per-user key.

```
encrypted-fields.ts      DataSubjectRequest entry removed (comment says why)
dsr-legacy-decrypt.ts    v1: decryptField; v2: the handler's workspaces' DEKs,
                         then the subject's, current then previous
entrypoint.sh            runs it after the task-checklist backfill, non-fatal
```

## Files

| File | Role |
| --- | --- |
| `src/lib/security/encrypted-fields.ts` | Drops the model from the manifest |
| `src/lib/security/dsr-legacy-decrypt.ts` | One-pass decrypt of stored `v1:`/`v2:` values, raw SQL in and out |
| `scripts/decrypt-legacy-dsr-fields.ts` | Container-start entry point (RLS-bypassing client, `admin-script`) |
| `scripts/build-worker.mjs`, `scripts/entrypoint.sh`, `package.json` | Bundle, run at start, `db:decrypt-legacy-dsr` |
| `tests/guardrails/encryption-manifest-coverage.test.ts` | Both columns classified `NOT_SENSITIVE` with the reason |
| `tests/guardrails/sanitize-rich-text-coverage.test.ts` | Stale DSR entry removed |

## Decisions

- **Raw SQL for both the read and the write.** The middleware's read path
  decrypts by FIELD NAME across models (`ControlException.rejectionReason` is
  in the manifest), so a client read returns plaintext for a value that is
  still ciphertext in the table, and the pass would skip it.
- **An undecryptable value is left in place and counted, never erased.** A
  DSR record is Art. 17 evidence; a ciphertext an operator can still recover
  with an old key beats a hole. The script exits 1 in that case and the
  entrypoint logs a warning instead of stopping the container.
- **Idempotent.** Only values carrying a `v1:`/`v2:` prefix are selected, so
  the container start runs it every time at the cost of one sequential scan
  of a small table.
- **Candidate tenants, handler first.** The row does not record which tenant's
  DEK wrapped it; the handler's session wrote the notes, so their workspaces
  are tried before the subject's.
