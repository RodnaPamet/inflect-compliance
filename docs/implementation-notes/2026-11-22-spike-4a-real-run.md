# 2026-11-22 — Step 4a: the owner's real run

**Commit:** _(this PR)_ `docs(agents): Step 4a real-mode figures — the faux measurements hold; Phase 4 stays parked`

The spike (`2026-11-13-spike-4a-agent-sdk.md`) measured the Agent SDK under
`lockedOptions` in faux mode and left model latency and real context growth to
the owner's `--real` run. That run is recorded here. The 2026-11-13 note is
historical and is not edited.

## Design

`npm run real -- --reps 2` in `scripts/spikes/agent-sdk`, run by the owner on
2026-11-14 in Google Cloud Shell, with a workspace-scoped Anthropic key typed at
the hidden prompt. Four real ten-turn runs, two cold and two warm, of the same
fixed profile (20 tools, 9 tool turns, then text), on `claude-sonnet-5-5`, SDK
0.3.323 (bundled Claude Code 2.1.323), Node 26.13.0, linux-x64. Raw data:
`scripts/spikes/agent-sdk/results/real-2026-11-14.json`.

| Measure | Real, Cloud Shell (median, max) | Faux, worker-shaped (2026-11-13) |
| --- | --- | --- |
| Peak RSS, `claude` subprocess tree | **256 MiB** (256) | 251 MiB (10 turns), 265 MiB (40) |
| Peak RSS, host process | 120 MiB | 144 MiB |
| Time to first assistant message, cold `query()` | **4.6 s** (4.7) | 0.8 s |
| Time to first assistant message after `startup()` | **3.0 s** (3.6) | 0.2 s |
| `startup()` itself | 0.92 s (0.94) | 0.54 s |
| Whole run, cold / warm | **20.1 / 19.7 s** | 1.7 / 1.1 s |
| Model turns / tool calls / outcome | 8 / 20 / `success`, `completed`, every run | 10 / 20 / success |
| `system/init` equal to the resolved set | every run | every run |
| Outbound hosts other than the model / side requests | 0 / 0 | 0 / 0 |
| Cost | USD 0.20 per run, USD 0.80 in all | — |

The first attempt, on 2026-11-14 with an organisation-level key, failed on its
first request: the API refused a key not scoped to a workspace
(`anthropic-workspace-id` absent). The spike sends no such header, and its
error is reported only as `success/api_error`. A workspace key ran clean. The
product's own clients send the header when `ANTHROPIC_WORKSPACE_ID` is set
(`src/lib/ai/anthropic-workspace.ts`), so this concerns the spike only.

## Decisions

- **The faux figures hold, so the recommendation stands.** The memory per run
  is what the faux run predicted (256 against 251 to 265 MiB), so the concurrency
  ceiling `floor((1536 − 460 − 256) / peak)` is still 3, with 2 as the starting
  cap if the engine were ever adopted. The new information is latency: model
  time dominates, at about 3 to 4.6 s to the first message and 20 s for a
  ten-turn run. That is the model, not the SDK; the SDK's own share is the 0.9 s
  `startup()` and about 1 s of cold init. Nothing here favours adopting the
  engine for the three needs, which the owner decided on 2026-11-13 to serve
  with Steps 2f, 2g and 5e. Phase 4 stays parked.
- **A `git` child appeared in two of the four runs.** The process sampler saw
  `git` beside `claude` in the subprocess tree (cold run 1, warm run 2). The
  run's working directory is a fresh empty temporary directory, not a
  repository, so it had nothing to read there, and no outbound connection was
  made. It is still a process the lockdown table does not list. The faux runs
  did not record process names, so whether it appears there is unknown. Should
  Phase 4 ever be revived, the lockdown must account for it (find what starts
  it, and whether an option or environment variable stops it).
- **Still open, as before:** whether a server-managed settings fetch happens
  with an API key on a direct connection (difference 2). The real run saw no
  host but the model's and no side request, but a fetch to the model's own host
  would not show as a separate host, so the run does not settle it.
- **The model ran 8 turns, not 10.** The faux script fixes ten turns; the real
  model batched its 20 tool calls into fewer turns. The SDK reports 21 turns
  (`num_turns`), counting tool results as turns.
