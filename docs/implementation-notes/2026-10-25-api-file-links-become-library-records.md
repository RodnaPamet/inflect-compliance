# 2026-10-25 — An API file sent to a control becomes a library record

**Commit:** see the PR (follow-up to the change that did the same for links)

## Design

The previous change turned a LINK sent to `POST /controls/:id/evidence` into a
library record and left FILE writing a plain `ControlEvidenceLink`, which the
evidence library never reads, so the file could never be submitted, approved or
rejected. A FILE now goes the same way, in the route's usecase:

```
POST /controls/:id/evidence {kind: FILE, fileId, note}
  └─► linkEvidence ─► linkFileRecord
        FileRecord(fileId) in this tenant?             no  → 404 File not found
        refused as the upload path would refuse it?    yes → 400 FILE_TYPE_NOT_ALLOWED
                                                              / FILE_TOO_LARGE / FILE_INFECTED
        STORED?                                        no  → 400 FILE_NOT_STORED
        a live Evidence holding it is on the control?  yes → that record, nothing written
        a live Evidence holding it elsewhere?          yes → + EvidenceControlLink,
                                                              audit CONTROL_EVIDENCE_LINKED
        otherwise → Evidence(FILE, DRAFT, title = note || file name,
                             content = FileRecord.pathKey, fileName, fileSize, fileRecordId)
                    + EvidenceControlLink, audit CREATE Evidence + CONTROL_EVIDENCE_LINKED
```

All of it runs in one `runInTenantContext` transaction, under the control's gate
only, and the `evidence` and `control` list caches are bumped afterwards. The
response is the Evidence record. INTEGRATION_RESULT still writes a plain row.
The LINK branch now also runs its address through `sanitizePlainText`, which
returns decoded text, so a query string's `&` is stored as `&`.

Nothing in the product posts a FILE to this route: the control pages upload
through `/evidence/uploads`, and the test-run page posts FILE to the test run's
own route. So this changes API callers only.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/control/evidence.ts` | `linkEvidence` sends a FILE to `linkFileRecord`; the LINK branch sanitises its URL |
| `src/lib/schemas/index.ts`, `public/openapi.json` | `EvidenceLinkRequest` describes what a FILE creates or reuses |

## Decisions

- **One record per file.** A live (not soft-deleted) Evidence already holding
  the `FileRecord` is joined rather than a second record created. `fileRecordId`
  has no unique key, and the upload path's SHA-256 dedup already leaves several
  records on one file, so the pick is stated: a record already on this control
  first (a repeated call then writes nothing), else the oldest by `createdAt`,
  then `id`. An archived record counts as live. Reuse names the existing record,
  so its status — possibly APPROVED — comes with it; that is the point of one
  record per file.
- **The upload path's refusals, with its errors.** `uploadEvidenceFile` refuses
  bytes of a type outside the allowlist (`FILE_TYPE_NOT_ALLOWED`), over the cap
  or empty (`FILE_TOO_LARGE`), and condemned by the scanner, either now or by
  an earlier record with the same SHA-256 (`FILE_INFECTED`). The same checks run
  here against the `FileRecord`'s stored type, size and hash, through the same
  helpers (`isAllowedMime`, `isAllowedSize`, `FileRepository.findBySha256`).
- **STORED is required.** The upload path reuses an existing `FileRecord` only
  when it is STORED, and this path is a reuse of one, so it does the same. The
  upload path has no error for it (it writes a fresh record instead), so this
  one is `FILE_NOT_STORED`.
- **What is left to the download gate.** A scan still PENDING does not stop
  creation, because the upload path stores files in that state too.
  `assertTenantKey` on the storage key and the archived / deleted evidence
  checks also run only at download. None of them is added here.
- **No audit row for a refusal.** The upload path writes `FILE_QUARANTINED` when
  it refuses bytes arriving for the first time. Here the bytes are already in
  the tenant and were audited when they were quarantined, so the refusal is an
  ordinary 400.
- **The title from a file name is sanitised too,** like the note, falling back
  to `unnamed` as the upload path does for a file with no name.
