# 2026-08-06 — `useSsrFallback`, and one criticality→variant map

**Commit:** `<pending> refactor(ui): extract useSsrFallback; collapse the criticality variant maps`

Completes the mechanical half of the previous roadmap's dedupe item.

## `useSsrFallback` — six copies to one

Whether server-rendered rows may seed the SWR cache. A list page is
server-rendered for ONE filter combination; the client then owns the
filters, so the SSR payload is a valid seed only while the active filters
still describe the same query. Diverge, and `fallbackData` shows the
server's rows for filters the user has since changed — stale content that
looks authoritative, with no spinner to suggest otherwise.

The load-bearing detail is the **union** key set. Comparing only the
client's keys would miss a filter the server applied and the client has
since cleared, seeding a FILTERED payload into an unfiltered view. Six
copies (assets, controls, policies, risks, tasks, vendors) meant six chances
for one page to diverge invisibly — the hardest kind of bug to notice,
because every page looks individually plausible.

Three of the six passed `initialFilters!` with a non-null assertion; the
hook takes the honest optional type and treats absent as `{}`.

## One criticality→variant map

After the criticality single-source change, the Assets surface still had
two: a tone→variant record in `AssetsClient` and an enum→variant ternary at
`[id]/page.tsx:417`. They agreed, but nothing *made* them agree — changing a
band in one would leave the other showing a different colour for the same
asset. Both now go through `criticalityBadgeVariant`, derived from
`CRITICALITY_PRESENTATION`'s tone, so the badge colour cannot disagree with
the label beside it.

## Decisions

- **The test exercises the decision function and then checks the hook's
  source still matches it.** Testing a transcribed copy is only safe if
  something catches the two drifting apart.
- **`danger` and `critical` both map to `error`.** StatusBadge has no fifth
  step; the label distinguishes them. Recorded so it does not read as a bug.
- **`useSoftDeleteView` and the NewAssetFields/EditAssetFields merge are NOT
  in this change.** The form merge is two components rendering the same 14
  fields with divergent validation and a hint-vs-description split; it wants
  its own diff.
