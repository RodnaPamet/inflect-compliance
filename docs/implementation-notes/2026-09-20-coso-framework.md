# 2026-09-20 — COSO ICF 2013: framework, requirements, crosswalks

**Commit:** `<sha>` feat(frameworks): COSO ICF 2013 — framework, requirements and crosswalks

Prompt 1 of a five-part pack. Control templates and tasks are the later PRs;
this lands the framework, its 17 principles, and two crosswalks.

## Design

COSO is structurally unlike every other framework this repo ships, and that
shapes the whole implementation.

ISO 27001's Annex A **is** a control catalogue, which is why its library maps
1:1 onto 93 templates. COSO stops at 5 components and 17 principles **by
design** — organizations are expected to design their own controls. Its nearest
equivalent to a control list is the 87 "points of focus", which is the
copyrighted part. So there is no canonical COSO control list to port, and the
three-level model is:

| Level | Count | Where it lives |
|---|---|---|
| Components | 5 | grouping nodes; later `ControlTemplate.category` |
| Principles | 17 | `FrameworkRequirement`, codes P1–P17 |
| Controls | 96 | later PRs, linked via `requirementCodes` |

No schema change and no migration — confirmed, not assumed.

## Files

| File | Role |
|---|---|
| `src/data/libraries/coso-icf-2013.yaml` | 22 nodes: 5 components (non-assessable) + 17 principles |
| `src/data/libraries/mappings/coso-to-soc2.yaml` | 8 entries — the best-evidenced crosswalk |
| `src/data/libraries/mappings/coso-to-iso27001.yaml` | 5 entries — narrow on purpose |
| `tests/guardrails/coso-framework-coverage.test.ts` | enumeration, prose originality, what the crosswalks claim |
| `tests/integration/coso-framework-import.test.ts` | import → 17 rows; re-import is a no-op |

## Decisions

### Requirements live in the LIBRARY, singly

The prompt asked this to be decided and stated. `CatalogFileSchema.requirements`
is `.min(1)`, so a catalog file must also carry requirements when the content
PRs land — but the library is the **source**, and the catalog will restate the
same P1–P17 codes. `FrameworkRequirement` carries `@@unique([frameworkId,
code])`, so double-sourcing cannot silently duplicate; it throws at seed time.
That is why the re-import assertion in the integration test is about deploy
safety rather than tidiness.

### Licensing: enumeration only, every description original

The component and principle **enumeration** is public and already referenced
here — `soc2-2017.yaml` annotates CC1.1 and CC4.1 as paraphrases of COSO
Principles 1 and 16. The **body text and the 87 points of focus** are not used.
Every `description` is written from scratch, stating what an organization must
be able to demonstrate.

A guard asserts no two descriptions are identical, which catches copy-and-adjust
— the first symptom of reaching for the source. **It cannot detect paraphrase
that is merely too close.** Only a person can. A legal review is advisable
before this ships to customers, and this note is where that is recorded rather
than assumed.

### The crosswalks are deliberately incomplete, and the gaps are the content

**SOC 2 — 8 entries.** This repo's SOC 2 library carries *one* assessable node
per common-criteria series (CC1.1, CC1.2, CC2.1, CC3.1, CC4.1, CC5.1), not the
full published TSC. So P3/P4/P5, whose real counterparts are CC1.3/CC1.4/CC1.5,
are **absent** rather than mapped to whichever node exists. A mapping that
resolves but misstates the relationship is worse than a missing one: it is read
as coverage. A test pins the claimed set so a later edit cannot "complete" it.

**ISO 27001 — 5 entries, and two were written then removed.** P16 and P17 map
naturally onto clause 9 (performance evaluation) and clause 10 (improvement),
and those rows existed in the first draft. In this repo's ISO library the
clauses `"4".."10"` are **non-assessable grouping nodes**; `library-importer`
writes a `RequirementMapping` only for assessable targets, so those rows would
have reached no database at all — rendering nowhere, contributing nothing, and
existing only to make the map look more complete than it is.
`tests/guardrails/mapping-targets-exist.test.ts` caps exactly this with a
downward ratchet, which the two rows raised. There is no assessable Annex A node
for independent review or corrective action here (no A.5.35/A.5.36), so the
correspondence is stated in a comment instead of expressed weakly.

All 13 surviving entries map assessable → assessable.

### One test the prompt asked for was not written

The pack specified `tests/unit/libraries/coso-crosswalk.test.ts` asserting that
every crosswalk ref resolves on both sides.
`tests/guardrails/mapping-targets-exist.test.ts` **already does this**, over
every file in `mappings/` discovered by `readdirSync` — it picked both COSO sets
up with no change, and it is what caught the clause-9/10 problem above. A second
copy would be the one that rots. What the COSO guard adds instead is the part
that guard cannot know: which principles we chose to claim, and why the rest are
absent.

## For the content PRs that follow — a correction to the pack

The pack directs Prompts 2A–2D to author `prisma/catalogs/coso-icf-2013.yaml`.
**That path does not reach production.** `prisma/catalogs/` is referenced by one
integration test and one implementation note; the production seeder
`scripts/seed-framework-catalogs.ts`, run by `scripts/entrypoint.sh` on every
container start, reads `prisma/fixtures/*-control-templates.json`. And
`listInstallableFrameworks` offers only frameworks with **at least one pack**,
which an applied catalog creates.

Authored where the pack says, the 96 controls would be installable by nobody
without a manual CLI import per environment. `loadCatalogFile` accepts YAML or
JSON, so the correction is cheap: author under `prisma/fixtures/` and add the
file to the seeder's list. The count assertions and every other instruction in
2A–2D stand unchanged.

(Also worth knowing for those PRs: the pack's appendix says business coverage is
"only ISO 9001 / 28000 / 39001, all fixture-only with zero tasks". Those three
were **retired** on 2026-09-19 via `Framework.retiredAt`, precisely because
nothing grounded them. COSO is therefore the first business-control framework
this product ships with authored content, which raises the bar for it rather
than lowering it.)
