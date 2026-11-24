# 2026-11-24 — The routes the phone audit measures for the first time

**Commit:** see the pull request that closes the last part of #5924.

## Design

#5926 made the nightly whole-product audit create the records the seed
lacks, so it captured 16 detail routes it had never measured. What it found
there splits into page defects, fixed in the page or the shared primitive, and
detector false positives, fixed in the harness with a test each:

```
page defect                           fix
notifications "Open" (12px link)      <TextLink>: the shared 44px touch square
agents/peers/[id] supplier link       <TextLink>
agents/runs/[id] Input / Output       a 44px row on a coarse pointer
                                      (min-h-11 + leading-11 on the <summary>)
receipts "All" (41px wide)            ToggleGroup option: pointer-coarse:min-w-11
processes/agents/[id] "Menu"          every tldraw canvas in the reader's language

detector                              fix
"made with tldraw" (tap, English)     LICENCE_BOUND: the watermark is not measured
vendor questionnaire "Yes/Partial"    an option is data on a page showing its question
NIS2 "(Teams, Signal)"                a name in an aside of a Bulgarian sentence
```

tldraw ships 48 interface languages and Bulgarian is not one of them, so
setting its locale alone would still fall back to English. Every `<Tldraw>`
now renders `<TldrawReaderLanguage />`, which sets tldraw's locale from
next-intl's, and passes `TLDRAW_TRANSLATIONS` as `overrides.translations`:
the Bulgarian for every key the product's canvases can show
(`src/components/processes/tldraw/translation-bg.ts`).

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/notifications/page.tsx` | "Open" is a `TextLink` |
| `src/app/t/[tenantSlug]/(app)/agents/peers/[peerId]/PeerDetailClient.tsx` | the supplier link is a `TextLink` |
| `src/app/t/[tenantSlug]/(app)/agents/runs/[runId]/AgentRunDetailClient.tsx` | payload toggles are 44px rows on touch |
| `src/components/ui/toggle-group.tsx` | an option is at least 44px wide on touch |
| `src/components/processes/tldraw/translation-bg.ts` | tldraw's interface in Bulgarian |
| `src/components/processes/tldraw/reader-language.tsx` | the locale setter and the overrides |
| `src/components/processes/{TldrawProcessCanvas,agent-view/AgentCanvasView,agent-flow/AgentFlowCanvas}.tsx` | wire both into every mount |
| `scripts/mobile-audit/measure.ts` | the watermark is not a tap target or leak text |
| `scripts/mobile-audit/leaks.ts` | `pageDataNames`, `nameInAnAside` |
| `scripts/mobile-audit/resolve.ts`, `run.ts` | `questionOptions`, threaded per page |

## Decisions

- **The watermark is exempt, not enlarged.** tldraw's licence (3.x, the
  version the owner adopted with the watermark kept, D-L2-3) asks that the
  watermark keep its behaviour, "visible, unobscured, and available to
  user-interaction"; its 8x32 phone tab is tldraw's own CSS. Growing its hit
  area would change that behaviour, so it was not done; the detector leaves it
  out with the reason written beside `LICENCE_BOUND`. Owner question: a
  business licence removes it, which is the only way that tap target moves.
- **A toggle on a run step grows the row, not a hit area.** Input and Output
  are stacked 8px apart; a 44px `::after` on each would answer for its
  neighbour's taps. `display` stays `list-item`, so the disclosure marker
  stays; `leading-11` centres the one-line label in the 44px row.
- **Question options are page-scoped data, not global data names.** "Yes",
  "Partial" and "Other" are also interface labels. Adding them to `dataNames`
  would stop the detector seeing a hard-coded "Yes" on every other page, so an
  option counts as data only on a page that shows the prompt it answers.
- **A product name needs an aside.** "Signal" is also a catalog label. The
  rule that exempts it is narrow on purpose: one capitalised word, inside
  parentheses, in a sentence of at least six Bulgarian words. A label
  interpolated into a short string ("Обратно към Agents") or into a sentence
  outside parentheses is still a leak; the price is that a name in running
  text with no aside is still reported.
- **Bulgarian for tldraw.com's own app is left out.** Sharing, people,
  file-system, VS Code and cursor-chat strings belong to tldraw.com and no
  canvas here shows them; a missing key falls back to tldraw's English. The
  translation still depends on tldraw fetching its English catalogue from its
  CDN before it applies overrides (`fetchTranslation`); if that fetch throws,
  the canvas stays in English, as it was.
