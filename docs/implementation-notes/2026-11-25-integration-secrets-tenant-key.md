# 2026-11-25 — Integration secrets under the workspace's own key (deploy 1 of 2)

**Issue:** #5969 (#5942 phase 2, owner decision 2026-11-25)

## Design

`IntegrationConnection.secretEncrypted` is sealed by the code that writes it,
not by the encryption extension: ~35 call sites assemble and read the JSON bag
in hand. Phase 1 (#5961) made the master-key rotation reach it. Phase 2 moves
it under the workspace's DEK, so a per-workspace rotation covers it and a
leaked master key no longer opens it without the wrapped DEK as well.

One helper pair is the only way in and out (`src/lib/security/tenant-sealed.ts`):

- `sealTenantSecret(tenantId, plaintext)`: `v2:` under the tenant DEK; while the
  brake `TENANT_SEALED_UNDER_TENANT_KEY` (a leaf module) is `false`, `v1:` under
  the master key, exactly as before.
- `openTenantSecret(tenantId, value)`: `v2:` under the tenant DEK with the
  previous DEK as fallback mid-rotation; anything else through `decryptField`,
  unchanged.

`TENANT_SEALED_COLUMNS` (in `encrypted-fields.ts`, replacing phase 1's
`KEK_SEALED_COLUMNS`) is walked by both rotations: the tenant-DEK sweep
rewrites the `v2:` values with the manifest's own logic, and the master-key
rotation re-seals the `v1:` values through `sealTenantSecret`, which moves them
onto the tenant key once the brake is off.

## Two deploys

Code from before the readers learned `v2:` cannot read it. Deploy 1 (this
change) teaches every reader and keeps writing `v1:`. Deploy 2 flips the brake
in a commit of its own. Rolling deploy 2 back lands on deploy 1's readers, which
still read `v2:`, so nothing is stranded; rolling back past deploy 1 after
deploy 2 has written would be, which is why the two are separate.

## Files

| File | Role |
| --- | --- |
| `src/lib/security/tenant-sealed.ts` | The seal/open pair |
| `src/lib/security/tenant-sealed-activation.ts` | The brake, a leaf module |
| `src/lib/security/encrypted-fields.ts` | `TENANT_SEALED_COLUMNS` |
| `src/app-layer/jobs/key-rotation.ts` | Re-seals `v1:` values through the helper |
| `src/app-layer/jobs/tenant-dek-rotation.ts` | Sweeps `TENANT_SEALED_COLUMNS` with the manifest |
| ~30 usecases, jobs and providers | Every read and write of the column moved to the helpers; four sync helpers became async |
| `tests/guards/tenant-sealed-columns.test.ts` | Replaces `kek-sealed-columns-are-rotated`: no raw `encryptField`/`decryptField` outside the encryption infrastructure, every seal names a listed column, both rotations walk the list |
| `tests/integration/integration-secret-tenant-key.test.ts` | Real DB, brake mocked on: seal/open, cross-tenant refusal, both sweeps |

## Decisions

- **Helpers, not the manifest.** Putting the column in `ENCRYPTED_FIELDS` would
  have had the extension decrypt it on read, and every one of the ~35 sites
  would then have called `decryptField` on plaintext. One missed site breaks
  one integration silently; the helpers make the old call shape impossible
  (guard) rather than wrong.
- **`openTenantSecret` passes anything that is not `v2:` to `decryptField`.**
  That keeps every failure mode of today's reads byte for byte (a malformed
  value throws the same error), so no caller's error handling moved.
- **The guard is stricter than phase 1's.** It bans `encryptField` and
  `decryptField` outside eight infrastructure files outright, because after
  this change no feature code needs either: a new explicitly sealed column has
  to go through `sealTenantSecret` and be listed.
- **The rotation's `seal` parameter defaults to `encryptField`**, so the manifest
  and PII columns are untouched; only `TENANT_SEALED_COLUMNS` passes the helper.
