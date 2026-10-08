# 2026-10-08 — a theme is stored only when the user picks one

**Commit:** `(this branch) fix(theme): store the theme only when the user picks one`

## Design

`ThemeProvider` wrote a one-year `inflect_theme` cookie and an `inflect:theme` localStorage entry
on MOUNT, holding whatever theme it had resolved. On a first visit that meant the OS
`prefers-color-scheme` result, stored before anyone chose anything. The pre-paint inline script in
the root layout did the same. The intent was flash-proofing: with the cookie written, the NEXT
server render already had the right `data-theme`.

That is a non-essential write on a first page view. Reading `prefers-color-scheme` needs no
storage. A UI-customisation cookie is exempt from consent only when the user asked for the
preference to be kept (Article 29 WP194). playerz.bg (RodnaPamet/projectZ#370) vendors the provider
and was about to state "only essential cookies" in its cookie notice. Inflect is a compliance
product, and the same reasoning applies here.

The rule now, in both places that could write:

- **Resolve as before:** cookie → localStorage → `prefers-color-scheme` → `dark`.
- **Write only in `setTheme` / `toggle`**, which are an explicit choice. Never on mount, and never
  from a `matchMedia` result.
- **With nothing stored, follow the OS live.** A `matchMedia` change listener repaints when the
  system switches, and writes nothing. Once the user chooses, the OS stops moving the theme.

Server rendering is unchanged in shape, and nothing flashes:

- With a cookie (a chosen theme), the first SSR byte is right.
- Without one, SSR renders the `dark` baseline. The blocking `<head>` script sets the resolved
  theme before first paint. The cost is that a visitor who never chose relies on that script on
  every visit, not only the first.

## Files

| file | role |
|---|---|
| `src/components/theme/ThemeProvider.tsx` | no write on mount; `chosen` ref; OS change listener |
| `src/lib/theme-constants.ts` | `THEME_INIT_SCRIPT`, moved from the layout, without its cookie write |
| `src/app/layout.tsx` | inlines the imported script; comments say who writes |
| `tests/rendered/theme-storage-on-choice.test.tsx` | executes provider and script, recording every write |
| `tests/guards/theme-flash-init.test.ts` | script needles follow the script; "writes nothing" on its text |

## Decisions

- **The script moved into the server-safe module.** A layout may export only the fields Next
  allows, and the script is code that runs in a browser, so the rendered suite executes it instead
  of pattern-matching it.
- **Writes are observed at the source.** The test wraps the `document.cookie` setter and
  `Storage.prototype.setItem`. Comparing stored values afterwards would miss a re-write of the same
  value, which is exactly what the old mount path did for returning users.
- **A localStorage-only choice is no longer copied into the cookie on mount.** Such a user made an
  explicit choice under an older build. Their theme still applies before paint from localStorage;
  their SSR stays `dark` until they choose again, and the script hides that.
- **Existing auto-written cookies are not cleared.** A cookie written by the old mount path looks
  exactly like a chosen one, so this change cannot tell them apart. They age out within a year, or
  sooner when the user picks a theme.
