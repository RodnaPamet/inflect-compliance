# 2026-11-24 — Mobile audit: fixture setup for the uncaptured detail and token routes

## Design

The nightly whole-product mobile audit (`scripts/mobile-audit/`) never measured
16 routes: the audit database held no registered agent, workflow run,
integration connection, vendor assessment, A2A peer, trust center or NIS2
assignment, and the three public token routes (shared audit, tenant invite,
org invite) need a token the product stores only as a hash.

`--create-records` is now a named fixture SETUP step (`fixtures.ts`, which
replaces `records.ts`) that runs before anything is measured:

```
sign in (tenant owner, org owner)
  → setUpAuditFixtures: FIXTURES in order, each through the product's API
      record fixtures: run only when the database holds none (exists)
      token fixtures:  run every time, keep the raw token in SetupOutcome.tokens
      a failure:       SetupOutcome.failed[what] = why; the next fixture still runs
  → resolveRoute(route, { ...seeded, setup })
      a resolver's missing record names its fixture; a failed fixture
      becomes "setup failed: <why>"; token routes read SetupOutcome.tokens
  → measure
```

The report carries a `setup` block (created, minted, failed), rendered as a
"Fixture setup" section of `summary.md`.

## Files

| File | Role |
|---|---|
| `scripts/mobile-audit/fixtures.ts` | The setup step: every fixture, the API wrapper, `setUpAuditFixtures` |
| `scripts/mobile-audit/resolve.ts` | Resolvers name their fixture; token routes and `?t=` for the respondent page; "setup failed" reasons |
| `scripts/mobile-audit/run.ts` | Runs the setup before resolving, records its outcome in the report; a page whose measurement throws is reported, not fatal |
| `scripts/mobile-audit/report.ts` | "Fixture setup" section; comparison over routes captured in both runs |
| `docs/mobile-audit.md` | The setup and the comparison rule |
| `tests/unit/mobile-audit-fixtures.test.ts` | Setup and resolver behaviour |

## Decisions

- **Through the API, never SQL.** Each fixture uses the route a person or the
  E2E suite uses (`agentic-surface-with-data.spec.ts` for the agent and run,
  `mobile-vendor-questionnaire.spec.ts` for the questionnaire link,
  `addMember` for the invite), so a fixture cannot hold a shape the product
  would refuse.
- **One connection serves three routes.** The external-write ladder only
  exists for MCP server and A2A peer connections, and an A2A peer connection
  names a registered peer rather than a server URL. So the setup registers a peer with
  a pasted Ed25519 key (its card URL is an RFC 2606 `.invalid` host, which
  never resolves, so the usecase takes the pasted key) and an `a2a-peer`
  connection for it. The connection detail and reconciliation pages resolve
  the same connection.
- **Tokens are minted each run, and bounded.** Only hashes are stored, so no
  run can reuse an earlier run's token. The invites are upserts on a fixed
  address (the token rotates, no row is added), an assessment already out to
  the audit's respondent is resent rather than sent again (a second send is
  refused), and a share link expires after two days. The share uses the
  seed's frozen pack; it makes and freezes one only when there is none.
- **The respondent page gets its token in `?t=`**, as the product's own link
  does. A resolver may now return `{ values, search }` for that.
- **Comparison over routes captured in both runs.** Without it, the first
  night after this change would have failed on every defect of 16 pages that
  had never been measured, and opened a "pages regressed" issue about pages
  that had not regressed. A newly captured route is listed as newly measured
  in `comparison.md` and compared from the next night on. A route that stops
  being captured is still caught, by the uncaptured count.
- **Fail closed.** A fixture failure is never thrown or swallowed: it is a
  line in the summary's "Fixture setup" section and the reason on every route
  that needed it.
- **One page cannot stop the run.** The first local run with the new routes
  died at the 100th page of the third configuration: `measurePage` threw
  (`document.body` was null, the page had navigated under the measurement),
  and the uncaught error lost the whole report. `capture` now settles and
  measures once more, and a second failure makes that page "measurement
  failed: <why>", which the uncaptured count still catches.
