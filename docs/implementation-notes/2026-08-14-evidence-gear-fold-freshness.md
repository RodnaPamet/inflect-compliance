# 2026-08-14 — Evidence: freshness cards into the gear, retention toggle out

**Commit:** `(this PR)` fix(evidence): the retention bucket is a filter, and the gear owns every KPI card

## Design

The Evidence list opened with three stacked, undismissable blocks above the
table: four status KPI cards, a retention `ToggleGroup` (Active / Expiring /
Archived), and four freshness KPI cards. Roughly a third of the viewport before
a single row of evidence appeared, none of it hideable.

Two separate problems were tangled together there.

**The retention bucket was a second filtering mechanism.** It wrote `?tab=`
through `useUrlFilters`, parallel to the filter bar rather than part of it. So
an active bucket had no pill, was uncounted by "Clear all", and was invisible to
anything reading filter state. That separation was defensible while the bucket
was a client-side partition of already-loaded rows — a "view of the data"
distinct from "filters on the view". It stopped paying rent in #1910, when the
bucket became a server-side predicate (`evidenceRetentionTabWhere`) exactly like
every other filter. It is now a normal single-select `tab` filter category.

**The freshness strip was hardcoded JSX.** The gear could not hide it. It is
now registered with the gear alongside the status cards, and one render loop
draws all eight from `visibleKpiCards`.

### Why the storage key was bumped rather than the ids renamed

Adding four cards to a gear that already persists an order is the *additive*
case, and the shared hook deliberately does not handle it:
`reconcileOrder` drops dead ids but never appends new ones, because an absent id
may be one the user **hid**, and re-adding it would silently un-hide it on every
load. The hook's stale-id migration only fires when *every* persisted id is
dead. The four status ids survive here, so a user who had ever touched this
gear would have kept their four cards and never seen the freshness four.

Renaming the status ids to force that migration — the trick used when the gear
swapped from filter cards to KPI cards — is worse than it looks. The collision
guard in `kpi-sparkline-canonical.test.ts` extracts card ids as
`[a-zA-Z0-9_]+`, so a namespaced `status:total` would match nothing, the
extracted id list would be empty, and the guard would pass while checking
nothing.

Bumping the key to `inflect:filter-vis:evidence-v2` resets the card set for
everyone in one line, with no id churn and no guard-defeating rename. The old
key is left orphaned (a few bytes) rather than migrated: there is no ordering
worth preserving across a card set that doubled and changed meaning.

### Absent-means-active

`tab` defaults to `active`, and that default lives in the page's `fetchParams`
(`if (!params.has('tab')) params.set('tab', 'active')`), not in the filter def.
An empty filter state should serialise to no params; encoding the default as an
option would have meant either a permanent `?tab=active` in every URL or an
"All" option that widens the default list to include archived rows — a new
capability, not a port of the toggle.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/evidence/filter-defs.ts` | Adds the `tab` filter def + `evidenceRetentionTabLabels`; corrects two comments #1910 made stale |
| `src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx` | `tab` moves into filter state; eight cards registered; one gear-driven KPI strip; ToggleGroup + hardcoded freshness strip deleted |
| `messages/{en,bg}.json` | `filters.retention{,Desc}` added; the orphaned `list.retentionTriageAria` removed |
| `tests/unit/evidence-filter-defs.test.ts` | `tab` in the managed key set; single-select with the three server buckets; `?tab=` URL round-trip |
| `tests/guards/kpi-sparkline-canonical.test.ts` | New: every registered KPI card has a render config, across all eight pages |
| `tests/guards/tab-primitive-adoption.test.ts` | Evidence entry removed — the tab UI is gone, not migrated |

## Decisions

- **The retention ToggleGroup was deleted, not migrated to `<TabSelect>`.** The
  tab-primitive registry listed it as a migration target. Three buckets that
  partition the tenant and resolve to a `where` clause are a filter; giving them
  a nicer tab primitive would have preserved the duplication.
- **`tab` is single-select.** The buckets partition the tenant, so two at once
  has no meaning `evidenceRetentionTabWhere` could answer.
- **The three retention labels were repurposed, not retired.** The control is
  gone but the vocabulary is unchanged, so the keys now label the filter
  options. Only `retentionTriageAria` — the ToggleGroup's aria label — had no
  successor and was removed from both locales.
- **The status and freshness axes keep separate click/selected bindings.** They
  share a grid, not a mechanism: status cards drive `useKpiFilter`, freshness
  cards drive the `freshness` filter. Forcing both onto `useKpiFilter` would
  have been a behaviour change smuggled into a layout change.
- **`kpiCards` builds its labels inside the `useMemo`.** Hoisting them to their
  own memo made the React Compiler read the `.current` freshness bucket as a ref
  access, infer `labels.current` as a dependency, and skip optimizing the whole
  component. `current` is a bucket name, not a ref.
- **The new guard reads `cfg` by balanced braces.** A card registered with the
  gear but missing from the render config is listed, toggles on, renumbers its
  neighbours — and draws nothing, because the render is
  `const c = cfg[card.id]; if (!c) return null;`. `cfg` is a
  `Record<string, …>`, so the type system cannot see it. Evidence registering
  two card axes in one array is the shape that makes forgetting an arm easy.
