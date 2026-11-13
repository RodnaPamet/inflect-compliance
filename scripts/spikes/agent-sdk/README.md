# Agent SDK spike (Step 4a)

The throwaway harness Step 4a of `docs/claude-agent-sdk-design.md` asks for:
one fixed profile with twenty tools, run through the design's `lockedOptions`,
measured, and its lockdown proved. Findings and the recommendation are in
`docs/implementation-notes/2026-11-13-spike-4a-agent-sdk.md`.

This folder is self-contained and outside the application's build: its own
`package.json` pins `@anthropic-ai/claude-agent-sdk`, the root `tsconfig.json`
excludes `scripts/`, and nothing under `src/` imports the SDK. Root ESLint
does lint these files.

## Install

```sh
cd scripts/spikes/agent-sdk
npm install
npm run typecheck
```

## Faux mode (no key, runs anywhere)

`--faux` points the SDK at a local faux Messages API (`faux-server.ts`) that
answers with scripted turns, and hands the subprocess a refusing proxy
(`egress-logger.ts`) that records any other host it tries to reach.

```sh
npm run faux -- --reps 5            # ten turns, twenty tool calls; cold and warm
npm run faux -- --reps 3 --turns 40 # the same, forty turns, to see RSS grow
npm test                            # the lockdown proof (node:test, not the root Jest)
SPIKE_MUTATE=settingSources npm test   # must FAIL: lockedOptions without a row
npm run needs                       # deferral and compaction under lockedOptions
npx tsx concurrency-probe.ts 1 3 5  # N runs at once in one process
```

Faux-mode time to first token is process overhead, not model latency.

## Real mode (the owner runs this)

```sh
npm run real -- --reps 2
```

It asks for an Anthropic API key at a hidden prompt. The key is never an
argument, never read from the shell's environment, never printed or written;
it reaches the subprocess only through `lockedOptions`' built `env`. Each
repetition is two real ten-turn runs (cold and warm) capped at USD 1 each by
`maxBudgetUsd`. The result is written to `results/real-<date>.json`; the
summary is printed. `--model <id>` overrides the default
`claude-sonnet-5-5` (the Tool Runner's balanced tier).

## Run it in a container shaped like the worker

The worker is `node:24-alpine` with `mem_limit: 1536m` and `cpus: 1.0`
(`deploy/docker-compose.prod.yml`). On Alpine npm installs the musl binary:

```sh
npm install --os=linux --libc=musl --cpu=x64   # from a copy of this folder
docker run --rm --memory 1536m --memory-swap 1536m --cpus 1 \
  -v "$PWD":/spike -w /spike node:24-alpine \
  node node_modules/tsx/dist/cli.mjs run-spike.ts --faux --reps 5
```

`node_modules`, the lock file and nothing else are ignored by git.
