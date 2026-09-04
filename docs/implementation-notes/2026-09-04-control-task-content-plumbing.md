# 2026-09-04 — control task content plumbing

**Commit:** `<pending>` `feat(controls): schema + catalog plumbing for actionable control tasks`

PR 1 of the "Actionable Control Tasks" plan. Schema, one projection, one
generic-task constant, a catalogue task format and a per-task reconcile. **No
content change** — every authored task arrives in the PRs after this one.

## Design

`ControlTemplateTask` had four scalars (`id`, `templateId`, `title`,
`description`). It now carries the eight columns authored content needs, and
`Task` carries the two that make an installed task identifiable.

The projection is the load-bearing piece. Four call sites — `install.ts` at
three places and `control/mappings.ts` at one — each spelled the
template→task mapping themselves, and every one produced a task recorded as
`source: MANUAL`. Not by setting it: by never mentioning it and inheriting
`tasks.prisma`'s `@default(MANUAL)`. `TaskSource.TEMPLATE` had existed in the
enum the whole time, unused.

That is why a backfill for existing tenants is impossible rather than merely
awkward, and it is why the operator chose "new installs only" for the rollout:
every template task in every existing tenant is indistinguishable from a
hand-written one, possibly edited, reassigned or closed, and no later change
can disambiguate them. Rows written from today carry `TEMPLATE` and a
`templateTaskId`, so the ambiguity has an end date even though it has no
beginning.

## Files

| file | role |
|---|---|
| `prisma/schema/enums.prisma` | `TaskPhase` — a reading order, not a state machine |
| `prisma/schema/controls.prisma` | eight columns on `ControlTemplateTask`; `defaultOwnerHint` on `ControlTemplate` |
| `prisma/schema/tasks.prisma` | `Task.checklistJson`, `Task.templateTaskId`, `@@index([tenantId, templateTaskId])` |
| `prisma/migrations/20260904093000_control_task_content_plumbing/` | additive only |
| `prisma/generic-template-tasks.ts` | **new** — the single owner of the five generic tasks |
| `prisma/catalog-loader.ts` | `CatalogTaskSchema`, `LocaleStringSchema`, `canonicalJson`, `taskContentHash` |
| `prisma/catalog-applier.ts` | `reconcileTemplateTasks` — the four-way per-task decision |
| `src/app-layer/schemas/task-checklist.schemas.ts` | **new** — the checklist shape and its bounds |
| `src/app-layer/usecases/control/task-from-template.ts` | **new** — the one projection |
| `src/app-layer/usecases/framework/install.ts`, `control/mappings.ts` | four call sites, plus `orderBy` |
| `tests/guardrails/control-task-actionability.test.ts` | the bar, with a prefix-keyed allowlist |
| `tests/guardrails/no-generic-task-strings.test.ts` | one owner for the five strings |
| `tests/guardrails/catalog-task-round-trip.test.ts` | shipped tasks stay loader-readable |

## Decisions

- **`CatalogTaskSchema.steps` is OPTIONAL, against the spec's `.min(3)`.** The
  five curated fixtures already carry 205 tasks shaped `{title, description}`
  with no steps, and `catalog-loader.ts` exists specifically to replace the
  `require()`-based seeding those fixtures use. A required `steps` would make
  the loader structurally unable to read the very files it is migrating
  toward — it would reject shipped content on day one. The 3-8 bound still
  holds when steps are present; what moved is where absence is caught, and the
  actionability ratchet already had the allowlist machinery for exactly that
  population.

- **The allowlist is keyed by template-code PREFIX, not framework.** 151
  internal controls (`ICN-`) belong to no framework and have no key to be
  allowlisted under. A framework-keyed list would silently omit the largest
  population there is, and "the allowlist is empty" would certify nothing
  about it.

- **Reconcile matches "changed" on `sortOrder`, not title.** Titles are
  exactly what re-authoring rewrites, so title-matching would read every edit
  as a delete plus a create — destroying the row identity that every already
  installed `Task.templateTaskId` points at.

- **A removed task is deprecated, never deleted.** A tenant may have installed
  it and its `Task` rows outlive the template by design. `deprecatedAt` stops
  it being installed again without touching what exists.

- **`Task.checklistJson` as a column, not a `TaskChecklistItem` model.** The
  model would buy queryability and per-item evidence; neither is reachable,
  because task evidence is `Evidence.taskId` and no seam carries an item id.
  It would cost RLS, an isolation test, an index and a retention entry. The
  cost of the column is stated where it lands: `sanitize-rich-text-coverage`
  is model-keyed and `Task` is already classified, so **no guard can see** a
  new free-text field on it. Sanitisation is enforced by a behavioural test
  and by routing every write through one function.

- **`defaultOwnerHint` was added while the migration was open.** All five
  curated fixtures have carried the key since they were written, and the
  seeder read it and dropped it every time because there was no column. It is
  the natural default for a task's `suggestedRole` — same vocabulary.

- **Three of four generic-task copies were consolidated; the fourth is
  frozen.** `scripts/backfill-framework-catalog.mjs` is a completed one-off
  production backfill in ESM, run directly with node, so it cannot import the
  TypeScript constant. Converting it would rewrite a historical record; it is
  allowlisted by name with that reason.

## What the ratchets caught while being written

Worth recording, because each was a defect in the guard rather than in the
code, and each is the shape the guard exists to prevent one level down.

- The first scan globbed `*control-templates.json` and **silently missed
  `internal-controls.json` — 151 templates, the largest population**. A scan
  whose denominator is its own naming convention reports full coverage of the
  subset it happens to match.
- Six of seventeen allowlist prefixes were **phantoms** — `A-`, `AIMS-`,
  `EUAIA-`, `PRIV-`, `AISVS-`, `SSDF-` — taken from the roadmap's framework
  *names* rather than from codes that ship. An allowlist of phantoms is worse
  than an empty one: it makes "empty" reachable by deleting entries that never
  guarded anything.
- `no-generic-task-strings` fired on `src/data/clauses.ts:123`,
  `'Review effectiveness of corrective actions'` — an ISO clause item that
  merely begins with the shortest of the five titles. The needle was a
  substring; it now matches a complete quoted literal.

## Found, not fixed here

**98 templates have no fixture file at all.** DORA (24), ISO 9001 (22), NIS2
(20), ISO 39001 (17) and ISO 28000 (15) are seeded from inline arrays in
`prisma/seed.ts`. A fixture-based content PR cannot author into them and a
fixture-based ratchet can neither hold them to the bar nor honestly allowlist
them — it has no record they exist. Recorded as
`UNSCANNABLE_INLINE_POPULATIONS` so an empty allowlist is never mistaken for
an actionable corpus. Giving those five frameworks fixtures is a prerequisite
for their content PR, not a part of it.
