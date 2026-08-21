# 2026-08-21 — framework detail stepper, keyed by slug (#98)

**Commit:** `feat(frameworks): step through frameworks by slug on the detail page`

## Design

#107 inverted the record stepper: the LIST page publishes the id order it
actually rendered (`usePublishDisplayedOrder`) and the DETAIL page reads it
(`useEntityListIds`). Seven entities were wired at that time. Frameworks were
deliberately left out because they exercise both of the extension axes the hook
reserved.

**1. The order is over a slug, not an id.** The route is
`/t/:slug/frameworks/[frameworkKey]`, and `EntityPrevNextNav` locates the open
entity with `ids.indexOf(currentId)`. A publisher emitting `Framework.id` while
the page passes `params.frameworkKey` yields `-1`, and the nav's response to
`-1` is to render nothing — the feature would look "not wired" rather than
broken. Both sides therefore route through one module-level extractor,
`frameworkOrderKey`, in `frameworks/framework-order.ts`:

```
FrameworksClient      usePublishDisplayedOrder(CACHE_KEYS.frameworks.list(), rows, frameworkOrderKey)
[frameworkKey]/page   useEntityListIds(CACHE_KEYS.frameworks.list(), { getId: frameworkOrderKey })
```

Module-level rather than inline because the hook maps the row array whenever the
extractor's identity changes; an inline arrow re-walks the list every render.

**2. The list client has no SWR read.** `/frameworks` is server-rendered:
`page.tsx` calls `listFrameworks` + `computeCoverage` and hands `FrameworksClient`
its rows as props. That is not an obstacle — `usePublishDisplayedOrder` takes
ROWS, not a fetch — so the publish call sits directly after the existing `rows`
memo, which is the single array both the cards view and the table view map over.
No SWR read was introduced to manufacture one.

The detail page keeps the fallback read (`listKey` is the frameworks list key,
not `null`). Unlike the packs case, `/api/t/:slug/frameworks` exists and returns
`listFrameworks` — the exact order the server page renders — so a deep link
straight into a framework still gets correct arrows.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/frameworks/framework-order.ts` | The shared `.key` extractor — one definition for both sides of the contract. |
| `src/app/t/[tenantSlug]/(app)/frameworks/FrameworksClient.tsx` | Publishes the rendered row order under `CACHE_KEYS.frameworks.list()`. |
| `src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/page.tsx` | Reads that order and passes `prevNext` (slug `'framework'`) to `EntityDetailLayout`. |
| `tests/rendered/frameworks-stepper-displayed-order.test.tsx` | Mounts the real list client and the real detail page over one SWR cache; asserts where the arrows navigate. |

## Decisions

- **Assertions are on navigation, not on call sites.** The test clicks the
  rendered arrow and asserts `router.replace('/t/acme/frameworks/ISO9001')`. The
  id-vs-slug bug's symptom is an absent nav, which a structural "the page
  mentions `useEntityListIds`" check cannot see.
- **The fixture's ids sort the opposite way from its keys**, and the fallback
  list read answers in reverse order. Dropping the publish call makes the
  stepper walk the wrong neighbour; dropping `getId` makes it disappear. Both
  were run and both go red.
- **Sub-routes under `[frameworkKey]/` get no stepper** — `diff`, `install`,
  `readiness`, `self-assessment`, `templates` are sub-pages of ONE framework,
  not siblings in the list, so stepping them would walk to a different
  framework's landing page while the user is mid-install.
- `labelSingular: 'framework'` comes from the catalog landed centrally in
  `STEPPER_ENTITIES`; no message file was touched.
