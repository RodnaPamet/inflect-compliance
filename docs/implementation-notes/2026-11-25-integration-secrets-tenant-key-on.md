# 2026-11-25 — Integration secrets under the workspace's own key (deploy 2 of 2)

**Issue:** #5969 (#5942 phase 2). Deploy 1 is #5970 (`v3.434.0`).

## Design

`TENANT_SEALED_UNDER_TENANT_KEY` is `true`. From this deploy, `sealTenantSecret`
writes every integration credential as `v2:` under the workspace's DEK, and a
master-key rotation of a workspace moves its remaining `v1:` credentials onto
that key. Nothing else changes: deploy 1 already routed every read and write of
the column through the helpers and taught both rotations the column.

## Files

| File | Role |
| --- | --- |
| `src/lib/security/tenant-sealed-activation.ts` | The brake, now `true` |
| ten unit tests | Route the helpers through each file's existing encryption stub, so the test still asserts on the seal it always did |
| `tests/integration/anthropic-workspace-connection.test.ts`, `integration-secret-preservation.test.ts`, `mcp-connection-credential-seam.test.ts` | Read the stored column through `openTenantSecret`; the first now requires `v2:` |
| `tests/integration/integration-secret-kek-rotation.test.ts` | The real key swap now ends with the credential under the workspace key, readable after the old master key is retired |
| `docs/epic-b-encryption.md` | Runbook: how a tenant's legacy credentials move |

## Decisions

- **No backfill job.** Legacy `v1:` rows move on the connection's next save, on
  a token refresh, or when an admin runs the tenant's key rotation, which is
  safe to run at any time (it re-wraps the DEK under the same master key). A
  separate sweep would be a third writer of the column for no gain in safety:
  a `v1:` credential is still covered by the master-key rotation.
- **Merged only after deploy 1 was running.** A rolling deploy straight from
  pre-#5970 code to this one would have had old containers reading `v2:` values
  they cannot open.
