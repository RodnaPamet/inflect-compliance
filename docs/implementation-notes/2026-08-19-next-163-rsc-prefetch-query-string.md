# 2026-08-19 — the RSC prefetch that never resolves under next 16.3.1

**Commit:** `(this PR)` fix(dashboard): stop prefetching the KPI drill routes

## What was actually wrong

`next` 16.3.1 was quarantined (#1973 closed, #2001 shipped the other 18 bumps)
because four E2E tests failed. The diagnosis was wrong **twice** before this,
and both wrong answers pointed at the wrong file:

| reading | why it was wrong |
| --- | --- |
| "mobile CSS overflow regression" | inferred from the spec's FILENAME. The failures are 3-minute *timeouts*, not assertion failures, and only 2 of 4 are overflow tests |
| "SSR streaming aborts" | the 80× `destination stream closed early` errors are real and new, but upstream [#96704](https://github.com/vercel/next.js/issues/96704) confirms a *reporting* bug with no functional impact |

## The actual mechanism

1. A dashboard KPI tile drills into a **query-string** route —
   `DashboardClient.tsx:761`,
   `drillHref={href('/tasks?status=OPEN,TRIAGED,IN_PROGRESS,IN_REVIEW,BLOCKED')}`.
2. `KpiTile` renders it as a plain `<Link href={drillHref}>` with no `prefetch`
   prop, so Next's default viewport prefetch applies.
3. Next issues an RSC prefetch: `/t/<slug>/tasks?status=...&_rsc=<hash>`.
4. **Under 16.3.1 that request never resolves.**
5. `page.waitForLoadState('networkidle')` therefore never settles, so
   `gotoAndVerify`'s retry loop exhausts and the test burns its full 180s.

## The measurement

Instrumented probe (`page.on('request'/'requestfinished')`), same machine,
database, seed, build and test commands — only `next` differing:

| `next` | networkidle | in flight at 45s |
| --- | --- | --- |
| 16.2.12 | **settled** | 0 |
| 16.3.1 | never settles | 1 — `/tasks?status=…&_rsc=…`, 44s, unresolved |

With `prefetch={false}` on that link, at 16.3.1: networkidle settles, 0 in
flight, and **all 10 `responsive.spec.ts` tests pass** (1.5 m) — the four that
previously timed out now run in 5–12 s each.

## Why only the dashboard

The asymmetry that made this hard to place. The sidebar prefetches **fourteen**
routes on every authenticated page (`nav-item.tsx`, a deliberate "instant nav"
lever) — but those are **bare paths**, and they resolve fine. The dashboard is
the only page whose links carry a **query string**. `/vendors` has none, which
is exactly why it passed while the dashboard hung.

## Decisions

- **This is a workaround, labelled as one.** The framework bug stands. Any
  future page that prefetches a query-string route will hang the same way under
  16.3, so this does not "fix" 16.3 adoption on its own — it removes the one
  instance we have.

- **It is also correct on its own merits, independent of the bug.** Those hrefs
  are force-dynamic list routes with filters. Prefetching them renders each
  filtered list server-side on every dashboard view, for an arrow icon that is
  rarely clicked. The sidebar's prefetch is a considered performance lever; this
  one was just the default.

- **The reasoning lives at the call site, not only here.** A future reader
  seeing `prefetch={false}` on a nav link will reasonably think it is a mistake.
  The in-file comment tells them what to re-run before removing it.

## What this does NOT close

The 16.3 bump stays out until someone re-runs the E2E suite against it. Also
still open when 16.3 is adopted: the streaming-error noise from #96704 would
put ~80 false errors per run into Sentry.
