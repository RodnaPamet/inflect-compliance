# 2026-08-11 — The DB-backed suites fail closed

**Commit:** `<sha>` test(ci): an unavailable database fails the build instead of skipping 169 suites

## What was true

`tests/integration/db-helper.ts` probes for a live Postgres with a subprocess
`$connect()` + `SELECT 1`, and exports the result as `DB_AVAILABLE`. 166 suites
consume it in one shape:

```ts
const describeFn = DB_AVAILABLE ? describe : describe.skip;
```

A failed, slow or misconfigured probe therefore converted every one of them into
a skip, and a run full of skips is **green**.

The population behind that flag is not incidental. 169 files import the helper,
across `tests/integration`, `tests/unit/jobs` and `tests/guardrails`:

| suite | what it is the only proof of |
|---|---|
| `rls-isolation`, `rls-coverage` | Postgres row-level security actually isolates tenants |
| `tenant-isolation-usecases`, `task-isolation` | cross-tenant reads/writes are refused at the usecase layer |
| `epic-b-encryption` | field encryption round-trips under the per-tenant DEK |
| `audit-immutability`, `org-audit-immutability` | the hash-chained audit trail cannot be rewritten |
| `multi-tenant-jwt`, `last-owner-guard` | session and ownership invariants |
| `task-reviewer-watcher`, `task-source-reconcile` | the four-eyes gate and the seven reconcilers |

So the strongest behavioural evidence this repo has for tenant isolation could
report success without executing a line.

**It had already happened once.** The comment on the probe's own timeout records
it: 5 seconds was too tight, and "EVERY integration suite silently skipped —
tests appeared to pass while never running". The fix at the time was to raise the
timeout to 30 s, which narrows the window without closing it — any slow,
misconfigured or briefly-unreachable database still buys a green run.

## What changed

The default is now to **throw**. Skipping remains available, but it must be
asked for:

```
ALLOW_DB_SKIP=1 npx jest <pattern>
```

CI never sets it, so in CI an unavailable database is a hard failure. The
asymmetry is the point: opting into weaker signal should take an explicit act,
and the default should be the safe one.

The error names the redacted URL, how to start the stack locally, and the
opt-out. Passwords are stripped before the URL reaches the message.

`tests/guards/integration-suites-execute.test.ts` covers the other way this
population can collapse — the suites being deleted, renamed out of the glob, or
un-gated one at a time. A failing probe and an empty population have the same
consequence (no isolation coverage), but only the first is loud, because
deleting a test never turns anything red. The guard also asserts that no
workflow file sets `ALLOW_DB_SKIP`, since doing so would make the fail-closed
probe inert.

## Verification

Not "the tests pass" — the three behaviours were exercised directly:

| condition | result |
|---|---|
| live DB, no flag | 11 assertions pass; suites execute |
| dead DB (`127.0.0.1:1`), no flag | `Test Suites: 1 failed`, `Tests: 0 total` — the throw, with the runbook |
| dead DB + `ALLOW_DB_SKIP=1` | `Test Suites: 1 skipped` — local behaviour preserved |
| dead DB with a password in the URL | `probed: postgresql://nobody:***@…`; zero occurrences of the password in the output |

## Decisions

- **A hard failure, not a warning.** A warning in a 2000-suite run is a line
  nobody reads. The whole defect is that the signal was quiet.
- **An explicit opt-out flag rather than CI detection.** `if (process.env.CI)`
  would put the safe behaviour behind an environment guess and leave the unsafe
  one as the default everywhere else. Inverting it means a contributor without
  Postgres gets one loud, actionable error the first time, and the flag
  thereafter — while no CI configuration can drift into skipping.
- **The throw is at module scope, so it fails 166 suites at once.** That is
  noisy on purpose. The guard test exists so the run also carries one clearly
  named failure explaining what happened, rather than only a wall of identical
  module-load errors.
- **The floor in the guard is a collapse detector, not a growth ratchet.** It
  sits at 150 against a live 169 so ordinary churn does not force an edit, while
  losing a third of the population stops the build.
- **The decision is a pure function in its own module, and that was learned the
  hard way.** The first version had the guard import `db-helper` and assert
  `DB_AVAILABLE === true`. That turned the CI `Ratchets` job red — a job whose
  own comment says it is DB-free on purpose ("if a ratchet is ever added that
  needs one, it belongs in the sharded run instead"). The guard was demanding a
  database from the one job designed not to have one.

  Splitting `assertDbAvailableOrSkipAllowed` into `db-availability.ts` fixes the
  cause rather than the symptom. The alternative — setting `ALLOW_DB_SKIP=1` on
  the Ratchets job — would have made the fail-closed probe inert in CI to
  silence a failure caused by the fix itself, which is the exact shape of defect
  this note is about. The guard now exercises all three branches of the decision
  with no database at all, and runtime enforcement stays inside the suites that
  genuinely need one.
