# 2026-10-26 — An evidence import started with an API key runs as the key

**Commit:** `fix(evidence): an import started with an API key runs as the key, not its user`

## Design

`POST /api/t/:slug/evidence/imports` accepts an API key: `getTenantCtx` →
`tryApiKeyAuth` → `verifyApiKey` builds a context from the key's scopes, and the
route checks `evidence.upload` (and, for a default control, `controls.edit`)
against it. The route then enqueued `evidence-import` with
`initiatedByUserId` only, and the worker rebuilt the context from that user's
membership. The import did what the USER may, not what the key may, and a key
revoked while the job was queued still had its job run (#4369).

```
request   verifyApiKey(token)            key scopes (∧ principal, if agent-bound)
            │  route enqueues { initiatedByUserId, apiKeyId }
            ▼
worker    resolveKeyInitiatorContext
            ├─ resolveApiKeyForJob(id, tenant)   other_tenant first, then the request's
            │                                    tail: not_found / revoked / expired /
            │                                    tenant_deleted / principal_unresolved
            ├─ key.userId === initiatedByUserId  else other_user
            ├─ resolveInitiatorContext           else initiator_not_a_member
            └─ lowerRole ∧ intersectPermissions ∧ intersectPermissionSets
```

`resolveApiKeyForJob` (`src/lib/auth/api-key-auth.ts`) is the third entry to
`finaliseApiKeyAuth`, the tail `verifyApiKey` and `resolveApiKeyById` already
share, so the job's scope-to-permission resolution, liveness checks and
agent-bound narrowing are a request's, not a copy. A payload with no
`apiKeyId` — a session request, or one queued before this change — takes the
`resolveInitiatorContext` path exactly as before.

## Files

| File | Role |
| --- | --- |
| `src/lib/auth/api-key-auth.ts` | `resolveApiKeyForJob`; `finaliseApiKeyAuth` can skip the last-use stamp |
| `src/app-layer/context-system.ts` | `resolveKeyInitiatorContext` and its `KeyInitiatorRefusal` reasons |
| `src/app-layer/jobs/types.ts` | `EvidenceImportPayload.apiKeyId` |
| `src/app/api/t/[tenantSlug]/evidence/imports/route.ts` | enqueues the key's id when the request carried one |
| `src/app-layer/jobs/evidence-import.ts` | builds the context from the key when the payload names one |

## Decisions

- **Key ∧ member for EVERY key, not only an agent-bound one.** `verifyApiKey`
  intersects a key with its principal's membership only when the key is bound
  to an agent; a plain key's request is authorised by its scopes alone. The
  job intersects for both. Matching the request exactly would have let a plain
  key's import do what its creator, today, may not — and the job already
  applied the membership, so for such a key that would have widened it. For an
  agent-bound key the extra term is the one the key was already narrowed by,
  so nothing changes. The result is never more than either the key or the
  member, and never more than the job held before.
- **The tenant binding is checked before the shared tail.** A key of another
  tenant must not have its agent principal resolved, and an `AUTHZ_DENIED` row
  written, in that tenant on this job's behalf. Without the check the job ran
  in its own tenant with another tenant's key.
- **No IP term.** A key has no IP allowlist; the request's address is read only
  to stamp `lastUsedIp`. The job has no client, and its re-read does not stamp
  `lastUsedAt` either — the request was the use.
- **A refusal is an error, not an audit row.** The job throws with the reason
  before reading the archive, as its membership refusal does; a request refused
  for a revoked or expired key writes no row either. The one row a refusal does
  write is the request's own, for an agent-bound key whose principal left.
- **Only the evidence import.** Other jobs that a key-authenticated route
  queues were reviewed and listed in the pull request rather than changed
  here.
