# 2026-09-06 — the delivery boundary between a fixture and a database

**Commits:** `321a0c18d` (#2329) · `f57ee8a83` (#2335) · `1e4385ed3` (#2336),
alongside the content PRs `#2324` `#2328` `#2333` and the freeze `#2323`.

The control-task authoring round shipped content through a conformance gate, an
actionability ratchet and 24 green CI checks into a production database that
received **none of it**. This note is about the boundary that swallowed it,
because the content is the easy half and the boundary is the part that will
happen again.

## The finding

`prisma/fixtures/internal-controls.json` held 865 authored tasks. Zero reached
any database.

The seed loop read the fixture through an `as` cast whose type had no `tasks`
field. TypeScript was satisfied — an `as` cast asserts rather than checks — so
the property was dropped silently at the type boundary. Nothing downstream
could notice: the seeder wrote the fields it knew about, and the tasks were
never in the object it was writing from.

What makes it worth a note is not the cast. It is that **every gate certifying
the content was reading the same JSON the seeder discarded.** The conformance
test parsed the fixture. The actionability ratchet parsed the fixture. Both were
correct, both were green, and both were measuring a file rather than a
consequence. A hundred more gates of that kind would have added no information.

Three further breaks sat behind it, each independently sufficient to produce an
empty catalogue, and each invisible in the same way:

| break | why nothing saw it |
| --- | --- |
| `prisma/seed.ts` is not run on production deploys | true and documented; nothing connected it to "so authored content never ships" |
| the production entrypoint was bind-mounted over by `entrypoint-fixed.sh` | the repo's entrypoint ran no seeders because it wasn't the entrypoint |
| `main().catch(console.error)` | a seed that threw exited **0**; the deploy reported success |

And once the seeders did run, two more: `applyCatalogFile` upserted a framework
on `key_version` against production rows whose `version` is `null`, so the
upsert returned null on every deploy; and requirement links were created only
for *new* templates, existing ones taking a `continue`, so a framework that
already existed never gained its links.

## The shape

Every one of these is the same sentence: **an absence read as a success.**

- A cast that cannot be wrong, because it asserts instead of checking.
- A gate that reads the fixture, on the fixture's side of the boundary.
- A seed that cannot fail, because its catch swallows the exit code.
- An upsert that returns null into code that doesn't look.
- A log line in a container nobody reads.

The fixes therefore all take one form: **assert the denominator, not just the
findings.** A check that reports "no problems" must separately prove it looked
at something, or "nothing found" and "nothing examined" are the same output.

## What was built

| file | role |
| --- | --- |
| `scripts/seed-control-template-tasks.ts` | the delivery path for authored tasks; wired into `scripts/entrypoint.sh` |
| `scripts/seed-framework-catalogs.ts` | applies whole `CatalogFile` fixtures — framework, requirements, templates, links, pack — for frameworks prod may never have seen; runs **before** the task seeder, because tasks can only attach to templates that exist |
| `scripts/catalog-check.ts` | one command answering "does this database hold the catalogue the repo declares?" |
| `prisma/fixture-io.ts` | `fixtureArray` / `fixtureObject` — parse at the read, so a shape mismatch is an error rather than a silent drop |
| `prisma/control-template-seed.ts` | the parsing loader; replaces the cast |
| `tests/integration/control-template-task-delivery.test.ts` | crosses the boundary: proves rows land in a real DB |
| `tests/integration/framework-catalog-delivery.test.ts` | the same for whole catalogues |
| `tests/guardrails/authored-tasks-are-delivered.test.ts` | is a fixture with authored tasks WIRED to anything at all? |
| `tests/guardrails/fixture-reads-are-checked.test.ts` | no fixture read may go through a cast |
| `tests/guardrails/seeders-fail-loudly.test.ts` | a seeder's failure must reach the exit code |

## Decisions

- **`catalog-check` derives its expectation from the fixtures at run time
  rather than from a committed manifest.** A manifest is derived data stored
  beside its own source, and this repo has been bitten by that shape twice —
  most memorably the `counts` header in `doc-classification.json`, where two
  branches each bumping `494 → 495` merge *cleanly*, so both PRs are green and
  main is wrong by one with no suspicious diff. A run-time expectation cannot go
  stale and has no second number to keep in step.

- **Extra rows report; missing rows fail.** A database holding more than the
  repo declares is usually a retired fixture or a manual operator action, and
  failing on it would train people to ignore the command. Missing rows are the
  condition that has actually cost something.

- **The guardrails scan the seeder, not the database.** A guardrail cannot reach
  a DB — that belongs in `tests/integration`, and it is there. The cheap
  companion answers a question the expensive one structurally cannot: a fixture
  nobody references is invisible to a delivery test that never loads it.

- **`fixture-reads-are-checked` pins its own denominator (`scanned`), not just
  its findings.** Without that, a scan that stops matching reports a clean bar
  for the subset it still sees — which is the original defect one level up.

- **Seeders stay non-fatal in the entrypoint but now exit non-zero themselves.**
  A seed hiccup must never block the app from starting; that judgement is
  unchanged. What changed is that the failure is now *observable* rather than
  laundered into a success by the process exit code.

## Verification, and a caveat about it

Production went from zero authored control tasks to `catalog-check` reporting
every declared template, framework and pack present.

The caveat belongs in the record. For most of the day, my `psql`-based teardown
between verification runs **did not exist on the box** — `psql: command not
found` — and the failure was silent, so every "fresh" database was carrying the
previous run's rows. Two intermediate counts I reported (522/55) were inflated;
the true figures were 512/61. The completion claims survived re-verification,
but they survived it by luck rather than by method: a teardown that fails
silently is the same defect this whole note is about, committed by the person
writing it.
