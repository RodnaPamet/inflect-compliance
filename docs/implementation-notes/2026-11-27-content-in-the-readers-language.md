# 2026-11-27 — Catalogue content in the reader's language (plumbing)

**Issue:** #5996 (step 1)

## Design

Owner decisions of 2026-11-27: untouched catalogue text follows each viewer's
language, a person's own text shows as written, and every framework is
translated.

Framework requirements, control templates, their tasks and steps, risk
templates, and the Control and Task rows a workspace installed from them are
stored in English. Instead of a locale column on every table and a backfill of
every workspace, the Bulgarian text lives in dictionaries keyed by the exact
English source text:

```
src/data/content-i18n/bg/<family>.json   { "<English>": "<Bulgarian>" }
        │  static imports (index.ts)
        ▼
lib/content-i18n/dictionary.ts  translateContentText(locale, text) → string | null   (server)
        ▲
POST /api/t/:slug/content-translations  { locale, texts[] } → { translations }       (any member, read budget)
        ▲  one request per tick, cached per page load
lib/content-i18n/use-content-text.ts  tc(text)      <ContentText text=… />           (client, display only)
```

A stored string that still equals a catalogue string finds its translation. One
a person edited does not, and shows as written. So a translation can never
overwrite an edit, and existing workspaces are covered with no data change.

`scripts/content-i18n/sources.ts` lists every translatable catalogue string by
family (about 37,000 strings, 4.7 million characters), and
`tests/guardrails/content-i18n-coverage.test.ts` holds the count of untranslated
strings per family to a baseline that only goes down.

## Files

| File | Role |
| --- | --- |
| `src/data/content-i18n/bg/` | The dictionaries; `generic-tasks.ts` is built from the generic titles' single owner |
| `src/lib/content-i18n/dictionary.ts` | Server lookup |
| `src/lib/content-i18n/limits.ts` | Batch and length limits, the lookup key (client-safe) |
| `src/app/api/t/[tenantSlug]/content-translations/route.ts` | The lookup for client components |
| `src/lib/content-i18n/use-content-text.ts`, `src/components/ContentText.tsx` | `tc()` and its element form |
| `scripts/content-i18n/sources.ts` | What needs translating, by family |
| `tests/guardrails/content-i18n-coverage.{test.ts,baseline.json}` | Coverage ratchet |
| `ControlsClient`, `TasksClient`, `TaskChecklistPanel` | First surfaces wired: control names, task titles, steps, hints |

## Decisions

- **Keyed by source text, not by row id.** Installed rows carry no reliable
  pointer back to the catalogue string they came from, and an id key would
  translate a row a person had since rewritten.
- **Display only.** An edit field shows the stored text. Saving a translation
  would make it an edit, and the row would then stop following the viewer.
- **Server dictionaries, client asks.** The Bulgarian text will be several
  megabytes; shipping it in a client bundle would put it in every reader's
  download, English readers included.
- **English first, then the translation.** `tc()` returns the stored text until
  the answer arrives, so nothing is blank; the cost is a brief switch on first
  view of a page. Server components can call `localizeContentText` directly and
  avoid it.
- **Known limits:** list search and sort still run over the stored English
  text, and exports and emails are not wired yet (both are steps in #5996).
