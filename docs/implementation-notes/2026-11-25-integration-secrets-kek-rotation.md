# 2026-11-25 — Integration credentials join the master-key rotation (#5942, phase 1)

## Design

`IntegrationConnection.secretEncrypted` holds every integration's credentials,
sealed with `encryptField` (the master key, `v1:`) by the usecases that write
them and read back with `decryptField`. It is outside `ENCRYPTED_FIELDS` on
purpose (the encryption extension never touches it), and the master-key
rotation walked only that manifest and the PII columns. So a rotation never
re-encrypted the credentials, its report said nothing about them, and the
runbook's last step, retiring `DATA_ENCRYPTION_KEY_PREVIOUS`, would have made
every integration unreadable. The same defect #5070 found for the PII columns.

`KEK_SEALED_COLUMNS` in `src/lib/security/encrypted-fields.ts` names the columns
sealed explicitly under the master key, and `jobs/key-rotation.ts` walks it
beside the manifest and the PII columns, through the same `rewriteV1Field`.
A guard holds every `encryptField` call site outside the encryption
infrastructure to a column that list names.

## Files

| File | Role |
| --- | --- |
| `src/lib/security/encrypted-fields.ts` | `KEK_SEALED_COLUMNS`, with `IntegrationConnection.secretEncrypted` |
| `src/app-layer/jobs/key-rotation.ts` | Walks `KEK_SEALED_COLUMNS` in the per-tenant sweep |
| `tests/guards/kek-sealed-columns-are-rotated.test.ts` | Every `encryptField` write names a column in the list |
| `tests/integration/integration-secret-kek-rotation.test.ts` | A real key swap: rotated secret still reads after the old key is retired; an unrotated one does not |
| `docs/epic-b-encryption.md` | Runbook step c and the post-flight checklist |

## Decisions

- **The rotation's list, not the manifest.** Moving the column into
  `ENCRYPTED_FIELDS` would put it under each workspace's own key, but 41 files
  read or write it with the master-key helpers directly, and each one missed
  would decrypt plaintext and break that integration. That move is phase 2 of
  #5942 and the owner's call; it is not needed to close the defect, because a
  leaked workspace key does not expose a secret sealed under the master key.
- **The guard reads the column name at the call site** (`<column>: encryptField(`
  or `<column> = encryptField(`). A call that names no column fails, because
  the guard cannot vouch for what it cannot see. The infrastructure entries each
  say which list covers what they seal; a feature never joins that list.
- **The integration test swaps the key for real** and keeps an unrotated control
  row: without the control, a swap that silently kept the old key would pass.
