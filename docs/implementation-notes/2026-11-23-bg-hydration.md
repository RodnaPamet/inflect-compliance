# 2026-11-23 — Bulgarian pages hydrate: the date locale survives a resumed render

## Design

About twenty routes logged React error #418 (hydration text mismatch) in
Bulgarian and never in English (#5870). The cause was the server half of the
active date locale that #5858 introduced.

`<Providers>` binds the reader's language once per render
(`useBindDateLocale` → `bindDateLocale`), and the bare helpers (`formatDate`,
`formatDateTime`, `<TimestampTooltip>`, …) read it. In the browser that is a
module value. On the server it was an AsyncLocalStorage store, set with
`enterWith()` during `<Providers>`' render.

`enterWith()` reaches only the async work that render goes on to start. A
streamed SSR render does not continue only from there. When a suspended part
of the tree can go on, React resumes it in the async context of whatever
settled the thing it waited for. In Next that is the flight client, for every
client component under a server component that streams in. Its chunks are
thenables it settles itself, synchronously, from a stream reader that started
reading before React rendered anything. So the resumed part ran with no
locale bound. The server wrote English (also the unbound default), the
browser wrote Bulgarian, and React threw #418 and re-rendered the tree on the
client. A native promise would have carried the binding along, which is why
the existing concurrency test (native `await`s) never saw it. The timing
decides which parts resume, so the error came and went by route and by run,
and a dev server often showed none.

The fix keys the server binding on something that is the same in every
continuation of one request: Next's work store. Next enters it with `run()`
around the whole request, flight reader included. Next's own client hooks
read it during SSR through `next/dist/client/components/server-async-storage`.
Next aliases that module to `undefined` stubs in the browser bundle.
`format-date.ts` takes the scope from the app through
`setDateLocaleRenderScope()`, so the ui package stays framework-free, and
records each scope's locale in a `WeakMap`. The AsyncLocalStorage path stays
as the fallback for a server render with no scope.

The tldraw half of the issue: each canvas drew tldraw's hatched pattern fill
to a canvas and showed it through `blob:` URLs, which `img-src` refused. `blob:`
is now allowed there. tldraw also loads its four font families from
`cdn.tldraw.com`, which `font-src` refuses. That is left as it is, for an
owner decision (see Decisions).

## Files

| File | Role |
| --- | --- |
| `packages/ui/src/lib/format-date.ts` | `setDateLocaleRenderScope`; requires the server half only where `window` is undefined |
| `packages/ui/src/lib/date-locale-scope.ts` | The server half: the binding is per render scope (a `WeakMap`), with the AsyncLocalStorage store as the fallback |
| `src/lib/i18n/use-bind-date-locale.ts` | `nextRenderScope()` (Next's work store); the hook registers it before binding |
| `src/lib/security/csp.ts` | `img-src` allows `blob:` |
| `tests/unit/date-locale-holds-in-resumed-ssr.test.ts` | Real React server renderer, real hook and helpers, inside Next's real request store. The dated part resumes from a flight-style thenable settled outside the render, and its output is compared with what the client writes |
| `tests/unit/csp.test.ts` | `img-src` carries `blob:`; `font-src` is unchanged |

## Decisions

- **A request-scoped key, not a second `enterWith()`.** No place in our code
  runs in the reader's async context, so no binding of ours can reach it. The
  one object every continuation can name is the store the framework entered
  around the request. Next's own `usePathname` / `useSearchParams` read the
  same store during SSR through the same module.
- **The ui package learns no framework.** It takes a scope getter.
  `nextRenderScope` lives next to the binding in the app, so a test can load
  both and a Next upgrade that moves the store fails that test rather than
  production.
- **The server half is out of the browser bundle, for the bundle's sake.**
  With it inside `format-date.ts` (or beside it as a module only it
  imports), the pair passed webpack's 20 KB split-chunk minimum, which
  Next sets and which counts unminified source, comments included. Webpack
  then gave them a chunk of their own and re-partitioned the rest: every
  one of 185 routes moved, from -6 to +10 KB, and three budget buckets
  failed or nearly did, for code the browser never runs. `format-date.ts`
  now requires `date-locale-scope.ts` behind `typeof window === 'undefined'`,
  which webpack resolves at parse time for the browser build, and every
  route measures within 0.1 KB of main.
- **Not `suppressHydrationWarning`.** The text did not differ by time. It
  differed by locale, a request fact both sides know. Suppressing it would
  have left English on the page until the client re-rendered.
- **`blob:` in `img-src` is no new reach.** `data:` is already there. Both are
  images the page's own nonce-admitted script built, and an image cannot run
  script. `connect-src` and `worker-src` already allow `blob:`.
- **The tldraw fonts need an owner decision.** There are two ways to stop the
  violations, and each costs something. Adding `https://cdn.tldraw.com` to
  `font-src` gives a third-party origin to every canvas viewer. (tldraw's icons
  already load from there under `img-src https:`.) Self-hosting means vendoring
  1.4 MB of woff2 files from `@tldraw/assets@3.15.6`, which is under the tldraw
  licence, and keeping them in step with tldraw upgrades. Until a decision,
  tldraw text and notes fall back to the browser's fonts, as they always have,
  and the page logs the font refusals. `csp.test.ts` pins `font-src`, so a
  change has to be deliberate.
