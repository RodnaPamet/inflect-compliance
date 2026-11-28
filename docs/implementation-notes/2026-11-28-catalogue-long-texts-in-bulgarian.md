# 2026-11-28 — Catalogue long texts in Bulgarian

**Commits:** #6003, #6004, #6005 and the final batch (#5996, step 4).

## Design

Step 4 of #5996 translated the long catalogue texts: descriptions,
objectives, guidance, success criteria, testing methodology, checklist steps,
evidence hints and owner hints. That is 35,951 strings (about 5.9 million
characters) across 26 families, on top of the 2,765 headings from step 2.

The texts were exported per family and cut into chunks of at most 160 strings
and about 30,000 characters, 275 chunks in all. Each chunk went through two
agents:

1. **A translator.** It worked from the family's glossary: the heading rules,
   the long-text rules and fixed terms, and that family's heading glossary,
   with the official Bulgarian EU texts as references where a family has one.
2. **An independent reviser.** It read the chunk against the same glossary,
   corrected it, and reported what it changed and what it still doubted.

A mechanical validator checked every chunk before it was accepted:

- the same number of line breaks;
- URLs and `{placeholders}` preserved;
- list markers on the same lines;
- no surrounding whitespace;
- Cyrillic text, unless the source is a name returned byte-identical.

Once a batch was done, a consistency pass read the revisers' doubts and
counted every competing rendering of a term across the family. It settled
each term on one rendering and fixed already-shipped dictionaries when a term
moved. Those decisions are recorded in `scripts/content-i18n/glossary-bg.md`,
under "Terms settled across families when the long texts were translated".

## Files

| File | Role |
|---|---|
| `src/data/content-i18n/bg/<family>.json` | The dictionaries: keyed by the exact trimmed English text, sorted. |
| `scripts/content-i18n/glossary-bg.md` | Gains the long-text style rules, the fixed long-text terms and the cross-family decisions. |
| `tests/guardrails/content-i18n-coverage.test.ts` | Now asserts that no catalogue string is untranslated, in any family. |
| `tests/guardrails/content-i18n-coverage.baseline.json` | Deleted: the per-family countdown reached zero. |

## Decisions

- **One PR per alphabetical batch, not per family.** Every batch rewrites the
  coverage baseline, so per-family PRs would have conflicted on one file. Each
  later batch was stacked on the previous one. A squash merge leaves the
  stacked branch with a different commit for the same content, so the
  resulting conflict is always resolved with the stacked branch's version,
  which is the superset.
- **The baseline became an absolute rule once it reached zero.** A countdown
  with nothing left to count only invites a non-zero entry back. The test now
  lists up to five untranslated strings per family, which is enough to find
  the edit that added them.
- **Terms follow the official Bulgarian texts where one exists.** The drone
  terms follow Regulations 2019/947 and 2019/945. The DORA RTS/ITS are spelled
  out as the regulation does. "Timestamp" is the eIDAS „времеви печат“.
- **"Open" is never „открит“** for an open item, because it reads as
  "discovered"; it is „неприключен“. Every remaining „открит“ was checked
  against its English source: each one means "found" or "open sources".
- **The translation is display-only.** A tenant-edited text is shown as
  written. A source string that changes loses its translation until the
  dictionary gains the new text, and the coverage test now fails CI when that
  happens.
