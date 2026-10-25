# 2026-10-25 — Crosswalk entries retire with their file, and the seed gets the crosswalks

**Commit:** `fix(frameworks): retire crosswalk entries removed from their file, and seed the libraries and crosswalks`

## Design

Three follow-ups to the startup library sync (#4106) and the heading-entry
cleanup (#4177), each approved by the owner on 2026-10-25.

**An entry removed from a mapping-set file retires its mapping.**
`importMappingSet` upserted every entry and deleted nothing. An entry taken out
of a file therefore stayed an active `RequirementMapping` in every database
that had imported it, and gap analysis, traceability and inherited coverage
kept reading a relationship the file had withdrawn.

`RequirementMapping` already has a validity window (`validFrom`, `validTo`,
Audit Coherence S9), and every read applies it through `activeMappingWindow`.
So the importer now retires the row instead of deleting it:

```
import a changed set
  upsert each resolved entry          (validTo := null, so a re-added entry revives its row)
  for each ACTIVE row of the set:
    pair named by an entry in the file?  yes → keep
                                         no  → validTo := now   (retired, history kept)
```

The per-set "mappings" count that `listAvailableMappingSets` shows now counts
active rows only.

**ISO 27001 A.5.34 → ISO 27701 clause 6.** This is a new `RELATED` entry, the
strength the other three clause-6 entries carry. Clause 6 became assessable in
#4177. Its 6.15.1.4 extends 18.1.4, the ISO 27002:2013 control that A.5.34
replaces. The set goes to version 3.

**`prisma/seed.ts` gets what the container start gets.** The seed builds dev
and E2E databases and called no library sync, so those databases had no
crosswalk at all. It now calls `syncLibrariesAtStartup`, the function the
container start calls. It first applies the COSO and AIUC-1 catalogues, which
it never applied. Those two declare the same key as their library, and the sync
leaves alone a row that has a pack. Without the catalogue rows, the sync would
have written the library's rows instead: the opposite owner from production,
and nothing installable.

## Files

| File | Role |
|---|---|
| `src/app-layer/services/mapping-set-importer.ts` | Step 6, retirement by pair of codes; revival in the upsert; `retired` in the result |
| `src/app-layer/repositories/RequirementMappingRepository.ts` | `mappingSetInclude()` counts active mappings, read at call time |
| `src/app-layer/usecases/library-sync.ts`, `scripts/sync-framework-libraries.ts` | `retired` in the sync summary and in the container-start log line |
| `src/data/libraries/mappings/iso27001-to-iso27701.yaml` | A.5.34 → 6; version 3 |
| `prisma/seed.ts` | COSO and AIUC-1 catalogues, then the library sync, failing the seed on anything dropped |
| `tests/integration/crosswalk-entry-retirement.test.ts` | Retire, re-import idempotence and revival against Postgres, read through the product's repository and usecase |
| `tests/unit/mapping-set-importer.test.ts` | Mock shape for the new read; retirement unit cases |
| `tests/integration/crosswalk-entries-reach-an-existing-database.test.ts` | Re-runnable: clears its own framework's diff rows rather than filtering on `createdAt` |
| `tests/guardrails/catalogue-reaches-production.test.ts` | The seed runs the sync, and applies every catalogue sharing a key with its library before it |
| `docs/requirement-mapping-sets.md`, `docs/data-retention.md` | Retirement documented; entry count 9 → 10 |

## Decisions

- **Retire, never delete.** The validity window exists so an auditor can ask
  what a crosswalk said at a date. Deleting would erase the answer, and the
  window was already applied on every read path, so retiring needs no reader
  to change.
- **Retirement compares pairs of codes, not resolved ids.** A row stays active
  exactly while some entry in the file names its pair, which is how the file
  reads. An entry that fails to resolve this run still names its pair, so it
  retires nothing.
- **Revival reuses the row and keeps its `validFrom`.** `@@unique([mappingSetId,
  sourceRequirementId, targetRequirementId])` allows one row per pair, so a
  re-added entry clears `validTo` on the old row. The gap while it was retired
  is not recorded. Recording it would need a second row per pair, which the
  unique key forbids.
- **The seed fails where the container start only logs.** In a deploy, a
  crosswalk that did not import is logged and the deploy continues. In dev and
  E2E, it fails the seed: a database that silently lacks part of the catalogue
  is the drift this change closes, and `mapping-targets-exist` already refuses
  an entry that cannot resolve, so the seed should never hit it.
- **The guard derives which catalogues the seed must apply.** It takes the
  catalogue seeder's fixtures whose framework key a library also declares,
  today AIUC-1 and COSO. A third such framework joins the check without an
  edit.
- **The internal-controls catalogue is still not in the seed.** The production
  seeder applies `internal-controls-catalog.json` (the 151-control library's
  framework and pack); `seed.ts` applies the controls through
  `seedInternalControls` but not that pack. It is unrelated to the library
  sync, so it was left out of this change.
