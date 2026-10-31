# 2026-10-30 — no-floating-promises covers the UI (#4585)

## Design

#4579 made `@typescript-eslint/no-floating-promises` an error in
`src/app-layer/**` and `src/lib/**`. #4585 asked whether the UI should follow,
and the owner chose to make it an error across all of `src/` and to handle
every site deliberately.

The issue expected almost no defects in the UI, because its ~165 sites looked
like React handlers whose callees handle their own errors. A measurement on the
issue found 9 that did not. #4634 fixes those nine, and this change sits on top
of it. Reading each callee rather than each call found more:

| What the site floated | Sites | Treatment |
| --- | --- | --- |
| SWR revalidation or a synchronous cache update | 56 | `void`: SWR keeps a fetch error in its own `error` state |
| An async IIFE that already catches | 18 | `void` |
| A `.then` chain ending in `.catch` | 2 | `void` |
| A local loader whose `try` covers its awaits | 40 | `void` |
| A local loader with **no** `catch` | 33 sites, 16 loaders | the loader now catches, then `void` |
| SWR-returning helpers and renamed mutators | 9 | `void` |
| `reader.cancel()` in the CSP-report route | 1 | `.catch(() => {})` |

The sixteen loaders were `try/finally` with no `catch`, or had no `try` at all.
A network failure escaped them as an unhandled rejection. Each now catches and
reaches the state its non-ok path already reaches:

- **Keep what is shown.** Where a non-ok response is ignored, so is a rejection.
- **The same toast.** The vendor detail tabs already toast on a non-ok
  response, and now do the same on a network failure.
- **A network message.** Three admin pages show an error that includes the HTTP
  status. A rejection has no status, so each gets a `loadErrorNetwork` key, in
  English and Bulgarian.

The vendors dashboard was the user-visible one. Its loader had no `try`, so a
rejection skipped `setLoading(false)` and the page showed its skeleton forever.
`tests/rendered/vendors-dashboard-load-failure.test.tsx` holds it; it fails
against the old loader.

## Files

| File | Role |
| --- | --- |
| `eslint.config.mjs` | The type-aware block covers `src/**/*.ts(x)` instead of app-layer and lib. |
| 16 loaders in 10 files | Catch a network failure. |
| 77 files in `src/` | `void` on 158 call sites whose callee owns the failure. |
| `messages/en.json`, `messages/bg.json` | Three `loadErrorNetwork` keys. |
| `tests/guards/no-floating-promises.test.ts` | Renamed from `…-in-server-code`. It now also resolves the config for UI pages, components and routes, real and planted. |
| `tests/rendered/vendors-dashboard-load-failure.test.tsx` | The dashboard reports a failed load on a network failure. |

## Decisions

- **`void`, not a config allowlist.** The rule offers
  `allowForKnownSafeCalls` and `ignoreIIFE`. `ignoreIIFE` would also exempt an
  IIFE with no `catch`, which is two of #4634's nine. An SWR allowlist would
  exempt a mutate that passes an async updater, which can reject. A `void` at
  the site shows the decision where a reader sees it.
- **Callees were read, not assumed.** Classifying by the call's shape counted
  every plain call as safe. Reading the callee found 33 that were not. A callee
  counted as safe only if every `await` sat inside its `try`.
- **`ClausesBrowser.updateStatus` keeps its existing gap.** A network failure
  now leaves the status as it was. A non-ok response still updates the screen
  without checking `res.ok`. That is a separate bug, and this change does not
  widen it.
- **Cost.** The #4585 measurement put the Lint job at +39% (+67 s) with the UI
  in the type-aware program. Peak memory is unchanged.
