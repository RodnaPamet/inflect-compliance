# 2026-11-10 — Evidence forms: several controls, a category list, a description (#5018)

## Design

Filing the methodology acceptance as Evidence hit three gaps in the evidence
forms, each a different kind of gap:

| Gap | Where it lived | Fix |
|---|---|---|
| One control per record | UI only. The API's `controlIds` has been many-to-many since EP-3; the Link, Text and Upload forms used a single-select `Combobox` | `EvidenceControlsField`, a multi-select, in all four forms (Edit already had one) |
| Category was free text | UI only. `Evidence.category` is a string | `EvidenceCategoryField`: ten standard categories, then the workspace's own, then "Use …" to type a new one |
| No description | Schema. `Evidence` had no column for it; `content` is a note body or a URL | `Evidence.description`, nullable `TEXT`, encrypted, sanitised by every writer |

The three fields live in one file, `evidence/_form/EvidenceFormFields.tsx`, and
every form renders them. The forms drifted apart once — that is how a
many-to-many API ended up behind single-select pickers — so they now share the
components rather than a convention.

## Files

| File | Role |
|---|---|
| `prisma/schema/evidence.prisma`, `migrations/20261110170000_evidence_description` | The column: catalogue-only `ADD COLUMN`, no default, no rewrite |
| `src/lib/security/encrypted-fields.ts` | `Evidence: ['description']` (Evidence was absent: `content` is searched) |
| `src/lib/evidence-categories.ts` | The ten presets and `evidenceCategoryChoices` |
| `src/lib/evidence-description.ts` | The 2,000-character cap, shared by the forms and the server schemas |
| `src/app-layer/usecases/evidence.ts` | `sanitizeDescription` on create, upload and edit (three-state on edit) |
| `src/lib/schemas/index.ts`, `evidence/uploads/route.ts` | The field on the JSON and multipart bodies |
| `integrations/providers/sharepoint/import.ts` + route | `controlIds` and `description`, so the upload form's SharePoint import keeps every control |
| `evidence/_form/EvidenceFormFields.tsx` and the four modals | The shared fields |
| `EvidenceDetailSheet.tsx`, `EvidenceClient.tsx` | The description shown and seeded into Edit; the workspace's categories passed to every form |

## Decisions

- **The category stays free text.** The API accepts any string, rows written
  before the list keep theirs, and a person may still type a new one. The list
  is what the forms offer first, so the same kind of evidence stops being filed
  under several spellings. The stored value is the English name, a data value
  the list, filter and exports show as written — not a label to translate.
- **The description is encrypted; `content` still is not.** `content` is
  searched by `EvidenceRepository`, which is why the manifest omitted Evidence.
  The description is not searched, so it takes the same treatment as every other
  business-content column.
- **Edit sends the description only when it was seeded,** like tags: an omitted
  key leaves the stored value alone, where a blank one clears it. A caller that
  cannot seed it shows no field rather than a blank one that a save would write.
- **The SharePoint import merges `controlIds` with the legacy `controlId`.**
  The upload form now sends several controls; sending only the first would have
  dropped the rest with no error, the defect the import's folder fix already
  recorded once.
