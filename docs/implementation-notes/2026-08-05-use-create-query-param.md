# 2026-08-05 — `useCreateQueryParam`: seven copies become one

**Commit:** `<pending> refactor(ui): extract useCreateQueryParam`

`?create=1` is how a deep link opens a list page's create modal:
`/t/{slug}/assets/new` is a redirect shim to `/t/{slug}/assets?create=1`, so
a bookmark or an emailed link lands on the list with the form already open.
The effect that reads the param, opens the modal, and strips the param ran
as **seven near-identical copies** — assets, audits, controls, evidence,
policies, risks, tasks, vendors.

They differed only in trailing comment text. Each carried the same two
`eslint-disable` lines.

## Why it matters beyond line count

Stripping the param afterwards is the part that is easy to omit and matters:
leave it in the URL and the modal reopens on every back-navigation, because
the param is still there. `router.replace` (not `push`) keeps that
correction out of the history stack, and `scroll: false` stops the list
jumping to the top behind the modal.

That is three non-obvious decisions, duplicated seven times — seven places to
fix a bug once, and seven chances to fix it in only six.

## A suppression removed rather than moved

At the call sites the `setState` was inline, so
`react-hooks/set-state-in-effect` fired and every copy suppressed it. Behind
the hook boundary it is an opaque callback, so the rule no longer fires and
the suppression is **gone**, not relocated. One fewer disabled lint rule in
seven files.

## Decisions

- **The hook takes `basePath`, not a slug + entity.** Callers already have
  the exact path they want to rewrite to; deriving it inside would need a
  second convention that the call sites would then have to match.
- **Other query params are preserved.** `URLSearchParams` is rebuilt minus
  `create`, so a page reached with both `?create=1` and active filters keeps
  the filters.
- **First mount only.** Re-running on a later `searchParams` change would
  reopen the modal after the user closed it — the original copies all had
  this, and the hook keeps it with the reason written down.

## Scope

This is one of the four extractions the roadmap item lists. `useSsrFallback`
(6 copies of `filtersMatchInitial`), `useSoftDeleteView` (3), the status→tone
map consolidation, and the `NewAssetFields` / `EditAssetFields` merge remain.
The form merge is the large one: two components rendering the same 14 fields
with divergent validation, string plumbing, and a hint-vs-description split
that renders identical copy as a hover tooltip on create and visible body
text on edit. It wants its own change.
