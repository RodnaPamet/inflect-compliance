# 2026-10-30 — the per-worker test-DB marker, per checkout

**Commit:** `(this PR)` fix(tests): give each checkout its own per-worker test-DB marker

## Design

globalSetup records the per-worker database mode and the exact database names
it created in a marker under `node_modules/.cache/`. Every worker reads it to
find its database (`jest.setup.js` for the app's client, `getTestDatabaseUrl()`
for the test client), and globalTeardown reads it to know what to drop.

The 2026-08-19 note says that marker was "repo-local". It was, for a checkout
with its own `node_modules`. Worktrees on the dev machine symlink `node_modules`
to the main checkout's, so the fixed name `inflect-test-perworker.json` was
one file for every worktree. Measured with two checkouts sharing one
`node_modules`, each with its own base database, running integration probes at
the same time on `main`:

- the earlier run's later test files connected to the other checkout's
  databases (or to a name built from the other checkout's base and their own
  tag, which does not exist);
- the earlier run's teardown dropped the other run's databases `WITH (FORCE)`
  while that run's tests were still connected, and left its own behind.

The checkout tag already kept the database NAMES apart. The marker now
carries the same tag in its file name, so two checkouts in one directory hold
two records.

```
tests/helpers/test-db-checkout.js   (CommonJS, Node built-ins only)
  tagForRoot, checkoutTag, CHECKOUT_ROOT, perWorkerMarkerPath, PER_WORKER_MARKER
        ▲                                   ▲
        │ require                           │ import + re-export
  jest.setup.js                     tests/helpers/db.ts
                                      ▲  globalSetup (write), teardown (read, drop, unlink),
                                      │  getTestDatabaseUrl (read), reap script (tag)
```

## Files

| File | Role |
| --- | --- |
| `tests/helpers/test-db-checkout.js` | The one definition of the tag, the checkout root and the marker path |
| `tests/helpers/db.ts` | Re-exports them; the lock key now uses the same `CHECKOUT_ROOT` |
| `jest.setup.js` | Requires the marker path instead of spelling a literal |
| `tests/unit/per-worker-db-naming.test.ts` | Two checkouts on one `node_modules`, end to end through the real `jest.setup.js` |

## Decisions

- **One CommonJS module rather than a test that two derivations agree.**
  `jest.setup.js` runs before every test file in two projects and must not load
  `db.ts`'s Prisma and `pg` graph. A dependency-free CommonJS file loads under
  Jest's transform, under tsx and under bare `node`, so both sides require the
  same code and there is nothing to keep in step.
- **The require in `jest.setup.js` sits outside its `try`.** Inside, a renamed
  helper would read as "no marker" and every worker would fall back to the
  shared base database while globalSetup had cloned per-worker ones.
- **Still under `node_modules/.cache/`.** It is gitignored and Jest's watcher
  does not crawl it. `os.tmpdir()` stays ruled out (a predictable name there is
  a symlink-race vector). The file name, not the directory, is what is per
  checkout.
- **Per checkout, not per run.** The concurrent-run lock refuses a second run
  on the same (checkout, base database), but it admits a second run in the
  same checkout pointed at another base through `DATABASE_URL_TEST`, which is
  the escape hatch its refusal message offers. Those two runs still share this
  marker. Keying the marker on the base as well would need `jest.setup.js` to
  resolve the base URL exactly as `getBaseTestDatabaseUrl()` does. That is left
  open, and the lock's docblock says so.
- **Nothing else under `node_modules/.cache/` needed the same change.** The
  concurrent-run lock is a Postgres advisory lock, not a file, keyed on the
  checkout tag. The E2E TLS cert is the same throwaway localhost cert for every
  checkout, and the E2E harness's fixed ports already stop two checkouts
  running it at once.
- **A run from an older branch is not affected by this one.** It keeps writing
  the old fixed name, which no new-code reader opens.
