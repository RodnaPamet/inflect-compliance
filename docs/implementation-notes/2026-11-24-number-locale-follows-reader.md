# 2026-11-24 — Numbers follow the reader's language

## Design

`AnimatedNumber` formatted with `new Intl.NumberFormat(locale, …)`, and
`locale` was an optional prop nobody passes. `undefined` is the RUNTIME
default locale: the server process's during SSR, the browser's on the client.
They are different facts from the reader's chosen language, and from each
other, so a server started under a comma-decimal locale wrote `50,0%` into the
dashboard's accessible names and the browser hydrated `50.0%` (#5921).

#5903 already solved the same class of bug for dates. `<Providers>` binds the
reader's UI language once per render (`useBindDateLocale` →
`bindDateLocale`), the same on both sides of hydration, and
`activeDateLocale()` in `@inflect/ui/lib/format-date` reads it: a module value
in the browser, the request's render scope on the server, `'en'` outside any
binding. Numbers now read the same binding. An absent `locale` prop on
`AnimatedNumber` resolves to `activeDateLocale()`, for the static text, the
accessible name and the locale handed to NumberFlow alike.

The binding returns `'en'` or `'bg'`, which are valid BCP-47 tags. English keeps
the output the browser default most readers had (`1,234.5`); Bulgarian writes
`12 345,6` (no-break space grouping, comma decimal, and CLDR's minimum
grouping of two, so `1234` stays ungrouped).

The same defect sat in five other places that render in SSR'd client
components, all through `Number.prototype.toLocaleString()` with no locale:

| Site | Renders |
| --- | --- |
| `PaginationControls` | the "1–25 of 1,234" range and total on every list page |
| `<DataTable>` pagination footer (`table.tsx`) | the same range for tables that paginate themselves |
| `src/lib/kpi-trend.ts` (`formatTrendAbsolute`) | the KpiCard trend's `text` field |
| org dashboard `widget-dispatcher.tsx` | the KPI subtitles' counts |
| risk dashboard `MonteCarloPanel.tsx` | the iteration count in "last run" |

## Files

| File | Role |
| --- | --- |
| `src/components/ui/animated-number.tsx` | An absent `locale` resolves to `activeDateLocale()` |
| `src/components/ui/table/pagination-controls.tsx` | Range and total in the bound locale |
| `src/components/ui/table/table.tsx` | Same for the DataTable footer |
| `src/lib/kpi-trend.ts` | Trend counts in the bound locale |
| `src/app/org/[orgSlug]/(app)/widget-dispatcher.tsx` | KPI subtitle counts in the bound locale |
| `src/app/t/[tenantSlug]/(app)/risks/dashboard/MonteCarloPanel.tsx` | Iteration count in the bound locale |
| `tests/rendered/number-locale-follows-reader.test.tsx` | Makes the runtime default differ from the bound locale and asserts the bound one wins |

## Decisions

- **The date binding, not a second one.** The issue asks for numbers to follow
  the reader's language; that language is already bound once per render, on
  both sides, and survives a resumed streamed render (#5903). A second
  mechanism could disagree with the first.
- **Not `useLocale()`.** A hook would make `AnimatedNumber`, `KpiCard` and
  `TrendCard` require next-intl's provider; many rendered tests and the
  `kpi-trend` pure module mount or run without one. The binding needs nothing.
- **No edit to `format-date.ts`.** `activeDateLocale()` is already exported.
  That module sits near webpack's 20 KB split-chunk threshold, and growing it
  re-partitioned every route once (#5903), so callers import the existing
  function rather than a new alias.
- **`Intl` for Bulgarian numbers, unlike dates.** Dates in Bulgarian are
  table-driven because ICU's `bg` date output differs between builds. The
  number output does not, for the forms used here: Node 24 (ICU 78) and the
  pinned Chromium print byte-identical strings for grouped, decimal, negative
  and currency values. If a future ICU moved a separator, the symptom would be
  a hydration warning on Bulgarian pages only, and this is where to look.
- **Left as they are:** `packages/ui/src/lib/number-format.ts` hard-codes
  `en-US` (deterministic, so no mismatch; it formats chart tooltips and
  currency in English whatever the language), `format-bytes.ts` falls back to
  `toFixed` without a locale (deterministic), and `toFixed`-built strings such
  as the trend's `+1.5pp` (deterministic, English separators). None of them
  can mismatch on hydration; making them follow the reader's language is a
  separate, wider change.
