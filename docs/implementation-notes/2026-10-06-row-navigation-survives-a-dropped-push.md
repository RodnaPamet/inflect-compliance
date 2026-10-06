# 2026-10-06 — a row-click `router.push` that survives being dropped

**Issue:** #3099 · **Upstream:** [vercel/next.js#99651](https://github.com/vercel/next.js/issues/99651) (closed for want of a minimal reproduction)

## Design

A cold row click inside the hydration window issues its navigation and nothing
happens. Measured on three independent captures of the same failure (CI run
36929866055, all three attempts, re-measured from the raw HAR rather than the
trace viewer):

| per attempt | t0 | t1 | t2 |
|---|---|---|---|
| detail RSC request (`rsc:1`, no prefetch header) | 200 / 12 ms | 200 / 43 ms | 200 / 36 ms |
| offset after the `/agents` document request | +672 ms | +778 ms | +789 ms |
| `[agentId]/page-*.js` chunk | 200, +821 ms | 200, +1117 ms | 200, +964 ms |
| requests started **>1000 ms** after the click | **0** | **0** | **0** |
| `console.error` / `pageerror` in the whole trace | **0** | **0** | **0** |
| document navigations after `/agents` | none | none | none |

Four of those are load-bearing. The destination's page chunk arrived 149-339 ms
*after* the RSC response, and React's Flight client requests that chunk only when
it resolves a client reference — so **the payload decoded**. Zero
`console.error` eliminates every logging path in the installed router. No
document navigation eliminates every MPA fallback. And the URL never changed,
which is mechanical proof the transition never committed: `app-router.js`'s
`HistoryUpdater` effect is keyed on `[appRouterState]`, so the URL is written
only after React commits.

The surviving hypothesis — stated as one in #3099's mechanism report, because
React's lane state is not visible from a Playwright trace — is a transition lane
scheduled and never committed, under ~75-100 in-flight RSC requests from the
sidebar's own viewport prefetch. The two hypotheses the issue opened with were
refuted from installed source: segment-cache eviction is reachable only under
`if (task === null && inProgressRequests === 0)`, so it can never run in the
window this failure lives in, and prefetches never enter the action queue at all.

So this is a deliberate userland workaround over a mechanism the repo cannot fix,
and it is **also the only instrument** for how often the defect reaches real
users. The defect's entire visible trace in this repo's history is an E2E flake.

### The predicate, which matters more than the retry

The naive check is "did we reach the target", and it is wrong: it fires a second
navigation at a user who clicked a row, changed their mind inside the grace
window, and went somewhere else. That is a worse bug, because it is not
load-dependent — it hits every user who hesitates.

With `startPath` captured at click time:

    retry  ⟺  location.pathname === startPath  ∧  targetPath !== startPath

* push committed → pathname is the target ≠ `startPath` → no retry
* user went elsewhere → pathname is a third path → no retry
* push dropped → pathname is still `startPath` → retry, once

The second term covers the degenerate click: a push that cannot change the
pathname (a query-only `?view=deleted`) is indistinguishable from a dropped one
by a pathname test, so no watch is armed for it at all.

One known false positive, and it is cheap: leave `startPath`, come straight back
to it, inside one second. Closing it needs a pathname SUBSCRIPTION rather than a
sample; the cost of being wrong is one extra navigation to a href the user asked
for a second earlier, where an unguarded dropped click is a dead row.

### The delay

`DROPPED_PUSH_GRACE_MS = 1000`, bounded from both directions by the same three
captures. Upper bound on a healthy navigation: everything a committing
navigation needed had arrived 339 ms after the click in the worst capture, so
1000 ms is ~3x that. Lower bound on terminal silence: "zero requests started
>1000 ms after the click" is measured in all three. A retry that fires against a
navigation still in flight is idempotent anyway — same href, same destination.

### Telemetry through the existing sink

The send logic moved out of `<WebVitalsReporter>` into
`src/lib/observability/client-telemetry.ts`: one URL, one payload shape, one
`NEXT_PUBLIC_TEST_MODE` gate, one swallowing catch. `NAV_PUSH_RETRY_METRIC`
joins `KNOWN_VITALS` on the server, **imported rather than retyped**, so the
producer and the allowlist cannot drift into silent 400s — a dropped metric is
otherwise indistinguishable from a defect that never happens.

The sample carries the ORIGIN list route and no row id. A list pathname has none
by construction, so the privacy property does not depend on the server-side
normaliser. `tests/guards/flue-telemetry-carries-no-content.test.ts` reads one
module (`src/lib/agentic/flue/telemetry.ts`) and so does not cover this file; the
rule it encodes — operation shape, never content — is honoured by the shape of
`ClientMetricSample`, which has no field for a payload, a label or a note.

The module deliberately carries **no `'use client'` directive**: it is shared, and
`web-vitals.ts` (server) imports the metric-name constant from it.

### Scope, derived

A regex-plus-scope-resolution derivation over `src/`, printed in the guard:
**1,018** `.tsx` files swept, **37** row-activation handlers recognised across
**27** files, of which **18 navigate** — migrated, across **16** files (coverage
and the tests page each navigate from two tables). The rest open a sheet, toggle
a selection, or forward a prop.

Three names in the original brief's scope list were **false premises** and are
recorded as such: `evidence` opens a sheet (`openEvidenceDetail` → `setDetailSheetOpen`),
`findings`' `DataTable` wires no `onRowClick` at all, and `audits`' only
`router.push` is a cycle filter (`?cycleId=`) — a same-path query change, not a
row navigation.

### Why a lint rule and not a choke point

`onRowClick` is typed `(row, e) => void`; `DataTable` cannot tell a navigation
from a sheet-opener or a selection toggle, and several live call sites are
exactly those. So there is nothing to put the fix behind.
`local/no-router-push-in-row-click` is the obligation instead — an AST rule,
because eleven of the eighteen sites pass their handler BY NAME and a source
regex cannot follow that (nor can it tell the pattern from a doc comment, of
which this change found three teaching it).

## Files

| File | Role |
| --- | --- |
| `src/lib/nav/use-guarded-push.ts` | the hook: predicate, grace window, one retry, the counter |
| `src/lib/observability/client-telemetry.ts` | the beacon lifted out of `WebVitalsReporter`, plus the metric name |
| `src/lib/observability/web-vitals.ts` | `NAV_PUSH_RETRY_METRIC` added to the server allowlist, imported |
| `src/components/observability/WebVitalsReporter.tsx` | now calls the shared beacon |
| 16 list clients + `LinkedTasksPanel.tsx` | 18 call sites migrated off `router.push` |
| `eslint-rules/rules/no-router-push-in-row-click.js` | the AST rule + two census modes |
| `tests/guards/row-click-navigation-uses-the-guarded-push.test.ts` | runs the rule over git's population, floors the denominator, caps the holes |
| `src/components/ui/table/GUIDE.md`, `data-table.tsx` JSDoc | stopped teaching the banned pattern |

## Decisions

* **The exemption list is empty.** All eighteen call sites tolerate an idempotent
  retry. `allowRawPush` exists so a future exception has somewhere to be argued,
  not because one was found.
* **`onRowAuxClick` is out of scope.** A middle click opens a new tab through
  `window.open` / `<a target>` and never enters the client router, so the defect
  cannot reach it. Including it would have been coverage theatre.
* **The retry is a bare `router.push`, not a recursive guarded one.** Once means
  once; the evidence for that is the issue's own observation that a second click
  navigates normally.
* **Unmount cleanup is belt and braces, not the mechanism.** Leaving the page
  clears the pending timer, which removes the common shape of the false positive
  for free — but the predicate is what the behaviour rests on, and it is tested
  directly as well as through the hook.
* **Three guards and two unit tests were updated rather than exempted**
  (`p4-control-polish`, `policies-list-shell-adoption`,
  `risks-list-shell-adoption`): each asserted `router.push` as a proxy for
  "client navigation, not a document load", and the hook satisfies that
  invariant strictly more than the raw call did. Span bounds were left untouched
  so the Class C ratchet does not move.
