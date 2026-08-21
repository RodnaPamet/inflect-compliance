# 2026-08-21 — the quarantine list (the read side of the un-quarantine route)

**Commit:** `<sha> feat(files): list quarantined files so the un-quarantine route has a handle`

## Design

`#2063` shipped `POST /api/t/:slug/admin/files/:fileId/clear-quarantine`, the
only in-app way back from a terminal `scanStatus: INFECTED`. It takes a
`fileId` and nothing in the product produced one — an operator had to lift the
id out of `AuditLog`, which is a hash-chained append-only trail, not a work
queue. The door was built with no handle.

This adds the handle: `GET /api/t/:slug/admin/files/quarantined`, paged.

```
route  admin/files/quarantined/route.ts   requirePermission('admin.tenant_lifecycle')
  └─ usecase  listQuarantinedFiles(ctx, { limit?, cursor? })
       ├─ policy    assertCanViewQuarantinedFiles(ctx)     ← same OWNER-only key
       └─ repo      FileRepository.listQuarantined(db, tenantId, { take, cursor })
                       where   { tenantId, scanStatus: 'INFECTED', status: { not: 'DELETED' } }
                       orderBy [{ scannedAt: 'desc' }, { id: 'desc' }]
                       select  no pathKey
```

Each row carries what an operator needs to identify the file and judge the
verdict: `originalName`, `mimeType`, `sizeBytes`, `sha256`, `domain`, `status`,
`quarantinedAt`, `uploadedAt`, `uploadedByUserId`, and a normalised `verdict`
(`engine` / `threat` / `source` / `unparsed`).

No schema change. `FileRecord` already carries `@@index([tenantId, scanStatus])`
and is already listed in `LIST_MODELS_TENANT_INDEX_SUFFICIENT`.

## Files

| File | Role |
| --- | --- |
| `src/app/api/t/[tenantSlug]/admin/files/quarantined/route.ts` | GET handler; parses `limit` / `cursor`, forgiving on both |
| `src/app-layer/usecases/file-quarantine.ts` | `listQuarantinedFiles` + `summariseScanVerdict` + the page-size constants |
| `src/app-layer/policies/admin.policies.ts` | `assertCanViewQuarantinedFiles` — the usecase-layer twin of the route gate |
| `src/app-layer/repositories/FileRepository.ts` | `listQuarantined` — bounded, projected, cursor-paged |
| `src/lib/security/route-permissions.ts` | declarative rule for the new path, adjacent to the reversal's |
| `tests/guardrails/admin-route-coverage.test.ts` | registers the new admin route |
| `public/openapi.json` | regenerated (stub entry — the generator's default for a route with no published Zod response DTO) |

## Decisions

- **OWNER-only (`admin.tenant_lifecycle`), not ADMIN.** The obvious
  alternative — let ADMIN read, keep OWNER for the write — is defensible and
  was rejected on three grounds. (1) This list is the ONLY source of the
  `fileId` the OWNER-only write consumes, so a weaker tier is disclosure with
  no matching capability. (2) The rows are a map of the malware in a customer's
  evidence library — names, sizes, uploaders, engine signatures — which is the
  reconnaissance a compromised ADMIN session wants. (3) An ADMIN mid-incident
  is not blind: every quarantine writes a `FILE_QUARANTINED` audit row readable
  at the far lower `audit.view` bar. What OWNER buys is the ACTIONABLE view,
  not the only view.

- **`pathKey` is not in the projection.** It is a storage locator for bytes the
  scanner condemned. Nothing on this surface needs it, and a response carrying
  it turns an operator's list into a pointer at live malware. That is why the
  repository has a dedicated method with an explicit `select` rather than a
  `scanStatus` option bolted onto the unbounded, whole-row `listByTenant`.

- **DELETED rows are excluded**, matching the write's own predicate. Listing a
  row `clearInfectedVerdict` is guaranteed to refuse would offer a dead action.

- **`[{ scannedAt: 'desc' }, { id: 'desc' }]`, never `scannedAt` alone.** A bulk
  rescan stamps many rows within the same millisecond, and a cursor walk over a
  non-unique sort key silently skips or repeats rows. `scannedAt` is nullable —
  Prisma sorts NULLs last on DESC, so an unstamped INFECTED row lands at the end
  of the walk rather than vanishing from it.

- **The page is bounded and the bound is not negotiable from outside.** One bad
  signature update can condemn thousands of rows at once, which is exactly why
  this query may never answer "all of them". `limit` clamps to
  `MAX_QUARANTINE_PAGE_SIZE` (100); the repository asks for `take + 1` and the
  probe row is the page-boundary signal, dropped before the caller sees it.

- **`scanDetails` is normalised, not passed through.** Two writers produce it and
  they disagree: `av-webhook` writes `{ engine, result, details, receivedAt }`,
  `av-rescan` writes `{ engine, durationMs, threat, source, jobRunId }`. Picking
  one shape would render the other blank. A value that is not the envelope at
  all comes back as `threat` with `unparsed: true` — the point of the surface is
  judging a verdict, and a verdict you cannot see is worse than an ugly one. The
  text is clipped at 300 characters because its length is scanner-supplied.

- **A malformed `limit` / `cursor` is ignored, not 400'd.** This is an incident
  surface reached under time pressure, often by hand. A typo in a query string
  should hand back the first page.

- **No UI in this change.** A new admin page needs `messages/en.json` +
  `messages/bg.json` keys, and both files were locked by an in-flight PR at the
  time of writing. The API is the deliverable; half a screen would have been
  worse than none.
