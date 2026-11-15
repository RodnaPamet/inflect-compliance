# 2026-11-14 — ASVS V2.6.1 / V11.1.6 leave the L1 tier in existing databases

**Commit:** see the branch `claude/asvs-recategorise-5316` (#5316 item 7 follow-up,
owner decisions of 2026-11-14).

## Design

#5644 corrected V2.6.1 and V11.1.6 from L1 to L2 and dropped both from the L1
catalogue (`prisma/fixtures/asvs-l1-control-templates.json`). `applyCatalogFile`
only adds rows and links, so a database that applied the catalogue before then
kept both `OWASP-ASVS` rows categorised L1 and linked to ASVS-V2 / ASVS-V11, and
every later pack install still linked a tenant's control to them.

A CatalogFile can now declare `outOfScopeRequirements`: requirements it no longer
declares, each with the category the existing row moves to and the templates of
this file whose link to it is removed. On every apply — so at every container
start, through `scripts/seed-framework-catalogs.ts` — the applier, for each entry
whose row exists:

- sets the row's `category`;
- deletes the `ControlTemplateRequirementLink`s from the named templates.

A fresh database never holds the rows, so nothing happens there. The step is
idempotent: a second apply re-categorises nothing and removes nothing.

The ASVS fixture declares V2.6.1 (L2, unlink from ASVS-V2) and V11.1.6 (L2,
unlink from ASVS-V11).

Two smaller ASVS fixes ride along:

- **V7.1.1 / V7.1.2 titles were swapped.** In ASVS 4.0.3, V7.1.1 is "does not log
  credentials or payment details" (session tokens only hashed) and V7.1.2 "does
  not log other sensitive data". Library and catalogue now say so; library
  version 3, `text_hash` recomputed. The catalogue applier rewrites requirement
  titles and descriptions on every apply, so existing `OWASP-ASVS` rows follow.
- **`asvs-to-iso27001` (described as Level 1) dropped its V2.6.1 and V11.1.6
  edges**, version 3. Its sources are now exactly the 129 L1 requirements. The
  mapping-set importer retires (`validTo = now`) an entry that left its file
  (#4204), so existing databases stop reading the two edges.

## Files

| File | Role |
| --- | --- |
| `prisma/catalog-loader.ts` | `outOfScopeRequirements` schema and its consistency checks |
| `prisma/catalog-applier.ts` | step 5b: re-categorise and unlink; `outOfScope` counts in the result |
| `scripts/seed-framework-catalogs.ts` | prints the counts |
| `prisma/fixtures/asvs-l1-control-templates.json` | the two entries; V7.1.x titles |
| `src/data/libraries/owasp-asvs-4.0.3.yaml` | V7.1.x titles, version 3 |
| `src/data/libraries/mappings/asvs-to-iso27001.yaml` | two edges removed, version 3 |

## Decisions

- **The catalogue sync, not a migration.** It reaches every database at the next
  container start, is a no-op on a fresh one, and stays declared beside the
  content it corrects. A migration would run once against whatever catalogue
  state a database had at that moment, and is forward-fix only.
- **Declared, not inferred.** The applier does not prune every link the file
  does not declare. `ControlTemplateRequirementLink` records no writer, and
  production's catalogue was built by several writers over time, so a general
  prune on every start could remove links nobody meant to retract. Each entry
  names the requirement and the templates; a link from any other template stays
  (the integration test plants one and checks it survives).
- **The rows stay.** The owner decided to re-categorise, not remove: a tenant's
  control linked to V2.6.1 keeps that link, and its tasks and evidence are not
  read. The applier never reads `ControlRequirementLink`.
- **Only `category` moves.** The catalogue does not otherwise update `category`
  on existing rows; widening that to every requirement of every catalogue file
  would change rows other writers set. The entry is the one place a category is
  corrected.
- **The L1 templates keep their tasks** (owner decision): ASVS-V2's single-use
  lookup-code task and ASVS-V11's concurrency task are unchanged.
- **`asvs-to-ssdf` is left as it is.** It is also described as Level 1 and also
  carries V2.6.1 and V11.1.6 (and lacks V3.7.1, V7.1.1, V7.1.2), but the owner's
  decision named the ISO set; it is reported for a decision.
