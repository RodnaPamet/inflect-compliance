# 2026-07-26 — Compliance-calendar UI hardening

**Commit:** `<sha>` fix(calendar): deep-links, loading/error states, filters, i18n, a11y

## Design

Frontend companion to the calendar backend hardening. Fixes dead deep-links,
a wasted server prefetch, a loading state that never showed, a total absence
of filters, error/permission handling, untranslatable labels, and the
accessibility of the three view primitives.

### Deep-links + the guard gap (#1)
Three event types shipped hrefs to routes that never existed and 404'd on
click: `/training` (real route `/admin/training`), `/evidence/{id}` (no `[id]`
route — detail is a `?ev=` sheet), `/findings/{id}` (no detail route → land on
the list). A milestone with a null risk link emitted a bare `/risks/` list URL
masquerading as a deep link — omitted. The `calendar-ux-completeness` ratchet
only checked the vendor deep-link, which is why the 404s survived; it now
resolves EVERY emitted `tenantHrefFromCtx` path against the App Router tree.

### Dead SSR + loading/error (#2, #3, #5)
The page ran the full aggregation for a now±180d window and passed it as
`initialData`, but the client's default month view requests a different window
so the keys never matched — an expensive aggregation discarded every load, plus
a whole-payload `JSON.stringify` per render through the SWR options. Dropped the
prefetch; the client owns range selection so it owns the fetch. `keepPreviousData`
(the shared-hook default) made `pending = !data && !error` permanently false —
no spinner on a range switch, and the previous window's events painted into the
new grid; the calendar now overrides it off and derives `pending` from SWR's
key-aware `isLoading`. On error, the empty/off-screen-hint branches are
suppressed (they read as "nothing due") and the grid degrades.

### Filters, legend, counts, my-deadlines (#4)
The backend accepted a type/category filter, exposed counts, and carried
`ownerUserId` — the UI used none. Added a category filter bar that doubles as
the colour legend (each chip carries its `getCategoryTone`), wired the category
filter into the SWR key (server-side), a "my deadlines" toggle (client-side
`ownerUserId` filter), and a live total count.

### Permissions + reschedule (#6, #7)
Complete / Reschedule / new-task affordances rendered for read-only users, who
got an optimistic change then a 403 and "please try again". They now gate on
`usePermissions().tasks.edit` / `.create`, and a failed mutation surfaces a
permission-specific message. Reschedule's `clearable={false}` picker had no exit
(the row stuck in picker mode) — added an explicit Cancel.

### Translatable labels (#10, #11)
Event titles, category/status/source names were composed server-side as English
strings, so no locale could translate them. The server now returns `entityName`
and the client composes titles + labels through next-intl (`@/lib/calendar-labels`).
Four hardcoded month/weekday arrays across the views route through new shared
`formatMonthYear` / `formatMonthShort` / `formatWeekdayShort` helpers.

### Accessibility (#12, #13)
Month grid: `role=grid/row/gridcell/columnheader`, roving-tabindex arrow-key
navigation, `aria-current="date"`, category text alternatives. Heatmap: roving
tabindex over its ~546 day buttons. Timeline: `role=list` cleaned up, point
events + colour-only category/status given accessible names. Today ring compares
the viewer's LOCAL day (was UTC); the month grid is padded to a fixed 6 rows.

## Files

| File | Role |
|---|---|
| `compliance-calendar.ts` | Fixed 4 hrefs; added `entityName` to every event |
| `calendar.schemas.ts` | `entityName` field |
| `lib/calendar-labels.ts` (new) | `composeEventTitle` + category/status/source label helpers |
| `lib/format-date.ts` | `formatMonthYear` / `formatMonthShort` / `formatWeekdayShort` |
| `lib/swr-keys.ts` | `calendar.range` accepts a category filter |
| `calendar/page.tsx` | Thin shell — dropped the dead SSR prefetch |
| `calendar/CalendarClient.tsx` | Loading/error, filters/legend/counts, permission gating, reschedule Cancel, localized labels, stable SWR key |
| `components/ui/CalendarMonth.tsx` | Grid a11y, local-day today, fixed 6 rows, date-vocab, tooltip |
| `components/ui/CalendarHeatmap.tsx` | Roving tabindex, ICU plural, date-vocab, tooltip |
| `components/ui/GanttTimeline.tsx` | List a11y, point-event labels, date-vocab, tooltip |

## Decisions
- **Dropped SSR rather than matching windows.** Matching the server render to the
  client's default month window is fragile (month-boundary races) and still
  incurs the whole-payload stringify; the aggregation was 100% discarded, so
  removing it strictly improves the page.
- **Category-level filter, not per-type.** 8 categories map 1:1 to the legend
  colours; a 19-type filter would need its own UI with no extra signal. Category
  filter is server-side (in the SWR key); "my deadlines" is client-side.
- **Title composition on the client.** The server returns `entityName` (a proper
  noun, not translated) + `type`; the client builds `"<type label>: <name>"` so
  the type label is localized. Falls back to the server `title` for
  pre-migration cached events.
- **ICS/export deferred.** The prompt floated "consider adding" a subscribe/export
  affordance — a whole feature (a text/calendar producer); out of scope here.
