# NIS2 gap-assessment data — attribution & licence

`nis2-gap-assessment.json` in this folder is **imported third-party
content**, not original work. Its licence is independent of the
repository's own licence and **must travel with the data**.

## Source

- **Project:** NIS2 Gap Assessment (open data format)
- **Repository:** https://github.com/NISD2/nis2-gap-assessment-schema
- **Maintainer:** Kardashev Catalyst UG (haftungsbeschränkt) / nisd2.eu
- **Imported version:** `2.0.3` (upstream `lastUpdated: 2026-04-28`)
- **Imported on:** 2026-06-26

## Licence — CC BY 4.0 (content)

The upstream repository is **dual-licensed**: code (Zod schema, scoring
logic, TypeScript types) under **MIT**, and the *content* — questions,
descriptions, legal citations, domain definitions — under
**Creative Commons Attribution 4.0 International (CC BY 4.0)**:

> https://creativecommons.org/licenses/by/4.0/legalcode

**We import the CONTENT only** (the questions, domains, legal bases, and
bilingual text). We do **not** vendor any of the upstream code. CC BY 4.0
permits commercial use, sharing, and adaptation **provided appropriate
credit is given** — there is no ShareAlike / copyleft obligation, so
importing it carries no licence-contamination risk for this product.

### Required attribution

The credit below is reproduced in the data file header (`attribution`
field), and MUST also be surfaced anywhere the questions are displayed to
end users (the eventual gap-assessment UI):

> Based on the NIS2 Gap Assessment by Kardashev Catalyst UG / nisd2.eu,
> licensed under CC BY 4.0.
> https://github.com/NISD2/nis2-gap-assessment-schema

## What we changed at import

- The upstream integer enums (`criticality: 3`, `respondent: 0`, …) are
  translated to our string enums (`CRITICAL`, `CEO`, …) by
  `scripts/sync-nis2-gap-assessment.ts` so the rest of the codebase never
  handles magic numbers. This is an adaptation permitted under CC BY 4.0;
  the substantive content (question text, legal bases) is unmodified.
- Provenance fields (`source`, `license`, `attribution`, `importedAt`)
  are added by the sync script.

## Bulgarian translation

The 116 question texts and 15 domain names are also offered in Bulgarian,
in `src/lib/nis2/gap-assessment-bg.json`. The translation was made by
Inflect and is a derivative work of the upstream content, published under
the same CC BY 4.0 licence with the attribution above. It translates the
wording only: the legal bases and the references to German bodies and
procedures (the BSI, its registration portal, German company forms) are
kept as the upstream states them and are not adapted to Bulgarian law.
The English fixture stays the source of record — a re-sync that changes a
question's English text does not update its Bulgarian text, and the unit
test `tests/unit/nis2-gap-bg.test.ts` fails when a question or domain has
no Bulgarian entry.

## Re-syncing

This file is a **pinned snapshot**, vendored deliberately so the build is
hermetic (no network fetch at seed time). To pull a newer upstream
version, run `npx tsx scripts/sync-nis2-gap-assessment.ts` — it re-fetches,
re-translates, re-validates against the Zod schema, and rewrites both the
JSON and this version stamp. Re-syncing is an operator decision, never
automatic.
