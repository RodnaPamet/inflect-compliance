# 2026-08-25 — Bundle-size budget: fail closed, and measure something real

**Commit:** `<sha> ci(guard): make the bundle-size budget fail closed and run it at PR time`

## Design

`tests/guardrails/bundle-size-budget.test.ts` ran in the `Ratchets` job on every
PR. That job never builds, so `.next/app-build-manifest.json` was always absent,
the suite took its skip branch, and it reported a green pass. It had never once
been able to fail on a pull request.

Investigating turned up a second, worse layer: **the file it read no longer
exists in any job.** Next removed `app-build-manifest.json` in v16 —
`grep -r app-build-manifest node_modules/next` returns nothing on 16.3.1 — so
the gate had also been skipping inside `Bundle Analyze`, the one job that does
build. Every route budget in that file had been dead since the Next 16 upgrade,
and nothing said so, because "no manifest" was spelled "pass".

Three changes, and all three are needed — any one alone leaves a gate that
cannot fail.

**1. A caller's promise, not a filesystem guess.** `BUNDLE_BUDGET_REQUIRE_MANIFEST`
means "a production `next build` ran in this job before this suite". Set: an
absent build is a hard failure. Unset: skip.

| production build output | REQUIRE_MANIFEST | outcome |
| --- | --- | --- |
| present | either | budgets measured + enforced |
| absent | unset / falsy | skip |
| absent | `1` / `true` / `yes` | hard fail |

The signal is explicit because no marker inside `.next` distinguishes a dev tree
from a production one — `BUILD_ID`, `build-manifest.json`, `routes-manifest.json`
and friends are all written by `next dev` too. Inferring there would turn
`npm test` red for any developer with a dev server running, and a gate that
breaks local testing gets deleted rather than fixed. The one dev marker that IS
reliable (`.next/dev` and `.next/node_modules`, which `next build` never writes)
is used only to classify a tree as *not a build* — never to fail one.

**2. A source that exists.** Next 16 writes per-route First Load JS to
`.next/diagnostics/route-bundle-stats.json`, but `writeRouteBundleStats` is
called only under Turbopack, and this repo builds `next build --webpack` for
nonce strict-CSP chunks. A webpack build emits no First Load JS column at all.
What it does emit is one client-reference manifest per route,
`.next/server/app/<route>/page_client-reference-manifest.js`, whose
`clientModules[*].chunks` hold the `static/chunks/*.js` that route ships. First
Load JS is those ∪ `build-manifest.json`'s `rootMainFiles` + `polyfillFiles` —
the same shape Next's own `collectAppRouterStats` computes. They are evaluated
in a throwaway `vm` context (as Next `require`s them) rather than regex-scraped,
so a format change cannot silently under-count.

**3. Run it where a build already exists.** `ci.yml` `Build` compiles the app on
every PR and then throws the output at an artifact. The budget step now sits
between those two, with the require-manifest signal set. Measured cost 6.3-7.2 s
wall (median 6.9 s, `CI=true`, no reachable Postgres) on a job that spends
3.5-5 min in `next build`.

The budgets themselves were recalibrated from the first real measurement. The
old numbers (150-400 KB gzipped) were the file's own admitted "starting targets,
not measured ceilings"; actual maxima are 545-638 KB. New budgets sit ~5% above
the measured worst route in each bucket.

## Files

| File | Role |
| --- | --- |
| `tests/guardrails/bundle-size-budget.test.ts` | Fail-closed contract, Next-16 measurement source, recalibrated budgets, vacuity companion |
| `tests/guardrails/bundle-budget-runs-after-build.test.ts` | New. Asserts the workflow wiring: the suite is invoked after a production build, in the same job, with the signal set, in a PR-reachable job |
| `.github/workflows/ci.yml` | `Build` gains the enforcement step after `next build` |
| `.github/workflows/bundle-analyze.yml` | Existing invocation gains the same signal |
| `tests/guardrails/ci-checks-unreachable-before-merge.json` | `bundle-analyze.yml:analyze` was registered as NOT COVERED at PR time on exactly this basis; the entry now records what covers it |

## Decisions

- **The env var is a promise, not an inference.** Everything in `.next` that
  looks like a build marker is also written by `next dev`. An inferred signal
  would have to be right about a directory whose shape Next changes between
  minors — and being wrong breaks `npm test` locally, which is the failure mode
  that gets checks deleted.
- **Deleting the CI step must go red, not quiet.** Both halves of the fix live
  in workflow YAML, and the failure mode of deleting either is a green pass. The
  new structural guard parses `.github/workflows/*.yml` and asserts the
  relationship between the build step and the enforcement step, including their
  order. It is not a prose check: it reads the file CI executes.
- **The vacuity companion earned its place immediately.** The first live run
  failed it: chunk paths in the manifest are URL-encoded
  (`app/invite/%5Btoken%5D/page-….js`) while the files on disk are not, so 167 of
  265 chunks silently scored zero. The budget assertion alone was perfectly
  happy — every route came in under budget. "No violations" and "nothing was
  measured" are the same observation unless something asserts otherwise.
- **Raising the budget numbers is not weakening the gate.** The old values had
  never been evaluated once. Keeping them would have made the job red on the
  first PR for a reason no reviewer could act on, and the cheapest route back to
  green would have been deleting the step — restoring exactly the state this
  work removes.
- **`budgetKeyFor` is unchanged.** The client-reference manifest keys have the
  same shape as the old app-build-manifest keys
  (`/t/[tenantSlug]/(app)/risks/[riskId]/page`), so the bucket logic ported
  verbatim. Only `/page` entries are measured: `/route` and `/layout` entries
  carry no First Load JS of their own, and counting them reports the shared
  baseline hundreds of times as if it were a page.
- **Turbopack is documented, not implemented.** `route-bundle-stats.json` is the
  right source the day this repo drops `--webpack`. Writing an untested second
  code path today is how the first one died.
