# 2026-08-21 — prev/next stepper on audit cycles and audit packs (#97)

**Commit:** `feat(audits): step through cycles and packs in the order the screen showed`

## Design

Two detail pages, taking DIFFERENT halves of the `use-entity-list-ids`
contract that #107 (PR #2057) left open.

**Cycles — the ordinary shape, with one twist.** `audits/cycles/page.tsx`
publishes the id order it renders; `audits/cycles/[cycleId]/page.tsx` reads it
with `useEntityListIds(CACHE_KEYS.audits.cycles())`. The twist is that the
list page does not read `/audits/cycles` at all — it reads
`/audits/readiness/overview` (the cycle list joined with per-cycle readiness
scores, one server-side fan-out instead of a 1+N waterfall). So the reader's
fallback key points at a cache entry the list page never fills: it holds
whatever the audits-hub cycle picker last fetched, or nothing, in which case
the reader issues a fresh network read. Publishing closes that gap; the
fallback stays as the deep-link answer.

**Packs — published-order-or-nothing.** Audit packs have no list route
anywhere in the product. The only surface that renders a list of packs is the
pack panel at the bottom of the CYCLE detail page, so that page publishes
under `CACHE_KEYS.audits.packs()` and `audits/packs/[packId]/page.tsx` reads
`useEntityListIds(null, { orderKey: CACHE_KEYS.audits.packs() })`. The null
`listKey` suppresses the fallback entirely: a pack reached by deep link (a
share notification, a bookmark) shows NO arrows rather than offering to step
an order no screen in the product displays.

The cycle detail page is therefore both sides of the contract at once — it
reads the cycles order and publishes the packs order.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/audits/cycles/page.tsx` | publishes the rendered cycle order under `audits.cycles()` |
| `src/app/t/[tenantSlug]/(app)/audits/cycles/[cycleId]/page.tsx` | reads the cycle order (`prevNext`, slug `cycle`); publishes the pack order under `audits.packs()` |
| `src/app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx` | reads the pack order with a null `listKey` (`prevNext`, slug `pack`) |
| `tests/rendered/audit-cycle-stepper-displayed-order.test.tsx` | list → detail, real pages, one shared SWR cache |
| `tests/rendered/audit-pack-stepper-displayed-order.test.tsx` | cycle → pack, plus the no-fallback deep-link case |

## Decisions

- **The tests assert navigation, not call sites.** Each mounts the real
  publisher page, reads the id order back out of the DOM, unmounts it, mounts
  the real reader page over the SAME SWR cache, and clicks the arrows —
  asserting the `router.replace` target is the neighbour in the order that was
  actually painted. A structural "the page mentions `useEntityListIds`" check
  would pass against wiring that resolves to an empty list, which is exactly
  how the stepper stayed dead for two weeks before #107.
- **Both fixtures make the fallback endpoint answer in REVERSE.** If the
  publish call is deleted, the assertions do not merely weaken — the arrows
  point at the wrong neighbour. Deleting the two publish calls turns 6 passing
  tests into 4 failures; swapping the pack reader's null `listKey` for a real
  one makes the deep-link test grow arrows it must not have.
- **The readiness sub-page (`cycles/[cycleId]/readiness`) gets no stepper.**
  It is a sub-view of one cycle, not a sibling in any list. Its parent already
  carries the arrows, and the cycles list links to it as a secondary action —
  stepping "to the next readiness report" would step to a different cycle's
  different sub-page, which is a navigation the user never asked for.
- **`cycle?.packs` is published unconditionally**, before the page's early
  returns, because hook order must be stable. While the cycle is loading that
  publishes an empty order, which `useEntityListIds` treats as "nothing
  published" — so a mid-load publisher cannot blank an already-open reader.
