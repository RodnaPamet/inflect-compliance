# 2026-10-24 — A library's text change reaches the databases that already hold it

**Commit:** _(stamped post-commit)_ `fix(frameworks): make a library or crosswalk text edit reach databases that already hold it`

## Design

Both importers skip a file whose content hash matches the stored one, and
neither hash covered the text. A library's hash is its URN, its version and
its node URNs. A mapping set's hash was its URN, its version, its framework
refs and each entry's source, target and strength. So a reworded requirement,
copyright line or rationale under the same version was skipped by every
database that already held the file.

That didn't matter while nothing synced in a deployment. Since the container
start runs the library sync (2026-10-24), it means a wording fix never reaches
production. #4098 was the first instance: it reworded six crosswalk rationales
and bumped no version.

The two file kinds get different fixes, because they keep different records:

| | Library | Mapping set |
|---|---|---|
| Records a version diff, notifies tenants | yes (`FrameworkVersionDiff`, one per `from → to`) | no |
| Fix | the text change must bump `version`; a guard enforces it through `text_hash` | the hash covers the whole parsed set |

**Libraries.** `computeLibraryTextHash` is SHA-256 over the canonical JSON of
the parsed library minus `version` and `text_hash`. Each file records it as
`text_hash`, beneath `version`. A block in
`tests/guardrails/catalogue-reaches-production.test.ts` fails while the two
disagree, and names the version to bump to and the hash to write.

**Mapping sets.** `computeMappingSetHash` is SHA-256 over the canonical JSON of
the whole parsed set. On the next sync after this change, every set hashes
differently and re-imports once. The import is an upsert, so this rewrites the
rows with the content they already hold.

## Files

| File | Role |
|---|---|
| `src/app-layer/libraries/library-loader.ts` | `computeLibraryTextHash`; why the import hash leaves the text out |
| `src/app-layer/libraries/schemas.ts`, `index.ts` | the `text_hash` field; the export |
| `src/data/libraries/*.yaml` | `text_hash` recorded in all 18 libraries |
| `src/app-layer/services/mapping-set-importer.ts` | `computeMappingSetHash` over the whole set |
| `tests/guardrails/catalogue-reaches-production.test.ts` | the text-hash check, beside the delivery checks |
| `tests/unit/library-loader.test.ts`, `mapping-set-importer.test.ts` | what moves each hash and what does not |

## Decisions

- **For a library, a version bump rather than text in the import hash.**
  Text in the hash would deliver the edit too. But under the same version the
  importer records a `vN → vN` diff. A second such edit would upsert onto that
  row through `@@unique([frameworkKey, fromVersion, toVersion])` instead of
  getting its own, so the tenants told of the first change would not be told
  of the second.
- **What the check cannot see.** CI checks out one commit, so the guard never
  sees the version a file had on the base branch. An edit that rewrites
  `text_hash` and keeps `version` passes. That edit is a deliberate change to
  the line beside the version, in the diff a reviewer reads. The common case is
  a forgotten bump, and the check catches it.
- **The hash is stored in each library, not in one lock file.** One shared
  file listing every library would be edited by every library PR. That is the
  contention this repo already removed from `doc-classification.json`.
- **Comments and formatting do not move the hash.** It is taken over the
  parsed library, so neither does writing out a value the schema would default.
- **Folded into the delivery guard rather than given a file.** It is that
  file's invariant, that what the repo ships reaches production, and the
  guard-file ceiling in `no-epic-named-ratchets` admits a new file only when no
  existing guard covers the population.
- **Not addressed: removing a crosswalk entry.** A removed entry's
  `RequirementMapping` row stays, because the importer upserts and never
  deletes. That is a separate defect.
