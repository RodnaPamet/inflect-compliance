# 2026-08-21 — Clearing a false-positive malware quarantine

**Commit:** `feat(storage): give a false-positive quarantine a way back`

## Design

`FileRepository.updateScanStatus` made `INFECTED` terminal on purpose: the
download gates trust `scanStatus` alone, so a rescan job posting a later
`CLEAN` would be a served-malware bug with no attacker involved. The cost
of that correctness is that one bad ClamAV signature update — and they
happen — condemns rows with no in-app remedy short of a DBA.

PR #2051 landed the door (`FileRepository.clearInfectedVerdict`) and wrote
its contract into the docstring. This lands the three things above the
repository that the repository cannot enforce for itself.

```
POST /api/t/:slug/admin/files/:fileId/clear-quarantine   { reason }
  │
  ├─ requirePermission('admin.tenant_lifecycle')   ← OWNER-only; ADMIN denied
  │     denial ⇒ AUTHZ_DENIED audit row + generic 403
  ▼
clearFileQuarantine(ctx, { fileId, reason })
  │
  ├─ assertCanClearFileQuarantine(ctx)             ← same key, non-HTTP callers
  ├─ sanitizePlainText(reason), 10..500 chars
  ├─ FileRepository.getById            (tenant-scoped read; 404 / 409 early)
  ├─ appendAuditEntry FILE_QUARANTINE_CLEARED  ──► id
  └─ FileRepository.clearInfectedVerdict(..., auditLogId: id)
         count === 0 ⇒ 409, and the audit row STAYS
```

The audit entry is written *before* the transition and deliberately not
rolled back when the transition then refuses. It records that the decision
was **taken**; an operator asking "who tried to un-quarantine this file"
should get an answer whether or not the claim won its race. Passing the id
into the repository signature is what makes "audited" a compile-time
obligation rather than a convention the next caller forgets.

The two `runInTenantContext` calls are separate on purpose. `appendAuditEntry`
opens its own advisory-locked transaction; nesting it inside an interactive
`$transaction` would hold two pool connections for the duration and invite
the exact stall the audit path must not cause.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/file-quarantine.ts` | The usecase — gate, reason validation, audit-then-write ordering. |
| `src/app-layer/policies/admin.policies.ts` | `assertCanClearFileQuarantine` — the OWNER-grade gate, reachable from non-HTTP callers. |
| `src/app/api/t/[tenantSlug]/admin/files/[fileId]/clear-quarantine/route.ts` | HTTP entrance; `requirePermission` + `API_KEY_CREATE_LIMIT`. |
| `src/lib/security/route-permissions.ts` | Declarative rule so the map, the SDK, and the docs agree with the middleware. |
| `tests/guardrails/admin-route-coverage.test.ts` | Registers the new admin route (the walker fails on an unlisted one). |
| `public/openapi.json` | Regenerated — route walker emits the stub entry. |

## Decisions

- **`admin.tenant_lifecycle`, not `admin.manage`.** Returning bytes ClamAV
  condemned to circulation is authority of the same class as deleting the
  tenant or rotating its DEK. It is the one admin key ADMIN is explicitly
  denied, which is precisely why it is the right one here. The route test
  asserts an ADMIN is refused, so a future "tidy-up" to `admin.manage`
  turns CI red.

- **No new audit-action enum.** Tenant-side `AuditLog.action` is a free
  string (`AppendAuditInput.action: string`) — its siblings
  `FILE_QUARANTINED` / `FILE_RESCANNED` are registered nowhere either, and
  `activity-humanize.ts` de-snakes unknown verbs gracefully. There was no
  enum or union to extend, so nothing was invented to hold one value.

- **A reason of ten characters minimum.** "fp" is not provenance. The bound
  is low enough not to be a hurdle and high enough to force a fragment a
  reviewer can act on. It is sanitised before it is stamped into
  `scanDetails`, because that column is read back by the admin UI, the
  evidence export, and any SDK consumer reading the row verbatim.

- **Rate-limited at 5/hr.** Same preset as DEK rotation. A legitimate
  operator clears a handful of files after a bad signature set; the cap
  turns a compromised OWNER session into a slow drip rather than a
  library-wide un-quarantine.

- **The rescan circuit breaker is NOT here.** The task also asked for a
  breaker that halts a rescan flipping an abnormal proportion of a tenant's
  library to `INFECTED`. Every input it needs — the running infected
  counter, the scanned population, the per-file loop it would have to break
  out of — lives inside `runAvRescan` in `src/app-layer/jobs/av-rescan.ts`.
  It belongs in that job, not in the reversal path, and it is left for the
  change that owns that file.

## Future work

- An admin screen listing quarantined files with a Clear affordance. The
  API is the deliverable here; a screen also wants a quarantine LIST
  endpoint, which is its own surface.
- The rescan-outbreak circuit breaker described above.
