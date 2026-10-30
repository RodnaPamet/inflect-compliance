# 2026-10-30 — The test-database marker is per run (#4610)

## Design

globalSetup records which per-worker databases it created in a marker file.
Workers read it to find their database, through `jest.setup.js` for the app
and `getTestDatabaseUrl()` for the test client. globalTeardown reads it to
know what to drop.

#4608 put the checkout tag in the marker's file name, so separate worktrees
stopped sharing it. Two runs in ONE checkout still shared it. The run lock
admits a second run pointed at another base database through
`DATABASE_URL_TEST`, and its refusal message recommends exactly that. The
second run's globalSetup overwrote the marker, and the first run's later test
files read the second run's database names.

Now each run has its own marker, and nothing derives its path:

```
globalSetup (Jest's main process)
  reapDeadRunMarkers(CHECKOUT_ROOT)        markers of dead runs of this checkout
  markerPath = newRunMarkerPath()          …/inflect-test-perworker-<tag>-<pid>-<hex>.json
  write markerPath
  publishRunMarker(markerPath)             process.env.INFLECT_TEST_RUN_MARKER
        │
        ├─ workers (spawned after globalSetup, inherit the env)
        │     jest.setup.js, getTestDatabaseUrl()  → currentRunMarker()
        ├─ in-band test files (same process)       → currentRunMarker()
        └─ globalTeardown (same process)           → currentRunMarker(), then unlink
```

A process that no globalSetup named a marker for runs in shared-database mode.
That covers the `scan` or `jsdom` project run on its own, and a bare script.

## Files

| File | Role |
| --- | --- |
| `tests/helpers/test-db-checkout.js` | Owns the naming: `RUN_MARKER_ENV`, `runMarkerPath`, `newRunMarkerPath`, `publishRunMarker`, `currentRunMarker`, `reapDeadRunMarkers`. Replaces `perWorkerMarkerPath` and `PER_WORKER_MARKER`. |
| `tests/helpers/db.ts` | Re-exports them; `readPerWorker` reads the named marker. |
| `tests/setup/globalSetup.ts` | Reaps, writes the run's marker, then names it. |
| `tests/setup/teardown.ts` | Drops the databases the named marker lists and deletes it. |
| `jest.setup.js` | Repoints the app's `DATABASE_URL` from the named marker. |
| `tests/unit/per-worker-db-naming.test.ts` | Per-run naming, the two-runs-one-checkout case end to end with the real files, no-marker mode, the test client's read, and the reap. |
| `tests/unit/test-setup-refuses-drifted-db.test.ts` | globalSetup names the marker it wrote, and names nothing when it refuses. |

## Decisions

- **Keyed by run, not by (checkout, base database).** The issue offered both.
  Keying by base would need `jest.setup.js` to resolve the base URL exactly as
  `getBaseTestDatabaseUrl()` does, a second definition that could drift. A
  path handed down cannot disagree with the one written.
- **The premise was measured, not assumed.** Run with `-w 3`, three worker
  processes each saw the marker named by the run's globalSetup and connected
  the app to their own `_w<N>` database. Jest forks its workers after
  globalSetup, so they inherit what it put in `process.env`.
- **Written first, named second**, so no reader is pointed at a file that does
  not exist yet.
- **The pid in the name is what makes cleanup possible.** A killed run never
  reaches teardown, so its marker stays behind, and a per-run name would
  otherwise leave one file per abandoned run. The next globalSetup in the
  checkout deletes markers whose pid is not alive, and the old per-checkout
  marker. It only looks at names carrying its own checkout's tag, so another
  worktree's markers in a shared directory are never touched. The random suffix
  keeps a reused pid from colliding with a live name.
- **A missing or unreadable named marker still means shared-database mode**,
  as a missing marker did before. Nothing here changes what happens when
  globalSetup could not clone.
- **A nested Jest run inherits the outer run's name.** Its own globalSetup, if
  it has one, names its own marker over it. A nested run without globalSetup
  reads the outer run's marker, as it read the shared per-checkout file before.
  That behaviour is unchanged.
