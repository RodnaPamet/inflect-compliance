# 2026-08-21 — bounding the exposure of a late INFECTED verdict

**Commit:** `feat(storage): record file distribution so a late INFECTED verdict can name what already left`

## Design

An AV verdict can arrive long after upload — that asynchrony is the whole
reason `/api/storage/av-webhook` exists. When it arrived and said INFECTED, the
row was quarantined and every FUTURE read refused. Nothing addressed the reads
that had already happened:

- audit-pack ZIPs pushed into a customer's SharePoint (outside our control the
  moment the upload completes),
- presigned URLs, which keep working until they expire regardless of what the
  row now says,
- portability bundles that embed the bytes.

So an auditor could be holding a ZIP containing malware we had since condemned,
and the product could not name the auditor, the pack, or the day.

The shape shipped here is **record at egress, join on the hash at verdict**:

```
       bytes leave                          verdict flips
  ┌──────────────────────┐             ┌─────────────────────┐
  │ evidence download    │             │ av-webhook: INFECTED│
  │ trust-center download│──┐          └──────────┬──────────┘
  │ audit-pack → SharePt │  │  FILE_DISTRIBUTED   │
  └──────────────────────┘  └──▶ (AuditLog) ──────┤
                                                  ▼
                             sha256 → sibling FileRecord ids
                                                  ▼
                             ledger rows for ALL of them
                                                  ▼
                       FILE_EXPOSURE_ASSESSED (AuditLog) + WARN log
                       { totalDistributions, byChannel, recipients,
                         unrevocableCopies, liveSignedUrls,
                         signedUrlExposureEndsAt, artefacts[], exhaustive }
```

Two classes of exposure are kept apart deliberately, because only one of them
has an end date. A presigned URL is *bounded* — 300 s on both serving paths
since #2040 — so the report can state the instant after which it is dead
(`signedUrlExposureEndsAt`). A ZIP in someone else's SharePoint is permanent:
`unrevocableCopies` counts those, and each carries the pack id and drive id a
human needs to go and delete it. Collapsing the two into one "distributions"
number is exactly what makes such a number unusable.

The join is on the **content hash**, not the row id: the same bytes can sit
under several `FileRecord` rows (re-upload, evidence versioning), and an answer
that only covers the row the scanner happened to name is the wrong answer.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/services/file-distribution.ts` | New. The ledger writer (`recordFileDistribution` / `recordFileDistributions`), the report builder (`buildFileExposureReport`), and the verdict-time entry point (`assessExposureOnInfection`). |
| `src/lib/storage/signed-url-policy.ts` | New leaf module holding `SIGNED_DOWNLOAD_URL_TTL_SECONDS = 300`, shared by the URL minter and the ledger so the recorded expiry cannot drift from the real one. |
| `src/app/api/storage/av-webhook/route.ts` | On a newly-claimed INFECTED verdict, assesses exposure after the quarantine commits. |
| `src/app/api/trust/download/[token]/route.ts` | Selects `id`/`tenantId`/`sha256`, records the distribution with the URL's expiry. |
| `src/app/api/t/[tenantSlug]/evidence/files/[fileId]/download/route.ts` | Records both serving modes; only the redirect mode carries an expiry. |
| `src/app-layer/usecases/audit-pack-sharepoint-export.ts` | Bundler now returns the identities of files that really entered the ZIP; the export records them **after** the upload succeeds. |
| `src/app-layer/usecases/evidence.ts` | `expiresIn` now reads the shared TTL constant. |

## Decisions

- **The audit trail is the store; no new table.** A distribution record is a
  claim about who received what — evidence, whose value depends on being
  un-editable. `AuditLog` is already hash-chained, append-only at both the app
  layer and a DB trigger, tenant-scoped under RLS, SIEM-streamed and
  retention-classified. A `FileDistribution` table would have been a mutable,
  un-chained sibling that had to re-earn every one of those properties (plus an
  RLS migration, an index-coverage entry and a retention-inventory row). The
  lookup stays an indexed equality query on `[tenantId, action]` narrowed by
  `entityId` — not a JSON scan.
- **One row per file per egress, not one row per export.** A batch payload
  would have forced the exposure lookup into a JSON scan. The per-file
  `entityId` is what keeps the join cheap; the cost is N chained appends on an
  admin-triggered export, which is the right trade for a path that has just
  streamed up to 200 MB.
- **Recording is fail-safe everywhere.** A ledger write that throws logs at
  ERROR and returns `false`; it never fails the download or export in flight.
  Refusing a legitimate auditor's download to protect our own bookkeeping is
  the worse failure. The consequence is stated in the data rather than hidden:
  the report carries `exhaustive`, false when a cap was hit, so a reader cannot
  mistake a lower bound for the whole story.
- **The report falls closed.** A ledger entry whose channel cannot be
  classified counts as an *unrevocable* copy, because assuming it expires on
  its own is the assumption that under-reports exposure.
- **Zero is written too.** "Nothing left the platform" is the answer an
  incident responder most needs, and an absent row is indistinguishable from an
  assessment that never ran.
- **No requester email in the payload.** Epic C.4 streams `detailsJson`
  verbatim to the tenant's SIEM, so identity is referenced
  (`contextType`/`contextId`), never copied.
- **Recorded after the SharePoint upload resolves, never before.** Until it
  does, nothing has left; an entry for a failed export would claim an exposure
  that never happened, and the report's whole value is that its counts can be
  acted on.

## Deliberately not done

- **No revocation.** Nothing here un-sends anything. Rotating the object key to
  kill outstanding signed URLs is the obvious next lever and needs a
  `FileRepository` seam this change was not allowed to open.
- **No operator UI or tenant-admin notification.** The answer currently lands
  in the hash-chained trail (visible in activity surfaces) and in the logs. An
  exposure API/route and a notification are the natural follow-up, and both can
  read `buildFileExposureReport` unchanged.
- **`bundle-attachments.ts` is not wired.** It has no production caller and no
  tenant context in its signature; adding a channel there without a caller
  would be untested surface.
- **The rescan job is not wired.** `av-rescan.ts` is owned elsewhere; when it
  flips a verdict it should call `assessExposureOnInfection` with the same four
  arguments the webhook passes.
