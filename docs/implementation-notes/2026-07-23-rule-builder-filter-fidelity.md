# 2026-07-23 — RuleBuilder filter fidelity (nested/legacy preservation, typed eq/neq, constrained task link)

**Commit:** `<sha> fix(automation): preserve nested/legacy filters, coerce typed eq/neq, constrain CREATE_TASK link`

## Design

Three correctness bugs in the automation RuleBuilder edit path, each a
silent data-loss / silent-no-op that only bites on a *round-trip*
(open an existing rule → save):

1. **Filter wipe.** `detailToBuilderState` hydrated flat-only, but the
   evaluator (`filters.ts`) accepts recursive `FilterGroup`s *and* the
   legacy flat equality map. A nested condition hydrated to
   `field:undefined` (dropped); a legacy map hydrated to `[]` →
   `buildTriggerFilter` returned `null` → the PUT nulled
   `triggerFilterJson`, wiping a filter the user never touched.

2. **Typed eq/neq stringified.** The builder authors every value as a
   string (HTML inputs). `eq`/`neq` used strict `===`, so `score eq 5`
   became `'5'` after an edit and stopped matching payload `{score: 5}`.

3. **Free-text task link.** The CREATE_TASK builder collected
   `linkEntityType` as free text, but the executor only resolves
   `'Control'` — typing `'Risk'`/`'Task'` silently created an unlinked
   task.

**Fixes.**

- **Bug 1 (option b — detect + preserve).** `hydrateFilter` classifies
  the stored filter: a *flat* `FilterGroup` → editable rows; a *legacy
  map* → one `eq` row per key (round-trips to an evaluator-equivalent
  group); a `FilterGroup` *containing a nested sub-group* → not
  drawable by the tabular UI, so the whole filter is stashed in
  `BuilderState.preservedFilter` and passed through **verbatim** on
  save, with the condition editor replaced by a read-only notice.
  Load-bearing guard: `buildTriggerFilter` returns `preservedFilter`
  before any null/flatten path — an empty flat state can never null a
  filter the builder failed to represent.

- **Bug 2 (coerce at compare time).** `looseEquals` in `filters.ts`
  does strict `===` first, then number-/boolean-aware coercion keyed on
  the **actual payload value's** type (authoritative), never on a guess
  about the filter value's type. Wired into `eq`, `neq`, and the legacy
  map path. Mirrors what `gt`/`lt` already do with `Number()`.

- **Bug 3 (constrain).** `linkEntityType` is now a `<Combobox>` limited
  to `TASK_LINK_ENTITY_OPTIONS = ['Control']` — the only value the
  executor links. Extend the list only in lockstep with the executor.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/automation/filters.ts` | `looseEquals` + eq/neq/legacy coercion (Bug 2) |
| `src/components/processes/RuleBuilderModal.tsx` | `hydrateFilter` + `preservedFilter` pass-through (Bug 1); task-link Combobox (Bug 3) |
| `messages/{en,bg}.json` | `advancedFilterTitle`/`advancedFilterBody` read-only notice strings |
| `tests/unit/automation.filters.test.ts` | eq/neq/legacy coercion cases |
| `tests/unit/automation-rule-builder-roundtrip.test.ts` | nested-group + legacy-map preservation, typed-eq round-trip |

## Decisions

- **Coerce at eval time, not build time.** The builder can't safely
  guess a field's type for a canvas/API-authored filter, and coercion
  keyed on the payload value is the single authoritative source. This
  also fixes legacy rows and any string-valued filter, not just
  builder-edited ones.
- **Preserve, don't flatten, nested groups.** Flattening an
  `AND(OR(...))` into a flat list would change its truth semantics.
  Read-only pass-through is the only lossless option for a tabular UI
  that can't express nesting; advanced editing stays on the canvas.
- **Constrain rather than extend the executor.** Offering only
  `Control` is a one-line change and removes the silent no-op today;
  adding Risk/Task linkage is a separate, larger executor change.
