# 2026-11-27 — The document parser, measured: Docling stays (D-L4-4 memo, D-L4-12)

## Design

Document parsing's Phase 0 asked for a fidelity set, a measured footprint and
scores, so that D-L4-4 (a Docling-class parsing-only service, RAGFlow only if
Docling fails) rests on numbers. The set and its workflow landed in #5987;
this note records what they measured and what the owner decided.

The measurement is the `Parse fidelity` workflow: docling-serve v1.38.2 (CPU
image, by digest) on a 4-core GitHub runner, the ten-document set parsed
through the app's own `DocumentParser` seam, the container sampled with
`docker stats` from start to the last document.

**Footprint** (run 46022242747, AMD EPYC, 4 cores, 16 GB):

| | Value |
| --- | --- |
| Containers | 1 |
| Image on disk | 2.07 GiB |
| Start to healthy | 20.4 s |
| Idle memory | 781 MiB |
| Peak memory while parsing | 2,314 MiB |
| Peak CPU while parsing | 393% (all four cores) |

**Fidelity** (counts recomputed from the run's record):

| Slice | Heading recall | Table-cell recall | Row recall |
| --- | --- | --- | --- |
| All ten documents | 97.7% (43/44) | 91.3% (473/518) | 61.5% (72/117) |
| Born-digital PDFs | 100% (18/18) | 84.4% (222/263) | 28.1% (16/57) |
| Scans (OCR) | 85.7% (6/7) | 96.7% (29/30) | 90.0% (9/10) |
| Bulgarian | 100% | 100% | 100% |
| Spreadsheets | n/a | 98.8% (168/170) | 94.1% (32/34) |
| Word | 100% | 100% | 100% |

Per document, the one real miss is `04-soa-two-page`, the Statement of
Applicability whose table crosses page breaks: three tables reported for one,
189 of 230 cells, 5 of 46 rows whole. That one document holds 41 of the set's
45 missed rows. The other misses are small: the scanned test summary's title
was not reported as a heading, and three documents lost one or two cells each.

## Files

| File | Role |
| --- | --- |
| `docs/ai-architecture/ragflow.md` | Phase 0 ticked with its figures; 2.5 (stitch tables across a page break) and 3.4 (the floors in the nightly) added |
| `docs/ai-architecture-roadmap.md` | D-L4-12 in the decision table; the status board row; the capacity budget's parser line measured |
| `scripts/parse-fidelity/score.ts` | `PARSE_FIDELITY_FLOORS` and `floorVerdicts`, shown in every summary |
| `tests/unit/parse-fidelity.test.ts` | the floors' values and how they judge |

## Decisions

- **Docling stays; RAGFlow is not measured** (D-L4-12, owner). D-L4-4 made
  RAGFlow conditional on Docling failing. Docling's one failure is a known,
  narrow shape: a table continued across a page break comes back in pieces.
  The cells are mostly there and the rows are not. Stitching consecutive
  tables on consecutive pages with the same columns (dropping a repeated
  header) is a few dozen lines in the indexing path (ragflow.md 2.5). Standing
  up RAGFlow would be a second product (server, search engine, MySQL, MinIO,
  Redis) to answer the same question. The page-break table cannot simply be
  accepted, though: a long SoA or control register is exactly what the product
  holds, so 2.5 is a requirement, not an option.
- **The floors are 95 / 90 / 80** (owner): heading, table-cell and row recall,
  each over the whole set. Docling passes the first two today and misses rows
  until 2.5 lands. Row recall has its own floor because cell recall alone
  would pass a table that came back as a word list.
- **Reported now, enforced from Phase 3** (owner). Every summary shows each
  floor as met or missed. A miss fails the job only once Phase 3's nightly
  exists and its dated non-blocking marker has passed, the way DAST's did.
- **The memory limit stays at 3,072 MiB.** The planned limit was an estimate;
  the measured peak is 2,314 MiB on these ten short documents. The limit keeps
  about 760 MiB for longer documents (the input cap is 20 MiB), so the window
  rule's check is unchanged. The image is 2.07 GiB, not the 4.4 GB the budget
  assumed: the disk figure was the earlier image's.
- **The first run measured plumbing, and that was the finding.** Run
  46015201223 had every document refused 422: the app's Docling client still
  sent docling-serve's retired `file_sources` field. No production path calls
  the client yet, so the fault was latent. #5991 moved the client to the v1
  `sources` shape with an in-body target, and made a run whose requests are
  refused fail instead of reporting zeros.
- **Latency is not measured precisely.** Per-document times arrive in 2-second
  steps, which looks like the service's own completion polling on its
  synchronous endpoint. Throughput is not what the window rule budgets, so it
  is recorded as a limit of this measurement rather than chased.
- **Dependency governance.** The image is digest-pinned in the workflow. When
  Phase 1.3 adds its Compose service, `tests/guardrails/runtime-image-pinning.test.ts`
  requires the same pin there, so no separate baseline entry is needed.
