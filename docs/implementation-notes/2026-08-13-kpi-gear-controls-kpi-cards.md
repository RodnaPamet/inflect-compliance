# 2026-08-13 — The "edit cards" gear edits the cards it names

**Commit:** `<sha>` `fix(ui): the filter gear controls KPI cards on the five remaining pages`

Closes **U1**. On five of eight list pages, the toolbar gear listed FILTER
categories: hiding a "card" removed a filter from the product, while the KPI
strip it appears to control — hardcoded JSX — never changed.

## The split

`filtersToCards()` stamps `kind: 'filter'` on everything, and
`selectVisibleFilters()` hard-filters to that kind. Three pages had already
moved off it:

| | pages | gear registers | KPI strip |
|---|---|---|---|
| worked | assets, controls, risks | `kind: 'kpi'` cards | rendered from `visibleCards` |
| broken | tests, evidence, policies, tasks, vendors | `filtersToCards(...)` | hardcoded `<KpiFilterCard>` literals |

The five now follow `AssetsClient` exactly: a hand-built `CardDefinition[]`,
`useFilterCardVisibility` under the unchanged storage key, and a
`visibleKpiCards.map(...)` over a cfg record keyed by `card.id`.

## What made this dangerous, and what actually protects it

The swap reuses each page's EXISTING `inflect:filter-vis:<entity>` key, so a
user's persisted order suddenly contains ids that no longer exist. One branch
makes that safe (`use-filter-card-visibility.tsx`): when a **non-empty**
persisted order has **every** id dropped, fall back to defaults rather than
render an empty strip. A genuinely empty order — the user hid everything — is
respected.

**That branch had no test.** Every fixture in
`tests/rendered/use-filter-card-visibility.test.tsx` was `kind: 'filter'`, so
the migration path was never exercised. Five pages would have shipped on an
untested assumption whose failure mode is invisible in review: the same build
shows all KPI cards to a user who never touched the gear, and an empty strip to
one who did — because `useLocalStorage` only writes on `setValue`.

Three cases now cover it, including the one that fails safe-looking renames:
if even ONE persisted id survives, `reconciled.length > 0`, the migration is
skipped, and the user is left with exactly that one card. `dueWeek` → `due` or
`outstandingAck` → `outstanding` would do it. `kpi-sparkline-canonical.test.ts`
now asserts no KPI card id equals one of its page's filter keys — there are
zero collisions today, and this keeps it so.

## Two things the reference implementation settled

**No `kpisToCards` / `selectVisibleKpiIds` helpers.** The brief asked for both.
The three working pages use neither — they hand-build the array so each card's
label carries that page's own i18n call, and map the hook's output directly.
Adding exports with no callers would have diverged from the pattern this change
exists to converge on.

**`selectVisibleFilters` stays in the hook** but now has no callers among the
eight pages. It returns `[]` once every card is `kind: 'kpi'`, so any page still
wiring it into its toolbar renders an EMPTY Filter dropdown — the loudest way
this migration could have gone wrong. It remains the correct projection for a
future `kind: 'filter'` consumer.

## The gear's label was wrong, not just untranslated

`title="Edit filter cards"` named the wrong object on all eight pages once the
gear controls KPIs. It is now `t('table.editKpiCards')` → "Edit KPI cards",
routed through the same catalogue path the sibling columns gear already used.
"Reset to defaults" in the shared `ChecklistGearButton` was also hardcoded —
that primitive backs BOTH toolbar gears, so one string shipped untranslated on
every list page.

## Files

| File | Role |
|---|---|
| `tests/page.tsx` · `EvidenceClient` · `PoliciesClient` · `TasksClient` · `VendorsClient` | gear registers `kind:'kpi'`; strip renders from the hook; full defs restored to the toolbar |
| `edit-filters-button.tsx` · `checklist-gear-button.tsx` | both labels through next-intl |
| `messages/{en,bg}.json` | `common.table.editKpiCards`, `common.table.resetToDefaults` |
| `kpi-sparkline-canonical.test.ts` | gear→KPI wiring + the id/filter-key collision assertion |
| `use-filter-card-visibility.test.tsx` | the stale-id migration, three cases |
| `columns-dropdown-coverage.test.ts` · `policies-list-shell-adoption.test.ts` · `i18n-adoption-ratchet.test.ts` | ratchets that pinned the old behaviour |

## Decisions

- **Total namespace swap, never a mix.** Registering `kind:'filter'` and
  `kind:'kpi'` under one key leaves a surviving id, skips the migration, and
  hides the new cards for exactly the users who have used the gear before.
- **Evidence's freshness strip stays literal.** Those four cards have no
  `KpiFilterDef` — they drive `setFreshnessFilter` directly, so there is no
  `activeKpi` for `selected` to read. That is the only reason; their natural ids
  are filter *values*, not keys, so gear-managing them later is safe.
- **Evidence's gear is no longer list-only.** It sat inside a
  `viewMode === 'list'` guard, which was fine when it managed filters. The KPI
  strip renders in gallery view too, so a user who hid cards and switched views
  had no way to restore them. Columns stay gated — there is no column model in
  gallery.
- **The ratchet strips comments before matching.** Its first version failed on
  the explanatory comments the migration left behind. The dangerous direction is
  the other one: a positive assertion reading prose would let a page that merely
  mentions `kind: 'kpi'` in a TODO pass without migrating anything.
- **Two i18n baseline entries deleted, not amended.** `i18n-adoption-ratchet` is
  no-stale by design; both files were grandfathered and are now migrated, so the
  debt comes off in the same diff.
