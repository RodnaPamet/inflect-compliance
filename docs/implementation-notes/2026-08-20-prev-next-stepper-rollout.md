# 2026-08-20 — prev/next stepper rollout across the entity detail pages

**Commit:** `ddc0b34d7 feat(layout): roll the prev/next stepper onto six more detail pages`

Follow-up to #2035, which made `EntityDetailLayout` own the stepper composition
behind an optional `prevNext` prop. #2035 deliberately left the other twelve
pages untouched so the shell change could land on its own; this note covers the
rollout that opts six of them in.

## Design

`EntityDetailLayout` already composes `<EntityPrevNextNav>` beside the entity
name and — the load-bearing part — carries it *inside* the shell's existing
`loading || error || empty` title suppression. A page therefore only has to
supply data:

```tsx
prevNext={{ ids, currentId, hrefFor, labelSingular }}
```

Supplying `ids` was the part still spread across pages. The stepper walks the
list the user just came from, so `ids` is the ordered id list out of that
entity's LIST endpoint SWR cache. Before this change that was two lines per
page — a `useTenantSWR` read plus a `useMemo` through `idsFromCappedList`.

Both lines have already been got wrong once, and both fail *silently* — the nav
renders nothing rather than throwing, so the feature just looks deleted:

- The asset page hand-rolled `Array.isArray(data) ? … : []` instead of the
  helper. `/assets` later moved to the `{ rows, truncated }` envelope, the
  guard started yielding `[]`, and the arrows were gone for two weeks (#2032).
- The memo has to key on the RAW cache value. `idsFromCappedList` returns a
  fresh array per call, so `useMemo(…, [ids])` defeats itself and hands the nav
  a new array identity every render.

So the two lines collapse into `useEntityListIds(listKey)`
(`src/lib/hooks/use-entity-list-ids.ts`). Same argument as #2035 made for the
composition: one place to get it wrong beats seven. `assets/[id]` migrates onto
the hook rather than being left as an eighth hand-rolled copy.

```
list page  ──writes──▶  SWR cache ( "/risks" )
                             │
detail page ── useEntityListIds(CACHE_KEYS.risks.list()) ──▶ string[]
                             │
                    EntityDetailLayout prevNext
                             │
                    EntityPrevNextNav (hides itself on [])
```

Pages wired: `risks`, `policies`, `tasks`, `vendors`, `incidents`, `controls`,
plus `assets` migrated.

## Files

| File | Role |
|---|---|
| `src/lib/hooks/use-entity-list-ids.ts` | New. The single reader — SWR read + shape-tolerant, correctly-keyed memo. |
| `src/app/t/[tenantSlug]/(app)/assets/[id]/page.tsx` | Migrated off the inline read onto the hook. |
| `.../risks/[riskId]/page.tsx` | Opts in. |
| `.../policies/[policyId]/page.tsx` | Opts in. |
| `.../tasks/[taskId]/page.tsx` | Opts in. |
| `.../vendors/[vendorId]/page.tsx` | Opts in. |
| `.../incidents/[incidentId]/page.tsx` | Opts in. |
| `.../controls/[controlId]/page.tsx` | Opts in. |
| `tests/rendered/entity-list-ids-hook.test.tsx` | New. Shape tolerance + memo identity. |

## Decisions

- **A hook, not a shared `prevNext` factory.** A factory returning the whole
  prop object would also have to know each page's route shape and id variable,
  which differ enough (`href` vs `tenantHref` vs a raw template string;
  `riskId` vs `params.vendorId`) that the factory would grow a per-entity
  registry. The genuinely shared part is *just* the ids read, so that is all
  the hook takes over.

- **Six pages, not all twelve.** The remaining six `EntityDetailLayout` callers
  are not list-backed entity details: `audits/cycles/[cycleId]`,
  `audits/packs/[packId]`, `audits/cycles/[cycleId]/readiness`,
  `audits/business-continuity/[id]`, `tests/runs/[runId]`, and
  `processes/ProcessesClient`. They either have no sibling list route with a
  `CACHE_KEYS.<x>.list()` key, or are a sub-page/canvas rather than one row of
  a list. Stepping is meaningless without a list order to step through, so
  they stay opted out — which the optional prop makes free.

- **The stepper walks the SERVER's order, not the order the table is showing.**
  This is the sharpest edge of the feature and it has two independent
  mechanisms, both carried over from the shipped assets page rather than
  introduced here.

  *Sorting.* Every list client sorts in memory, AFTER the SWR read —
  `sortRowsByDisplay(rows, accessors, sortBy, sortOrder)` (`RisksClient:550`,
  `TasksClient:384`, `PoliciesClient:288`, `VendorsClient:238`,
  `AssetsClient:280`). The sorted array is a NEW array; the cache entry the
  detail page reads still holds server order. The default state is safe —
  `sortRowsByDisplay` opens with `if (!sortBy) return rows`, and `sortBy`
  initialises to `undefined` — so this bites only once the user clicks a column
  header. Then it bites with a warm cache and an exactly-matching key: sort
  risks by Score desc, open the top row, press alt+↓, and you land on the
  third-ranked risk rather than the second.

  *Filtering.* The list pages key their read on the filtered URL
  (`` `${CACHE_KEYS.risks.list()}?${qs}` ``) and fall back to the bare key only
  when no filter is active. The detail page reads the bare key, so a filtered
  user steps the unfiltered order and pays one cold fetch for the privilege.

  Neither is cheaply fixable from the detail page, because both live in list
  state the detail page cannot see — `usePreviousPath` (RQ4-3) persists only
  the pathname, so neither the sort nor the query string survives the
  navigation. The tractable fix is to invert it: have the list page PUBLISH the
  id order it actually rendered (one cache entry per entity, written where the
  rows are already computed) and have the stepper read that instead of the raw
  list. That touches every list page, so it wants its own diff.

- **The cold-load list fetch is priced, and it is five pages, not seven.** On a
  deep link the bare list key is cold, so the hook fetches the capped list once
  (`LIST_BACKFILL_CAP` = 5000) to draw two chevrons. Two things keep that
  acceptable. `controls/[controlId]` already held an identical
  `useTenantSWR(CACHE_KEYS.controls.list())` for the exception panel's
  compensating-control picker, and `useTenantSWR` keys on the RESOLVED URL
  precisely so two hooks on one endpoint dedupe — so controls gains exactly
  zero requests, and `assets` was already paying it. The genuinely new cost is
  five pages, on the cold path only: the ordinary navigation (click a row on an
  unfiltered list) hits a warm entry inside the 5 s `dedupingInterval` and
  issues nothing. Making the read cache-only (`revalidateOnMount: false`) would
  remove even that, and would have the side benefit of hiding the arrows rather
  than stepping the wrong order in the filtered case above — but it would also
  drop the arrows on every deep link, which is a behaviour change to the
  shipped assets page and does not belong in a rollout diff.

- **`labelSingular` is still an English literal, and that is now a 7× gap.**
  The nav builds `` `Previous ${labelSingular}` `` for its `aria-label`,
  tooltip and shortcut description, with both halves hardcoded English, in a
  product that ships a fully-populated `bg` locale. Not introduced here — the
  assets page shipped it — but multiplied. It is deliberately NOT fixed in this
  diff because the obvious fix is wrong: Bulgarian adjectives agree in gender,
  so a single interpolated `"Previous {entity}"` yields *предишен политика*
  (should be *предишна*) for the feminine nouns. A correct fix needs whole
  translated phrases per entity per direction, which wants its own diff and its
  own review rather than being buried in a rollout.
