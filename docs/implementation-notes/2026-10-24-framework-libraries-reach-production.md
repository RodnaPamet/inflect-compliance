# 2026-10-24 — Framework libraries and crosswalks reach production

**Commit:** _(stamped post-commit)_ `feat(frameworks): sync the framework libraries and crosswalks at container start`

## Design

`syncAllLibraries` is the only writer of library framework rows and of
`RequirementMapping`. Nothing a deployment runs called it: not the entrypoint,
not a job, not a workflow. So every crosswalk in `src/data/libraries/mappings/`,
and every surface that reads them (inherited coverage on a framework page, gap
analysis, traceability), worked in tests and on databases somebody had synced by
hand, and nowhere else. This includes the AIUC-1 crosswalks of #4060 and #4087
and the inherited-coverage panel of #4082.

The fix is a fifth seeding step, run after the catalogue seed:

```
entrypoint 1e  node dist/seed-framework-catalogs.mjs     catalogue rows, with packs
entrypoint 1f  node dist/sync-framework-libraries.mjs    library rows + mapping sets
                 └─ syncLibrariesAtStartup
                      ├─ owned = keys of rows that have a pack
                      └─ syncAllLibraries({ librariesDir, mappingsDir, skipFrameworkKeys: owned })
```

The rest of the change makes that step safe to run against a live database.

- **One writer per row.** `AIUC-1` and `COSO-ICF-2013` share a framework key
  between the library and the catalogue fixture. The two writers disagree on
  COSO: its 17 library descriptions are long-form, and the fixture's summaries
  are short. They also write different `version` and `metadataJson` values.
  The sync leaves every row with a pack to the catalogue. The library importer
  never creates a pack, so this needs no list.
- **One row per framework on the offer lists.** The library rows are 16 new
  `Framework` rows, and most of them are a second representation of a
  catalogue framework (`ISO27001-2022` beside `ISO27001`). `withoutReferenceTwins`
  drops a pack-less row from `listFrameworks` and from the control-mapping
  picker when its family has an installable row. A library-only framework
  (GDPR, NIST CSF 2.0) stays listed.
- **DORA and NIS2 join their families.** Their catalogue fixtures carried no
  `sourceUrn`, so their library twins formed families of their own and would
  have been listed. Both fixtures now carry the library urn, and the catalogue
  applier writes it on every start.
- **The YAML ships in the image.** The runtime stage copied `prisma/` and
  `dist/` but not `src/data/libraries/`. It does now, and the script passes the
  directory explicitly, because `LIBRARIES_DIR` resolves from `__dirname`,
  which in a bundle is `dist/`.

Measured against a fresh, migrated database, using the real bundles in
entrypoint order:

- **First run:** 16 libraries created and 17 rows left to the catalogue. All 44
  mapping sets imported, 1,539 entries, in 7 seconds.
- **Second run:** every library and every set unchanged.

## Files

| File | Role |
|---|---|
| `scripts/sync-framework-libraries.ts` | The container-start script; counts mapping sets the importer dropped and exits non-zero |
| `src/app-layer/usecases/library-sync.ts` | `syncLibrariesAtStartup`; `syncAllLibraries` takes directories and keys to skip |
| `src/app-layer/services/library-importer.ts` | `importAllFromDirectory` skips the listed keys |
| `src/app-layer/domain/framework-representation.ts` | `withoutReferenceTwins` |
| `src/app-layer/usecases/framework/catalog.ts`, `usecases/control/mappings.ts` | The two offer lists apply it |
| `prisma/fixtures/dora-control-templates.json`, `nis2-control-templates.json` | `sourceUrn` |
| `scripts/entrypoint.sh`, `scripts/build-worker.mjs`, `Dockerfile`, `package.json` | Step 1f, its bundle, the YAML in the image, `db:sync-libraries` |
| `tests/integration/framework-library-startup-sync.test.ts` | What the sync writes and leaves alone, and the offer lists |
| `tests/guardrails/catalogue-reaches-production.test.ts` | The four links of the delivery path, folded into the catalogue's own delivery guard |
| `tests/unit/framework-representation.test.ts` | The DORA and NIS2 ties, and the offer rule |

## Decisions

- **Owner decisions, 2026-10-24.** A library row with a catalogue twin is kept
  off the lists that offer frameworks. The library-only frameworks are shown.
- **"Has a pack" rather than the catalogue fixture list.** The list lives in
  `seed-framework-catalogs.ts`, which runs its seed when imported, and ten tests
  parse it out of that file's source. Moving it would touch all ten. Reading
  ownership from the database also covers a library that later gains a
  catalogue fixture.
- **What importing over a shared row would have done.** A mutation run of the
  integration test with the skip disabled settled it. It rewrites the row's
  descriptions, version and metadata until the next start puts the catalogue's
  back. It puts no control up for review on that first run, because the
  importer records a diff only from two version-history entries, and a
  catalogue-written row has none. The harm comes later. COSO's fixture carries
  no metadata, so the history survives on its row, and the next COSO library
  version would diff against the catalogue's summaries and mark every linked
  control NEEDS_REVIEW.
- **NIS2 is tied although its codes are disjoint.** The library has 12 domain
  codes (`NIS2-RM`), and the catalogue has 20 Article 21 points
  (`Art.21(2)(a)`). The family is one framework at two granularities, so a
  crosswalk join across them reaches nothing: a missing join, not a wrong one.
  The unit test asserts the namespaces share no code, so an overlap is checked
  before anyone trusts it. DORA's 24 codes and titles are identical across both
  representations, so its tie lets crosswalks that cite `DORA-2022` reach
  tenants' DORA controls.
- **Delta propagation stays on.** On a fresh database the first run only
  creates rows, so it records no diff. A later library version bump notifies
  installed tenants, as the importer was built to.
- **Ten mapping entries do not resolve, and this change does not fix them.**
  They are in `iso27001-to-iso27701` (8) and `iso27701-to-gdpr` (2), and they
  cite clause-group nodes (`5` … `8`) that their libraries do not make
  assessable. No requirement row exists for those nodes. That is crosswalk
  content, independent of delivery, and the script prints the count on every
  run.
- **The compliance-posture signal inherits the filter.** It reads
  `listFrameworks`, as it already did for the retired-framework filter. A
  hidden library row is dropped from it. Before this change no deployment step
  created library rows, so a tenant can hold links on one only on a database
  somebody synced by hand.
