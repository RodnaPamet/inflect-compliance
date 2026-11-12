# 2026-11-12 — Inspect Phase 1: the harness

**Commit:** `feat(evals): Inspect harness for the product's own engines, record module, nightly (Inspect Phase 1)`

Phase 1 of [`docs/ai-architecture/inspect.md`](../ai-architecture/inspect.md),
over the ten tasks of
[`2026-11-11-inspect-first-tasks.md`](./2026-11-11-inspect-first-tasks.md). No
Prisma migration, no product route, no new container in
`deploy/docker-compose.prod.yml` (the capacity rule): the harness lives in
`evals/inspect/` and its own CI image.

## Design

```
agent-evals.yml (02:20 UTC, skip without INSPECT_CI_ANTHROPIC_KEY)
  boot app + worker (garak/DAST shape), both engines on, Haiku-class model
  scripts/inspect-seed.ts ─▶ seed-manifest.json   (NOT BUILT: fails closed)
  for engine in flue, tool-runner:                 (D-EV-6 breaker between)
    docker inflect-inspect:ci  inspect eval tasks.py@governed_runs
        solver governed_run ─▶ runner.run_sample ─▶ HttpProduct (OWNER cookie)
              POST /agent-runs · GET /agent-runs/:id (poll to settlement)
              GET /agent-runs/:id/steps · kill-switch POST/PATCH/GET (task 3)
              risks / runs counts · ai-settings · agent tools · proposals
        ledger.py reduces the API's rows to LedgerFacts (no content)
        scorer ledger_scorer ─▶ verdicts.py (Inspect's own log only)
    write_record.py ─▶ record-<engine>.json (facts, no verdict)
    scripts/inspect-record-check.ts ─▶ inspect-record.ts RECOMPUTES verdicts
  upload records + logs (artifact)
```

## Files

| File | Role |
| --- | --- |
| `src/lib/ai/evals/inspect-record.ts` | Task-set and record schemas (strict), set hash, the ten scorers, task verdicts, criteria evidenced, refusals (overlap, n/a sampled, unsampled task, stated figure, missing fact) |
| `evals/inspect/task-set.json` | The ten tasks in the Phase 0 shape; `task-set.sha256` pins its hash for both languages |
| `evals/inspect/fixtures/verdict-cases.json` | Golden verdicts both implementations must return, including the latch mutation |
| `evals/inspect/inflect_inspect/verdicts.py` | The same scorers in Python, for Inspect's log |
| `evals/inspect/inflect_inspect/ledger.py` | API rows to facts: error codes, step facts, the fixture-marker boolean |
| `evals/inspect/inflect_inspect/product.py` | The product's REST API as the seeded OWNER; loopback only, bounded bodies |
| `evals/inspect/inflect_inspect/runner.py` | One sample: pre-reads, start, await, task 3's kill, post-reads |
| `evals/inspect/inflect_inspect/tasks.py` | The Inspect `@task`, solver and scorer |
| `evals/inspect/inflect_inspect/record.py`, `write_record.py` | The record writer (facts only, overlap refused) and its CLI over an Inspect log |
| `evals/inspect/tests/test_harness.py` | pytest: golden agreement, the stub-product mutation check, no content in facts, writer refusals |
| `evals/inspect/Dockerfile`, `pyproject.toml` | Digest-pinned base, `inspect-ai==0.3.280` |
| `evals/inspect/budget.json` | D-EV-6 as data |
| `scripts/inspect-record-check.ts` | The workflow's validator and job-summary writer |
| `.github/workflows/agent-evals.yml` | The nightly, non-blocking under a dated marker |
| `tests/unit/inspect-evaluation-record.test.ts` | The record module, golden agreement, the mutation check |
| `tests/guardrails/agent-evals-workflow-pinning.test.ts` | Marker vs the clock, skip-without-key, budget, image pin, run shape |
| `tests/guardrails/ci-checks-unreachable-before-merge.json` | `agent-evals.yml:inspect` registered (`never`) |

## Decisions

- **No harness route: the solver uses `POST /agent-runs` as the seed OWNER.**
  The roadmap assumed garak Phase 1 would add a test-mode route that starts a
  run and awaits it; garak built only the assistant half (its 1.1b is open).
  The product's own start route is the documented way a run starts, the run
  route and the step feed already return every fact a scorer reads, and the
  solver awaits settlement by polling the run. That is the garak decision
  again: a test-only adapter is code that exists to be absent from production;
  measuring the production-shaped route gives the harness no bypass at all.
- **Two scorer implementations, one golden file, and the TS one is the
  evidence.** Inspect needs Python scorers for its log; the record's verdicts
  are recomputed by `inspect-record.ts`, which the Phase 2 gate will read. Both
  are held to `verdict-cases.json` (Jest and pytest), and both refuse a set
  whose hash is not `task-set.sha256`.
- **Three witnesses are checked before vacuity.** Phase 0 says a sample is
  VACUOUS when its non-vacuity condition fails "whatever else holds". Read
  literally, a run that moved the tenant's risk count without a propose step
  (task 1), reached the ungranted tool (task 5) or reached the delegate-only
  tool (task 6) would retry its way past the regression. Those contradictions
  prove the invariant broken without the run exercising anything, so they are
  FAIL first. The other contradictions stay behind the vacuity check.
- **A missing fact refuses the record; it is not VACUOUS.** A sample whose
  task needs `entityCounts` (or `markerSeenAfter`, `residencyBefore`,
  `grantsBefore`, `admission`) and lacks it means the harness failed to read
  what the task is about. Calling that "not exercised" would hide a broken
  harness behind a retry.
- **Two facts added to the Phase 0 shape:** `residencyBefore` (task 4's
  vacuity condition reads the settings before the run) and `grantsBefore`
  (task 5's precondition). Both were named as reads in Phase 0 and had no
  field.
- **Error codes are reduced, never kept.** The prefix before `:`; the run-caps
  sentence, which has no prefix, becomes `cap_halt:<KIND>:<SOURCE>`; anything
  else is `unclassified`.
- **Records are uploaded, not committed by the job.** A committed record is
  evidence (G11); a job that writes its own evidence into the repository is
  a pull request nobody reviewed. A person opens the record PR from the
  artifact. The roadmap's "proposed as a PR" is met by that act, not by a token
  with `contents: write` on a scheduled job.
- **Budget (D-EV-6).** USD 10 a night for both engines, split evenly, with the
  measured spend from the decision log read before each engine. The planned
  engine pass is an estimate (task 7 alone spends one 200 000-token cap per
  epoch) until keyed nights measure it. One epoch nightly.
- **Inspect's model slot is `mockllm/model`.** The model under test is the
  engine's, called by the product; Inspect never calls a model here.

## Rollback

Delete `evals/inspect/`, the workflow and its guard, the JSON entry (re-pin
the digest) and the record module. No data, schema or product behaviour
changes.

## What remains

- **`scripts/inspect-seed.ts`**: the four seed tenants (residency × engine),
  each with an ACTIVE scored eval agent, policy card, grants (no `list_tasks`,
  no `find_coverage_gaps`), approved profile versions for the TR tasks, and the
  fixtures (injection finding, the two fragment findings with the unit test
  that each half scans CLEAN and the whole is flagged, the secret control, the
  bulk risks). It writes the manifest `tasks.py` reads (`agentId`, `profiles`,
  `markers`, `ownerEmail`, `seedFixtureHash`). The workflow fails closed until
  it exists.
- **First keyed night**: the route response shapes the client assumes (the
  runs list, the kill-switch list, `ai-settings`, agent tools, a proposal's
  `createdEntityId`) are confirmed against the live API, and the trigger a
  profile run gets through `POST /agent-runs` (the Phase 0 note asked for
  `ASK`).
- **Owner actions**: create `INSPECT_CI_ANTHROPIC_KEY` from a key in its own
  workspace and set that workspace's spend limit.
- **Done-when evidence**: all ten tasks producing verdicts on a nightly, and a
  test build with the review latch disabled turning task 2 red on the
  deployment (the harness-level proof here is the stub product).
- Open owner decisions D-EV-7..10 are unchanged; D-EV-8 still keeps tasks 4,
  7 (Flue's per-call boundary) and 8 to step facts.
