# 2026-08-19 — two checkouts, one Postgres, and `DROP … WITH (FORCE)`

**Commit:** `(this PR)` fix(tests): namespace per-worker databases per checkout

## Design

Per-worker DB isolation (2026-06) gives each Jest worker its own clone of the
migrated base DB, so parallel integration tests can `TRUNCATE` freely. The
worker name was `<base>_w<id>` — a pure function of the database name in the
connection URL.

Two clones of this repo on one machine, pointed at one Postgres, therefore
derive **identical** names. And `globalSetup` does not merely recreate them:

```sql
DROP DATABASE IF EXISTS "inflect_test_w1" WITH (FORCE)
```

`FORCE` calls `pg_terminate_backend` on every attached session first. The second
run to start does not race the first — it **hangs up on it**, mid-transaction.

The symptom is why this went unattributed for a while: `Test suite failed to
run` with **zero failed tests**, in whichever DB-backed suite happened to be
holding a connection. Not a suite that failed — a suite that never got to
speak, in a file unrelated to anything either checkout had changed. It reads as
flakiness in someone else's test.

The ownership marker (`node_modules/.cache/inflect-test-perworker.json`) is
repo-local while the databases were global, so each side kept a private record
asserting ownership of a shared resource.

**Fix:** fold a short hash of the **repo root** into the name.

## Why the repo root and not the URL

The two colliding checkouts reached the same database by *different routes* —
one through `.env.test`, the other through `tests/helpers/db.ts`'s own default,
with no env file at all. Any scheme keyed on the connection string can agree by
accident, and two checkouts may legitimately hold identical URLs. The root
cannot collide, because it is what makes them two checkouts.

One checkout is unaffected: the tag is stable per path.

## Files

| File | Role |
| --- | --- |
| `tests/helpers/db.ts` | `tagForRoot` / `checkoutTag` / `perWorkerDbName` — the sole definition of the scheme |
| `tests/setup/globalSetup.ts` | creates via `perWorkerDbName`; records the names in the marker |
| `tests/setup/teardown.ts` | drops the **recorded** names, falling back to recomputation |
| `jest.setup.js` | repoints the app's prisma client at the recorded name |
| `tests/unit/per-worker-db-naming.test.ts` | the property, the 63-byte refusal, cross-site agreement |

## Decisions

- **The marker records the names created.** Teardown drops those rather than
  recomputing, so a future change to the scheme cannot orphan databases that a
  running teardown no longer knows how to name.

- **`perWorkerDbName` refuses past 63 bytes instead of truncating.** Postgres
  truncates identifiers silently; two workers differing only past byte 63 would
  collapse onto one database — this bug again, wearing a different hat.

- **Residual, accepted knowingly.** The shared *base* DB is still terminated
  before cloning (`CREATE DATABASE … TEMPLATE` requires the template idle), so a
  **serial** run (`--runInBand`) in another checkout can still be interrupted.
  Parallel-vs-parallel — the case that actually bites, since `npm test` is
  parallel — is fully isolated. Namespacing the base too would mean a migrate
  per checkout; not worth it for a case neither of us hits.

## Two things this cost, worth keeping

**A fourth naming site, found by running it.** `jest.setup.js` is plain JS and
cannot import the helper, so it re-derived the name by *concatenation*
(`'_w' + wid`). My grep for other sites searched for the template-literal form
I had just written, and missed it. The tagged databases were created correctly
while the app connected to `inflect_test_w1`, which did not exist. Only an
actual DB-backed run surfaced it.

**A test that asserted mention, not use.** The first cross-site test checked
that `jest.setup.js` contained the string `marker.workerDbs`. It survived a
mutation that kept the lookup and dropped it from the assignment — which is
precisely the bug. It now reads the `u.pathname =` statement itself.
