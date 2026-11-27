# 2026-11-27 — The parse-fidelity set and its workflow (document parsing, Phase 0.1, 0.3–0.4)

## Design

D-L4-4 (owner, 2026-11-11) chose a Docling-class parsing-only service and
keeps RAGFlow only if Docling fails the fidelity eval. Phase 0 still owed that
eval: the fixture set, the measurements, and the scores. This change ships all
three as code. The figures come from the first run of the new workflow.

```
scripts/parse-fidelity/fixtures.ts   ten specs ──┬─► generate.ts (by hand) ─► tests/fixtures/parse/*.{pdf,png,xlsx,docx}
                                                  └─► expectedFor()         ─► tests/fixtures/parse/expected/*.json
                                                                               + manifest.json (sha256)

.github/workflows/parse-fidelity.yml  (dispatch only, GitHub runner)
   docker run docling-serve-cpu@sha256 ─► /health ─► run.ts measure
        DOC_PARSER_BASE_URL=127.0.0.1 ─► resolveDocumentParser() ─► the app's Docling client
        docker stats, back to back      ─► idle + peak memory and CPU
   ─► record (counts only) ─► run.ts summarize (score.ts recomputes every figure)
```

## Files

| File | Role |
| --- | --- |
| `scripts/parse-fidelity/fixtures.ts` | the ten specs, the HTML each renders from, and `expectedFor` |
| `scripts/parse-fidelity/generate.ts` | renders the files: Chromium for PDFs and scans, LibreOffice for DOCX/XLSX, ImageMagick to make a render look scanned |
| `scripts/parse-fidelity/score.ts` | heading, table-cell and row recall from raw counts; the record format; the summary |
| `scripts/parse-fidelity/run.ts` | `measure` (parse through the seam, sample the container) and `summarize` |
| `.github/workflows/parse-fidelity.yml` | the measurement on a runner, by image digest |
| `tests/fixtures/parse/` | the committed set, its expected files and manifest |
| `tests/unit/parse-fidelity.test.ts` | manifest and expectations against the specs; the scoring rules |

## Decisions

- **One spec yields both the document and its expectation.** A hand-written
  expected file can drift from the document it describes and nothing would
  notice. Here both come from the same object, and the test re-derives every
  expected file. The generator is not byte-reproducible (creation dates), so CI
  never regenerates: it checks the committed bytes against the manifest.
- **Synthetic, not public samples.** The roadmap's prompt says "public samples
  only". A real SOC 2 report excerpt is the auditor's copyright and a
  customer's description; an invented one in the same shape tests the same
  layout without either problem. Control numbers are ISO 27001's, titles are
  short paraphrases.
- **Through the seam, not straight at Docling.** `run.ts` parses with
  `resolveDocumentParser()` and `DOC_PARSER_BASE_URL`, so the figures are the
  app's client's: its media-type routing, its request options (`do_ocr`), its
  mapping of headings and tables, its limits and refusals. A figure measured
  with a different client would not be the product's.
- **Three figures, one more than the roadmap names.** Table-cell recall is a
  multiset over the document's tables together, because a table across a page
  break legitimately comes back as two tables. That makes it blind to cells
  found but scattered, so row recall (an expected row whole within one reported
  row) says whether a table came back as a table.
- **No fuzzy matching.** Comparison is on NFKC, case-folded, whitespace-collapsed
  text. An OCR error is a miss: counting near hits would hide what the scans are
  there to measure.
- **Heading level is recorded, never scored.** A PDF carries no reliable depth,
  and Docling reports most section headers at one level.
- **Counts only, rates recomputed.** The record stores found and expected per
  document; `summarizeRecord` recomputes every figure, refuses a record that
  carries a rate, an empty record, or counts where found exceeds expected
  (G11, and "zero is never complete"). A refused document counts as found
  nothing.
- **On a runner, by digest.** The capacity rule keeps a new container off the
  production VM until measured. The image is docling-serve-cpu v1.38.2
  (published 2026-10-27), pinned by its multi-arch index digest; the two later
  releases were days old. Memory is the figure the capacity budget's parser
  row needs (a 3 GB estimate until now); CPU and latency are a runner's.
- **RAGFlow is not run.** D-L4-4 makes its measurement conditional on Docling
  failing, so 0.2 waits on this workflow's result rather than running beside it.
- **What "fails" means is not decided here.** The set has no pass floors yet.
  Proposing them belongs with the first figures, in 0.5's memo, for the owner.
