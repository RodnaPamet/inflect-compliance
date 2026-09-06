# 2026-09-06 — one Jest run at a time per (checkout, base database)

**Branch:** `feat/agentic-10`

## Design

Per-worker test databases are named `<base>_<checkoutTag>_w<id>`, and
`checkoutTag()` hashes the REPO ROOT. That makes two CHECKOUTS safe — the
property it was built for (2026-08-19), and it works.

It does nothing for two CONCURRENT RUNS in ONE checkout. Both derive the same
tag, the same base, and therefore the same `_w1` / `_w2` names. `globalSetup`
then `DROP DATABASE ... WITH (FORCE)` + `CREATE DATABASE ... TEMPLATE`s them,
and `resetDatabase()` `TRUNCATE ... CASCADE`s them in every `beforeEach`. The
two runs demolish each other mid-test and neither is told. What arrives instead
is a deadlock, an FK violation, or a suite whose population vanished between
its setup and its assertion — in files neither run touched. It reads as a
product bug. Two agents sharing one worktree lost real time to exactly this
before anyone suspected the harness.

`globalSetup` now takes a Postgres **session advisory lock**, keyed on
`(checkoutTag, base database name)`, before its first destructive statement,
and holds it — via the open connection — until `globalTeardown`. A second
concurrent run in the same checkout is REFUSED with a message that names the
run holding the lock and lists the ways out. `globalTeardown` releases it after
the per-worker DROPs, so the drops stay inside the protected window.

Three outcomes, three responses:

| outcome | meaning | response |
| --- | --- | --- |
| `acquired` | this run owns the pair | continue; release in teardown |
| `conflict` | another run owns it | `throw` — Jest aborts, exit 1, zero tests reported |
| `unchecked` | no reachable Postgres / unusable URL | WARN loudly and continue |

`unchecked` is its own named state on purpose. "Did not check" and "checked,
found nothing" are the same silence otherwise, and it is only safe to continue
from because it means there was no database to corrupt in the first place.

## Files

| File | Role |
| --- | --- |
| `tests/helpers/db.ts` | `testDbRunLockKey` (pure), `acquireTestDbRunLock`, `runLockConflictMessage`, `remember`/`releaseTestDbRunLock`. The module that already owns the naming scheme now also owns the lock keyed on it. |
| `tests/setup/globalSetup.ts` | Acquires before migrate / terminate / DROP / CREATE; throws on conflict; warns on `unchecked`. |
| `tests/setup/teardown.ts` | Releases last, after the per-worker DROPs. |
| `tests/integration/test-db-run-exclusivity.test.ts` | The invariant, its vacuity companions, and the wiring assertion. |

## Decisions

- **Refuse rather than rename (the alternative was a per-run discriminator in
  the database name).** A pid in the name lets both runs proceed — but only
  while teardown is reliable, and it is not: a hard-killed run (Ctrl-C, the OOM
  killer, an agent harness stopping a task) never reaches `globalTeardown`, and
  its databases outlive it. The cluster this was written against was already
  carrying **nine** such orphans, named for checkouts that no longer exist on
  the machine. A discriminator multiplies that leak by every abandoned run, and
  the cost lands later on somebody with no way to tell which orphan is live. A
  session advisory lock has the opposite property: the kernel releases it when
  the process dies. There is nothing to clean up and nothing to orphan.

- **The key is the PAIR, not either half.** Keyed on the checkout tag alone, a
  second run pointed at another base via `DATABASE_URL_TEST` would be refused —
  and that is the escape hatch the refusal message offers, so the advice would
  be a lie. Keyed on the base alone, two git worktrees would refuse each other,
  and running agents in parallel worktrees is the workflow this repo is built
  around. The pair is exactly what the database names are built from, so the
  lock is contended precisely when the names would collide.

- **The lock lives on the `postgres` database** (`adminConnectionString()`),
  because Postgres advisory locks are scoped per database and every run has to
  contend in the same one.

- **Two `int4`s, not one `bigint`.** `pg_try_advisory_lock` accepts both; the
  int4 pair keeps the key out of JS `BigInt` entirely. `pg_locks.classid` /
  `objid` are `oid` (unsigned), so the holder lookup widens both sides to
  `bigint` rather than casting a negative int4 to `oid` and relying on the wrap.

- **The other run is identified by `application_name`, not by
  `pg_stat_activity.pid`.** That column is the SERVER backend pid; printing it
  as "the other run" would send a reader to `ps` for a process that does not
  exist locally. Each run advertises itself as `inflect-jest-run:<its OS pid>`.

- **No `ALLOW_CONCURRENT_TEST_RUNS` escape hatch.** The refusal already offers a
  *correct* way to run two things at once (a second database, or a second
  worktree). An env var that says "corrupt it anyway" would be reached for by
  habit, and the failure it re-enables is the one that costs a day to diagnose.

- **Residual, unchanged and out of scope:** two runs in DIFFERENT checkouts
  still share the BASE/template database for the brief
  `pg_terminate_backend` + `CREATE ... TEMPLATE` window, and a serial
  (`--runInBand`) run in another checkout stays on that base throughout. That
  was already documented in `tests/helpers/db.ts` before this change and is not
  what the lock addresses.
