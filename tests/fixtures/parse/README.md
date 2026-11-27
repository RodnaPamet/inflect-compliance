# The parse-fidelity set

Ten documents of the kinds the product holds, for measuring a document parser
(`docs/ai-architecture/ragflow.md`, Phase 0.1). Every one is synthetic and
authored for this repository: no customer content, no copied report, and no
ISO text beyond clause numbers and short titles.

| File | Stands for |
| --- | --- |
| `01-policy-infosec.pdf` | a policy PDF, born digital, with nested sections and a table |
| `02-policy-bg.pdf` | the same kind of policy in Bulgarian (Cyrillic) |
| `03-soa-export.xlsx` | a Statement of Applicability exported as a spreadsheet |
| `04-soa-two-page.pdf` | a Statement of Applicability whose table crosses page breaks, header repeated |
| `05-soc2-excerpt.pdf` | a vendor SOC 2 Type II report excerpt, with long wrapped cells |
| `06-iso27001-clauses.pdf` | an ISO 27001 clause checklist |
| `07-scanned-access-review.png` | a photographed access-review sign-off: OCR only |
| `08-scanned-bcp-test.pdf` | a scanned evidence PDF with no text layer: OCR only |
| `09-vendor-questionnaire.xlsx` | a vendor security questionnaire export |
| `10-incident-procedure.docx` | an incident response procedure in Word |

`expected/<id>.json` holds the headings and tables each document carries.
`manifest.json` holds each file's sha256.

**Do not edit these files by hand.** Each document is written once, in
`scripts/parse-fidelity/fixtures.ts`, and that one spec yields both the file
(`scripts/parse-fidelity/generate.ts`, run by hand: Chromium, LibreOffice and
ImageMagick) and its expected file. `tests/unit/parse-fidelity.test.ts`
re-derives every expected file from the specs and checks every committed file
against the manifest, so a change to a document is a change to its spec, a
regeneration, and a new manifest, in one diff.

The set is run against a real parsing service by the `Parse fidelity`
workflow (`.github/workflows/parse-fidelity.yml`), and scored by
`scripts/parse-fidelity/score.ts`.
