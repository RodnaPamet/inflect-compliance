# 2026-10-25 — Crosswalk entries that named a heading

**Commit:** `fix(frameworks): resolve or remove the crosswalk entries that named a heading`

## Design

`library-importer.ts` writes a `FrameworkRequirement` row only for an assessable
node. A mapping-set entry naming a non-assessable node (a heading) has nothing
to resolve against, so `mapping-set-importer.ts` logs it and moves on. Ten
entries did that in every database. The startup sync (#4106) reported them, and
`tests/guardrails/mapping-targets-exist.test.ts` held their 13 references under
a downward ratchet rather than refusing them.

The ten all named ISO 27701 clauses 5 to 8, or ISO 27001 management clauses:

| Entry | Named | Now |
|---|---|---|
| ISO 27001 `5`, `6`, `8` → 27701 `5` | headings on both sides | removed |
| A.5.34 → 27701 `7`, A.5.34 → 27701 `8` | 27701 clause as a whole | removed |
| A.5.1, A.5.24, A.5.26 → 27701 `6` | 27701 clause 6 | resolves as written |
| 27701 `6` → GDPR Art.33, Art.34 | 27701 clause 6 | resolves as written |

Clause 6 is the one that changed. In the ISO 27701 library it had no sub-clause,
so it was a heading over nothing. The catalogue that installs ISO 27701
(`prisma/fixtures/iso27701-control-templates.json`) already ships it as a
requirement, under the same category, and links PIMS-10 Privacy Breach Handling
to it. Library version 2 makes it assessable. That restores the
breach-notification path from ISO 27001 incident management through clause 6 to
GDPR Articles 33 and 34.

The guard now refuses any reference to a heading, with no ceiling.

## Files

| File | Role |
|---|---|
| `src/data/libraries/iso27701-2019.yaml` | v2: clause 6 assessable; clause 5 stays a heading; `text_hash` updated |
| `src/data/libraries/mappings/iso27001-to-iso27701.yaml` | v2: five entries removed; header and description say why |
| `src/data/libraries/mappings/iso27701-to-gdpr.yaml` | v2 with no entry changed, so a database holding v1 imports it again |
| `tests/guardrails/mapping-targets-exist.test.ts` | heading references fail outright; the ceiling is gone |
| `tests/guardrails/section-axis-is-structural.test.ts` | ISO 27701 pin 2 → 3 sections (PIMS Controls joins) |
| `tests/integration/framework-library-startup-sync.test.ts` | every entry of every shipped set resolves, not just every set |
| `tests/integration/crosswalk-entries-reach-an-existing-database.test.ts` | a database holding v1 goes through the upgrade, with and without the set bump |
| `docs/requirement-mapping-sets.md` | `iso27001-to-iso27701` entry count 14 → 9 |

## Decisions

- **Clause 5 stays a heading.** Making it assessable failed
  `library-obligations-reach-the-catalogue`: the ISO 27701 catalogue does not
  ship it. It extends ISO 27001's management clauses, which the ISO 27001
  catalogue does not ship either (Annex A only). An assessable clause 5 would
  declare an obligation no tenant receives. The three entries into it also
  started from ISO 27001 headings, so making it assessable would have resolved
  none of them anyway.
- **The management-clause entries are removed, not re-aimed.** The same call
  the COSO crosswalk made for clauses 9 and 10
  (`2026-09-20-coso-framework.md`): no leaf on either side expresses the
  relationship, and an entry that resolves but misstates it reads as coverage.
- **A.5.34 → clause 7 and → clause 8 are removed, not fanned out.** Each said
  A.5.34 expands into the whole of a clause. Fanning that out to the 28 and 15
  controls under them would invent per-control claims nobody judged.
  A.5.34 → 7.2.5 already carries the control-level one. A.5.34 → clause 6
  (whose 6.15.1.4 extends the ISO 27002:2013 control A.5.34 succeeds) would be
  a new claim, so it is not added here.
- **`iso27701-to-gdpr` is bumped with no entry changed.** The importer skips a
  set whose hash matches the stored one. In a database that imported v1, the
  two clause-6 entries are missing, and an unchanged file would never be
  imported again to add them. The integration test proves that both ways. After
  this change the guard refuses any entry the library cannot resolve, so a set
  can no longer be imported ahead of its node, and this kind of bump should not
  be needed again.
- **The ISO 27701 library diff reaches tenants as one new requirement.** v1 → v2
  records `added: [6]`, nothing changed or removed, so no control is put up for
  review. `propagateFrameworkDelta` reaches only tenants with controls linked
  to the `ISO27701-2019` copy, which the offer lists keep hidden.
