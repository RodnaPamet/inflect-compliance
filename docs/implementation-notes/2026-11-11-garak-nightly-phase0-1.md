# 2026-11-11 — garak nightly LLM red-team (roadmap Phases 0 and 1)

**Commit:** `feat(evals): garak nightly red-team of the assistant, non-blocking (garak Phases 0-1)`

## Design

```
schedule 01:15 UTC ─▶ garak.yml (one job)
  key check ── GARAK_CI_ANTHROPIC_KEY absent ─▶ notice, every later step skipped
  boot (dast.yml shape) + seed, ANTHROPIC_API_KEY only on the app process
  docker build .garak (python:3.12-slim@sha256, garak==0.17.1)
  verify probe names against `garak --list_probes`
  for role in owner, editor, reader:              (sequential: one budget)
      measured breaker (.garak/spend.mjs over AiDecisionLog)
      NextAuth login ─▶ session cookie
      target-proxy.mjs (127.0.0.1:3107) ── cookie, wire cap ─▶ /api/t/acme-corp/assistant/ask
      garak container (host network) ─▶ proxy only
  summarise.mjs ─▶ inflect-garak-night/1 record per role + job summary
  upload reports/records; open or update one findings issue on any hit
```

The target is the assistant's existing non-streaming route. It runs
`askAssistant`, the same governed order as the stream (feature gate, rate
limit, input guard, model and tool loop, egress guard, decision log), so the
roadmap's test-only adapter is unnecessary for the assistant. The agent-run
half of that adapter (start a workflow, await it) is not built.

## Files

| File | Role |
| --- | --- |
| `.garak/config.yaml` | garak run config: rest generator at the proxy, nine probe classes, 5 prompts each, 1 generation, sequential |
| `.garak/budget.json` | D-EV-1 as data: USD 5 cap, Haiku pin and prices, planned turn, roles, per-role and per-night request caps |
| `.garak/allowlist.tsv` | empty accepted-finding list; header carries the IGNORE-at-every-severity warning |
| `.garak/Dockerfile` | the scanner image; base pinned by digest, garak by exact version |
| `.garak/target-proxy.mjs` | wire cap, cookie holder, guard-403-to-refusal translation, counts-only ledger |
| `.garak/summarise.mjs` | report + ledger to the night record and markdown |
| `.garak/spend.mjs` | measured spend from the decision log; may another role start |
| `.github/workflows/garak.yml` | the nightly job |
| `tests/guardrails/garak-workflow-pinning.test.ts` | dated marker vs the clock, skip-without-key, budget arithmetic, image pin, reach |
| `tests/unit/garak-wire-cap-and-record.test.ts` | the three scripts through their CLIs |
| `tests/guardrails/ci-checks-unreachable-before-merge.json` | `garak.yml:garak` registered (`never`) |
| `docs/ai-architecture/garak.md` | Phase 0 and 1 sub-phases, probe table, record shape, thresholds draft |

## Decisions

- **The existing `/assistant/ask` over a new harness route.** A test-only
  adapter is code that exists to be absent from production and needs a guard to
  prove it; the product already exposes the non-streaming turn, guards on. A
  probe of the production-shaped route is the stronger measurement.
- **A proxy between garak and the app.** garak echoes its generator config into
  its report, so a session cookie in the config would be uploaded as an
  artifact. The proxy also makes the request cap hold whatever garak's config
  says (`soft_probe_prompt_cap` is applied by the probes that sample, not by
  garak globally) and turns a guard 403 into a scored "no hit" instead of a lost
  attempt. A 429 is not charged: it is the rate limiter's pre-flight, no model
  call was made.
- **Roles sequential, not a matrix.** DAST's roles are independent scans on
  independent runners; here they share one nightly budget, and the breaker must
  see what the previous role spent.
- **The budget is four layers and the doc says which one is hard.** Request
  counts (garak, proxy, the product's daily AI quota) are enforced; USD is
  enforced only at the planned turn cost. The product's provable worst case per
  turn (6 x 8,192 output tokens) is far above the plan, and an egress-refused
  turn writes no decision row, so the measured breaker undercounts it and
  charges it at the planned cost. The invoice-level stop is the spend limit on
  the dedicated key's workspace, which is an owner action, not code.
- **The product's AI quota, not `agentMonthlyTokenBudget`.** #3833 decided the
  assistant is not metered against the agent budget; the per-tenant daily
  quota is its pre-flight cap, and the job sets it to the night's request cap.
- **Auditor left out of the role list.** The assistant's surface for an
  auditor is the reader's; a fourth role would add a third more spend for no
  new surface.
- **Not in the coverage partition.** The job runs no Jest.
- **Sub-processor note.** The CI key sends garak's probe text and seed CI data
  to Anthropic, no customer content. The Anthropic row of
  `docs/sub-processors.md` is shared by several roadmaps, so the one-line note
  that CI probe text goes there is left for the coordinator rather than edited
  from this branch.

## What remains

- Owner actions: create `GARAK_CI_ANTHROPIC_KEY` from a key in its own
  workspace; set that workspace's spend limit.
- 0.4 baseline (needs the key): hit rates per family, and the measured p99
  turn replacing `plannedTurn`.
- 1.1b the agent-run adapter route (test-mode only, with its route-manifest
  guard), which needs the worker booted in the job.
- 1.5 done-when evidence: a green scheduled run and a deliberately re-enabled
  probe visible in the report.
