# 2026-11-27 — Catalogue headings in Bulgarian

Step 2 of #5996, owner decision of 2026-11-27: translate every heading
first, everywhere, then the long texts family by family.

## Design

A heading is a catalogue string held under `name`, `title`, `category`,
`section`, `label` or `suggestedRole`: what lists, menus and pickers show.
`catalogueHeadings()` in `scripts/content-i18n/sources.ts` names them; there
are 2,765 across 26 families, and every one now has Bulgarian text in
`src/data/content-i18n/bg/<family>.json`. The coverage ratchet holds the
long texts to their per-family baseline and now also asserts that no
heading is untranslated, so a new control or task name arrives with its
Bulgarian text in the same diff.

## Files

| File | Role |
| --- | --- |
| `src/data/content-i18n/bg/*.json` | One dictionary per family, keyed by the exact English text |
| `src/data/content-i18n/bg/index.ts` | Registers each dictionary |
| `scripts/content-i18n/glossary-bg.md` | The terminology every dictionary follows |
| `scripts/content-i18n/sources.ts` | `catalogueHeadings()`; the CISO toolkit counted as policy templates |
| `tests/guardrails/content-i18n-coverage.test.ts` | No untranslated heading; long-text baseline |
| `tests/unit/content-i18n/dictionary.test.ts` | A heading that is only a proper name may keep its source text |

## Decisions

- **One glossary, built before any translation.** The interface's own words
  (`messages/bg.json`) for the product's concepts, the official Bulgarian
  editions for the EU acts (GDPR, NIS2, DORA, the AI Act and the drone
  regulations, read from the Publications Office text) and the БДС wording
  for ISO titles. Where they disagree inside an act's own family, the
  official wording wins.
- **Terms that differ from today's interface:** Clause = „Точка“ (the
  interface page says „Клаузи“), AI system = „система с ИИ“, inventory =
  „опис“, privacy = „неприкосновеност“ (confidentiality keeps
  „поверителност“), unauthorized = „неразрешен“. Aligning the interface is
  a later step.
- **Kept in Latin:** CSIRT (as the interface writes it), PIMS, AIMS and BCMS
  (no established Bulgarian acronym), and every standard, framework or
  protocol name. ISMS = „СУСИ“, QMS = „СУК“.
- **Drone family follows the regulation, not common usage:** „неограничена“
  категория and „основен сценарий“ are the official edition's words; the
  more familiar „открита“ / „стандартен“ were checked against it and
  rejected.
- Every heading was translated against the glossary and then read again by a
  second pass that corrected meaning, terms, agreement and official titles.
