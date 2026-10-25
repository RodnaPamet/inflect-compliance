# 2026-10-25 — A link added on a control becomes a library record

**Commit:** `<sha>` fix(controls): a link added on a control's Evidence tab is a library record

## Design

The control's Evidence tab offered "upload a file or link a URL", and the code
comment above its submit said both landed in the evidence library. Only the
file did. The link went to `POST /controls/:id/evidence`, which writes a
`ControlEvidenceLink` row, and nothing in the library reads that table, so the
link could never be submitted, approved or rejected (#4126). The owner decided
the link becomes a library record.

```
before   Evidence tab ── POST /controls/:id/evidence ──► ControlEvidenceLink (no status)
after    Evidence tab ── POST /evidence {type: LINK, title, content, controlIds:[id]}
                         └─► createEvidence ──► Evidence(LINK, DRAFT) + EvidenceControlLink
                                              + audit CREATE Evidence
```

The tab now calls the library's create path exactly as the library's own link
dialog does, so there is still one Evidence writer for a link: same route
validation (`CreateEvidenceSchema`), same permission (`evidence.edit`), same
tenant check on the control id, same audit row, same cache bumps. No schema
change and no migration: older `ControlEvidenceLink` rows keep showing on the
tab, labelled **Plain link** with **No review status**, and keep their
remove button.

The same change fixes the rest of the tab's display: types and statuses go
through the library's label helpers, "Added by" is filled for library records,
and a plain link's note shows beside its address.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx` | Link submit posts to `/evidence`; errors read through `apiErrorMessage` |
| `src/components/EvidenceAddForm.tsx` | `linkTitleRequired`; the note box renders only when a note handler is passed |
| `src/components/controls-shared/EvidenceSubTable.tsx` | Library labels, "Added by" for records, plain-link labelling, note with address |
| `src/components/evidence/evidence-labels.ts` | Moved out of the library route so the shared sub-table may import it |
| `src/app-layer/usecases/control/evidence.ts` | `getControlEvidenceTab` returns `addedBy` per record |
| `NewEvidenceLinkModal.tsx`, `NewEvidenceTextModal.tsx`, `EvidenceUploadSection.tsx`, `controls/templates/page.tsx`, `controls/NewControlModal.tsx` | Refusals read through `apiErrorMessage` |

## Decisions

- **The note is gone from the control tab's link form.** A library LINK record
  has no note column, and the library's own dialog asks for a title and an
  address only. Folding the note into the title would lose one of them when
  both are typed; keeping the box would accept text that is then dropped.
  Adding a column is a schema change, which this fix was not to make.
- **The title is required for a link**, because `createEvidence` refuses an
  untitled record. The submit stays disabled until there is one, and the
  address field says why. No default is invented (the task tab's server path
  uses `note || url`; that is a second writer, not this one).
- **No sanitisation was added.** The brief asked to sanitise "as that path
  does"; `createEvidence` does not sanitise `title` or `content`, and
  `Evidence.title` is outside the encrypted-field manifest that
  `sanitize-rich-text-coverage` derives its population from. Changing that
  would change every library create, so it is left for its own decision.
- **"Added by" is who attached the record to THIS control**, read from
  `EvidenceControlLink.createdBy`. `Evidence` has no creator column. For a
  record uploaded or linked from the tab the join row is written by the same
  request, so it names the creator; for a library record linked later it names
  whoever linked it, which is what the column means on a control. One nested
  include for the page, scoped to the control, no per-row read.
- **Two writers of plain links remain**: `POST /controls/:id/evidence` for API
  callers, and the URL box of the drag-and-drop section in the controls list's
  edit panel, which has no title field. Moving the panel would need a title
  input there, which is a different change.
