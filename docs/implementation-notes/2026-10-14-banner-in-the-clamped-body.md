# 2026-10-14 — a banner inside the clamped body pushed table rows past the fold (#3524)

**Commit:** `0ef6099f8` — and **its subject line names the wrong cause.** It reads
*"a row under the sticky header could not be clicked — the whole-row clip never
left room for it"*, which was my second of four diagnoses. The squash captured
the title as it stood when the pull request entered the merge queue; I corrected
the title and body afterwards, and the corrected text is in the commit's BODY,
but `git log --oneline` shows the subject. This note is the authority. Rewriting
`main`'s history to fix a subject line is not worth what it costs.

## The defect

`EntityListPage` rendered its `banner` slot **inside** `<ListPageShell.Body>`,
above `<DataTable fillBody>`. The body is the viewport-clamped region carrying
`overflow-hidden`, and `fillBody` makes the table `flex-1` inside it — so the
banner takes its natural height first and the table receives the remainder.

Measured on `/agents` at 1280×720 with three notice panels in the banner:

```
aside     x0   y0   180×720
main      x180 y64  1100×656
listBody  x204 y303 1052×394      the clamped region
table     x204 y663 1052×34       ← the remainder
thead     x205 y664 1137×37       ← the table's own sticky header, taller than its box
row       x205 y701 1137×61       ← y701..762
viewport                  720
click point         (774, 731)    ← BELOW the fold
elementFromPoint    null
```

The first row is pushed past the fold, so the point Playwright computes has
nothing at it, `elementFromPoint` returns `null`, and no hit test can pass. The
row nonetheless reports as "visible, enabled and stable" because it still has a
real bounding box — Playwright's visibility check measures the box and does not
consider whether an ancestor clips it.

**It is user-facing.** At 1280×720 an operator could read an agent row and not
click it, with nothing logged.

#3518 added the third notice panel. The arithmetic was waiting for it: `/agents`
already carried a governance banner and an assurance panel.

## Files

| File | Role |
| --- | --- |
| `src/components/layout/EntityListPage.tsx` | `banner` moves to the end of the `Filters` slot; the slot's gate gains `\|\| banner` |
| `tests/rendered/list-page-shell.test.tsx` | three assertions: placement, the banner-only page, and the general rule |
| `tests/e2e/agents-page.spec.ts` | the temporary geometry diagnostic, added and then removed |

## Decisions

- **The banner moves to the END of the `Filters` slot, not the start.** That slot
  is `flex-shrink-0` and outside the clamp, which is the property needed, and
  placing the banner last preserves the rendered order exactly — kpis, filters,
  banner, table — because the table is the first child of the body. `kpis` was
  already in that slot for the same reason, which is what suggested the fix.

- **The gate becomes `(filters || kpis || banner)`.** Without it a page passing
  only a banner would lose it entirely. That is the way this change could have
  silently deleted a notice surface, so it has its own test, and reverting the
  gate fails it.

- **A third test asserts the GENERAL rule: the table is the first element child
  of the body.** The banner was the instance. Any future slot with natural
  height inserted above the table reproduces the defect exactly, and a test
  naming the banner would not catch it. Positional, because the property is
  positional.

- **Three earlier commits on the branch are not the cause and were kept.** Each
  is a real defect with its own proof: a scroll-into-view parking a row beneath
  the sticky header (scroll padding); the whole-row clip sizing its own container
  without subtracting the sticky header inside it (mutation-proved both ways);
  and the clamped body having no height floor. The floor is the instructive one —
  it is **visibly not binding** here, since the body measured 394px against a
  320px floor, which is the clearest evidence it was aimed at the wrong
  container.

- **An instrument replaced the fourth guess.** Three diagnoses came from reading
  the Playwright call log, which names the element that intercepted a click but
  never says where the click point was. The interceptors it named were mutually
  inconsistent — `<main>` 48 times, the sticky `<th>` 9, and three elements
  belonging to the 180px sidebar, which cannot be near a row inside `<main>`
  under any static layout. The geometry instrument answered it in one run. The
  artifact that would have answered it directly (`playwright-report`) is 4.2 GB,
  which is why the log had to carry it instead.

- **Bisecting the run history is what found the trigger**, not the log: `main`
  green at 05:00, failing from `9af803ab` onward, and that sha is #3518's own
  merge commit. Two API calls. It also exonerated two plausible stories — #3518
  added no column and did not touch the row handler.

## Not fixed here: #3099

A cold row-click `router.push` dropped under the sidebar's fourteen prefetches is
a **different and still-open** defect. Its symptom was a click that LANDED and a
navigation that never committed; this was a click that could not land. Its lever
1 (warm the row's detail route, like the seven sibling pages) was spent in
`#3107` and did not hold; its lever 2 (stop issuing 14 full dynamic RSC requests
per document load) is untouched and its own code comment asks for a nav-latency
measurement first. All three affected specs carry a `networkidle` wait, which is
the mitigation #3099 identified, so they are on the protected path — if one fails
again the failing call will be `waitForURL` rather than `locator.click`, and that
distinction is readable straight off the log.
