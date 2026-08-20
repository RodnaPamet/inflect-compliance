# 2026-08-20 — the record stepper walks the displayed order (#107)

**Commit:** `5bfb73971 test(lists): prove a real list client publishes the order it displayed` (on `fix/stepper-walks-displayed-order`, atop the publish/read implementation)

## The bug

`EntityDetailLayout`'s prev/next stepper documents its `ids` prop as "the same
order the list page shows them". It was not that order, and a detail page
cannot recover it, for two independent reasons:

1. **Sorting happens after the read.** Every list client sorts IN MEMORY —
   `sortRowsByDisplay(rows, accessors, sortBy, sortOrder)` — and that helper is
   decorate-sort-undecorate, so it returns a NEW array while the SWR cache
   entry keeps SERVER order. `sortBy` / `sortOrder` are plain `useState`; they
   never reach the SWR key. Reproduced by hand: sort risks by Score desc, open
   the top row, press alt+ArrowDown, land on the THIRD visible row.
2. **Filtering happens under a different key.** List clients key their read on
   the filtered query string; the detail page always read the BARE list key.
   `ControlsClient` is the sharp case — it deliberately `params.delete('category')`
   so its SWR key stays stable and filters client-side, so the stepper walked
   controls the user had filtered OUT of view. `IncidentsClient` filters
   entirely client-side for the same reason.

`usePreviousPath` persists the pathname only — not the sort state, not the
filter set. There is nothing on the detail page to reconstruct from.

## Design — invert it

The list page is the only place that knows what it rendered, so it PUBLISHES
the id order it displayed and the detail page READS it.

```
ListClient                              DetailPage
──────────                              ──────────
sortedRows = sortRowsByDisplay(…)
usePublishDisplayedOrder(key, rows) ──┐
                                      │  SWR cache entry
                                      │  "displayed-order:<slug>:<key>"
                                      └─▶ useEntityListIds(key) ──▶ ids[]
                                                 │
                                                 └─ nothing published?
                                                    fall back to the list
                                                    endpoint's own cache
                                                    (server order)
```

The published order lives in its OWN SWR cache entry — `displayed-order:`
prefix, tenant-scoped — written with `revalidate: false` and read with a
`null` fetcher. It is client state that happens to live in the SWR cache so it
survives the list → detail navigation; it is never a fetchable resource.

Three properties are load-bearing:

- **Tenant-scoped key.** The slug comes from `useParams()`, not
  `useTenantContext`, so the hook never throws outside a `TenantProvider`; a
  missing slug degrades to an unscoped key rather than taking the page down.
  Without the slug, tenant B's detail page could read tenant A's order and
  offer arrows to ids B cannot open.
- **The effect keys on the joined id signature, not the array.** A client whose
  rows array is rebuilt each render (`data?.rows ?? []`) would otherwise write
  the cache every pass, and each write notifies every subscriber — a render
  loop across the list and any mounted reader.
- **An EMPTY published order counts as "nothing published"** and falls through
  to the list read. A publisher that mounts before its data lands must not
  blank the arrows on an already-open detail page. A list showing zero rows is
  not a list you can have clicked a row from, so the distinction is
  unobservable in practice.

### Publish what the table DISPLAYS, not the scroll window

`RisksClient` / `AssetsClient` / `PoliciesClient` / `TasksClient` /
`VendorsClient` / `ControlsClient` render a progressive-disclosure window
(`visibleRisks`) over the full result set (`risks`). The published set is the
FULL filtered + sorted array, not the window: the window is a rendering budget
that grows as the user scrolls, and the stepper should walk everything the user
filtered down to, exactly as scrolling would.

### A cold cache hides the arrows, deliberately

Nothing published and nothing in the list cache yields `[]`, and
`EntityPrevNextNav` renders nothing for an empty `ids`. Stepping "the order the
list showed" is meaningless when the user never saw a list, so hiding is the
correct answer for a deep link into a detail page with a cold cache.

## The contract #97 / #98 / #99 build on

Two axes are deliberately open, because the entities queued behind this need
them and retro-fitting either would churn all seven call sites.

**`getId` — the order need not be `.id`.** Frameworks step by their `key` slug,
so #98 publishes and reads with a matching extractor:

```tsx
const frameworkKey = (f: FrameworkRow) => f.key;          // module-level!
usePublishDisplayedOrder(CACHE_KEYS.frameworks.list(), rows, frameworkKey);
useEntityListIds(CACHE_KEYS.frameworks.list(), { getId: frameworkKey });
```

The extractor must be referentially stable (module-level or `useCallback`) — an
inline arrow is a new identity every render and re-walks the list each pass.
The same `getId` applies to the FALLBACK read, so publisher and reader must
agree; a mismatch yields ids the detail route cannot resolve.

**`orderKey` + a null `listKey` — the order need not come from a list PAGE.**
Audit packs (#97) have no list route at all. Whichever surface renders the pack
table publishes under an agreed key, and the detail page reads:

```tsx
useEntityListIds(null, { orderKey: CACHE_KEYS.audits.packs() });
```

A null `listKey` means "published order or nothing": no fallback fetch, no
arrows until something publishes. That is the right default for a surface with
no canonical list endpoint to fall back to — arrows sourced from an order
nobody displayed would be the original bug again.

`orderKey` defaults to `listKey`, so the seven wired call sites did not change
shape and the seven detail pages were not touched at all: the hook's signature
stayed source-compatible (`options` is optional).

## Files

| File | Role |
| --- | --- |
| `src/lib/hooks/use-entity-list-ids.ts` | Both halves of the contract — `usePublishDisplayedOrder` (publish), `useEntityListIds` (read), `useDisplayedOrderKey` (the tenant-scoped key). |
| `src/app/t/[tenantSlug]/(app)/{assets,controls,incidents,policies,risks,tasks,vendors}/*Client.tsx` | One `usePublishDisplayedOrder(...)` each, immediately after the memo that produces the rendered rows. |
| `tests/rendered/entity-list-ids-hook.test.tsx` | The contract against synthetic rows: round trip, tenant scoping, fallback, memo identity, and the `getId` / `orderKey` extension axes. |
| `tests/rendered/incidents-stepper-displayed-order.test.tsx` | The WIRING, end to end through the real `IncidentsClient`: a URL filter, the rendered DOM order, and the reader answering with it. |

## Decisions

- **Publish/read over "put sort state in the SWR key".** Threading `sortBy` /
  `sortOrder` into the key would make every sort change a cache miss and a
  refetch, on seven pages, to fix a navigation affordance. It also cannot fix
  `ControlsClient`, whose whole reason for a stable key is that the `category`
  facet is applied client-side.
- **The SWR cache rather than a React context or a module-level store.** The
  list and detail pages are separate mounts with no common provider below the
  tenant layout, and SWR's cache already survives that navigation with the
  right lifetime. A module-level store would need its own tenant scoping and
  its own subscription plumbing.
- **`useParams()` rather than `useTenantContext()` for the slug.** The hook is
  called from the list clients AND from detail pages; making it throw outside a
  `TenantProvider` would turn a missing provider into a blank page instead of a
  missing pair of arrows.
- **Empty published order is not authoritative.** See above — it protects an
  open detail page from a publisher that mounts before its data lands. The cost
  is that a genuinely empty list falls back to a (also empty) list read.
- **The seven detail pages were left untouched.** `options` is optional and
  `orderKey` defaults to `listKey`, so `useEntityListIds(CACHE_KEYS.x.list())`
  keeps meaning what it meant. Verified by grep: all seven call sites are
  unchanged.
