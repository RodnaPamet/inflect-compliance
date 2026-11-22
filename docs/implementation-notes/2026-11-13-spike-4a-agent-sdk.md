# 2026-11-13 — Step 4a: the Agent SDK spike

**Commit:** `docs(agents): Step 4a Agent SDK spike — trigger, faux-mode measurements, lockdown proof (#4159)`

Step 4a of `docs/claude-agent-sdk-design.md`: measure what the Agent SDK costs
in this deployment and prove the lockdown, before any product code depends on
it. Nothing here merges into `src/`. The harness is `scripts/spikes/agent-sdk/`.

**The trigger.** On 2026-11-13 the owner recorded that profiles need three
things the Tool Runner engine cannot give them today: (1) deferring a tool call
to a person mid-run through an SDK hook, (2) context compaction for long runs,
(3) a file or code workspace. It is recorded under decision 1 of the design.
Need (3) overlaps Managed Agents (Step 5e), so the recommendation below names
an engine per need.

**What could not run here.** This environment has no Anthropic API key and
cannot be given one. Every number below is from **faux mode**: the SDK pointed
at a local faux Messages API that answers scripted turns in under a
millisecond. Faux time to first token is **process overhead, not model
latency**. The `--real` mode is built for the owner to run (command at the
end), and the numbers that wait on it are marked.

## Design

```
run-spike.ts --faux|--real        one fixed profile, cold (query) and warm (startup → query) × reps
  └ locked-options.ts             lockedOptions(run): the design's table + the additions below
      └ query() ── stdio ── claude subprocess ── HTTP ──► faux-server.ts (scripted /v1/messages)
                                                └─ any other host ─► egress-logger.ts (records, refuses)
  └ measure.ts                    RSS of the subprocess tree + host, sampled every 50 ms; package sizes
lockdown.spike.ts (npm test)      hostile HOME/cwd/config/env → lockdown-check.ts lists every leak
needs-probe.ts                    deferral and compaction under lockedOptions (needs 1 and 2)
concurrency-probe.ts              N runs at once in one process
```

The lockdown check reads three witnesses, because `system/init` is the CLI
describing itself: the init message, every request the faux API received (what
actually reached the model), and every outbound connection the subprocess
tried. It also asks the run's own gate to refuse one tool and to throw for
another, and requires both to come back denied.

## Measurements

SDK `@anthropic-ai/claude-agent-sdk` **0.3.323** (bundled Claude Code
2.1.323), all on **2026-11-13**, **faux mode**. Profile: 20 tools, a ten-turn
script (9 tool turns, 20 calls, then text), each tool result ~4 KB. Five
repetitions, each a cold and a warm run; medians, with the max in brackets.
Raw data: `scripts/spikes/agent-sdk/results/*.json`.

| Measure | Worker-shaped container¹ | Dev host² | Needs `--real`? |
| --- | --- | --- | --- |
| Peak RSS, `claude` subprocess, 10 turns | **251 MiB** | 257 MiB | yes: real answers, thinking and longer contexts |
| Peak RSS, `claude` subprocess, 40 turns | 265 MiB | 281 MiB | yes |
| Peak RSS, host process (tsx + SDK + faux server) | 144 MiB | 162 MiB | no |
| Host cost of importing the SDK, once per process | — | +35 MiB | no |
| Time to first assistant message, cold `query()` | **809 ms** (845) | 493 ms (554) | **yes**: faux is overhead only |
| Time to first assistant message after `startup()` | **191 ms** (228) | 108 ms (134) | **yes** |
| `startup()` itself | 543 ms (682) | 376 ms (412) | no |
| Time to the first API request, cold / warm | 761 / 181 ms | 467 / 101 ms | no |
| Whole ten-turn run, cold / warm | 1.67 / 1.08 s | 0.87 / 0.50 s | yes |
| Model turns / tool calls / outcome | 10 / 20 / success, every run | same | — |
| `system/init` equal to the resolved set | every run | every run | the real run checks it too |
| Outbound connections other than the model / side requests | 0 / 0 | 0 / 0 | — |

¹ `node:24-alpine` (the worker's base image), `--memory 1536m --memory-swap
1536m --cpus 1` (the worker's `mem_limit` and `cpus`), musl binary, Node
24.22.3. ² Ubuntu 24.04, 4 vCPU Xeon 2.1 GHz, no limits, glibc binary, Node 22.22.0.

**Concurrency in the worker-shaped container** (`concurrency-probe.ts`, N
ten-turn runs at once in one process, peaks in MiB):

| N | subprocesses | subprocesses + host | wall | outcome |
| --- | --- | --- | --- | --- |
| 1 | 238 | 359 | 2.1 s | all completed |
| 2 | 436 | 560 | 3.8 s | all completed |
| 3 | 639 | 777 | 5.4 s | all completed |
| 4 | 846 | 987 | 7.5 s | all completed |
| 5 | 1026 | 1177 | 10.2 s | all completed |
| 6 | 1236 | 1414 | 12.3 s | all completed |

About 200 MiB per extra run, and wall time grows linearly: on one CPU the
subprocesses' own work is the bottleneck (a lone cold ten-turn run takes 1.7 s
of wall time on that core), before any model latency.

**Image size.** The SDK package is 5.1 MiB; the native binary is a separate
optional package per platform: **333 MiB** for `linux-x64-musl` (what the
Alpine image installs), 346 MiB for `linux-x64`. Peers: `@anthropic-ai/sdk`
(already a root dependency) and `@modelcontextprotocol/sdk` 1.32.2 (4.3 MiB, a
new dependency). The binary grows fast: the registry's unpacked size for
`linux-x64-musl` was 261.6 MB at 0.3.301 (2026-10-15) and 349.2 MB at
0.3.323 (2026-11-12), +33 % in four weeks, with a release most days.

## The lockdown proof

`npm test` (node:test, under the spike's own package, never the root Jest)
builds a hostile host and runs the profile through `lockedOptions`:

- **planted**: a project `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`,
  `.claude/settings.json` (wider permissions, a model, `bypassPermissions`, a
  `SessionStart` hook that writes a file), `settings.local.json`, project
  skills, agents and commands, `.mcp.json`; a user `settings.json` (permissions,
  model, hook), user `CLAUDE.md`, skills, agents, commands, `.claude.json` with
  user and per-project MCP servers, and the project's auto-memory file; a
  `CLAUDE.md` one directory above the project; and the host process's own
  environment poisoned (`HOME`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_MODEL`,
  `CLAUDE_CODE_PLUGIN_DIRS` naming a hostile plugin).
- **asserted**: `system/init` names exactly the twenty tools plus `Skill`; one
  MCP server, `inflect`, `sdk`; no agents; the requested model; `dontAsk`; the
  default output style; analytics off; plugins and skills equal to the pinned
  built-in set plus ours; no host name anywhere in init; every request carries
  exactly the resolved tools, lists only our skill, and carries no planted
  marker; no side request; no outbound connection; no hook ran; no transcript
  written; and the tool the gate refused, and the tool whose gate threw, both
  denied. A second case runs per-run directories under the hostile parent with
  no skills and asserts init names exactly the twenty tools.
- **result**: 16 of 16 pass, on the dev host and in the worker-shaped container.

**It fails when a row goes.** `SPIKE_MUTATE=settingSources npm test` exits 1;
both lockdown cases fail with, among others, `init.agents
["hostile-project-agent","hostile-user-agent"]`, `init.output_style
hostile-style`, `host content reached the model: HOSTILE_USER_CLAUDE_MD,
HOSTILE_PARENT_CLAUDE_MD, HOSTILE_PROJECT_CLAUDE_MD,
HOSTILE_PROJECT_LOCAL_CLAUDE_MD` and `a host hook ran (…/PROJECT_HOOK_RAN)`.
`init.tools` alone did NOT change: the tool list is not a sufficient witness,
which is why the check reads all three. The suite also carries one case per
row that must be caught, and each is: `settingSources`, `permissionMode`
(becomes `default`), `tools`, `allowedTools` (the allowed tool is denied),
`hooks`, `hooks.onFailure`, `skills`, `persistSession`, the whole built `env`
(the hostile plugin and six built-in agents load), and the env variables
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`
(the planted memory reaches the model), `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`,
`ENABLE_TOOL_SEARCH` and `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`.

**Rows the faux host cannot exercise**, kept as belts: `strictMcpConfig`
(claude.ai connectors load only with a claude.ai login, which the worker never
has; the planted `.claude.json` servers stayed out with or without it under
`settingSources: []`); `disallowedTools` and `CLAUDE_CODE_FORK_SUBAGENT`
(`tools: []` already removes `Agent` and every built-in); `HOME` and
`CLAUDE_CONFIG_DIR` (redundant with each other when the planted config dir is
`HOME/.claude`). **Not planted**: managed policy, endpoint or server-managed;
see difference 2.

## Which skill path works under `settingSources: []`

| Where the `SKILL.md` was written | Discovered? | Invoked through `Skill`? |
| --- | --- | --- |
| `<cwd>/.claude/skills/<name>/` (project source) | no | `Unknown skill` |
| `$CLAUDE_CONFIG_DIR/skills/<name>/` (user source) | no | `Unknown skill` |
| a local plugin, `plugins: [{ type: 'local', path, skipMcpDiscovery: true }]` | **yes**, as `inflect-skills:<name>` | **yes**: the body reached the model |

**The plugin path works**, so the `activate_skill` fallback is not needed. Two
conditions come with it. The `skills` option must name the mounted skills:
without it the CLI's bundled skills (sixteen of them) are listed to the model
and invocable (`Launching skill: dataviz`); with it an unlisted skill is
refused (`not in this session's skills allowlist`). And
`CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` takes the bundled set from sixteen to two
(`doctor`, `plugin-authoring`, which come from built-in plugins), which the
lockdown check pins.

## What lockedOptions needed beyond the design's table

Each was found by a run, and each is now a row the lockdown test requires.

| Addition | Without it (observed) |
| --- | --- |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | a session-title request **carrying the user's prompt** goes to the model endpoint, outside the run's ledger; and the subprocess calls `api.anthropic.com` even with `ANTHROPIC_BASE_URL` pointed elsewhere: `/api/eval/sdk-…`, `/api/claude_cli/bootstrap`, `/api/claude_code_penguin_mode` and three `/api/event_logging/v2/batch` posts (446 events, ~870 KB for one ten-turn run; session id, device id and `apiBaseUrlHost`; no prompt, tool name or tool result found by marker search) |
| `skills: [names]` | every bundled skill listed to the model and invocable |
| `plugins: [{ type: 'local', path, skipMcpDiscovery: true }]` | no mounted skill loads (see above) |
| `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` | sixteen bundled skills in init |
| `ENABLE_TOOL_SEARCH=false` | `alwaysLoad: true` is not enough: the request carries a 21st tool, `DeferredToolPlaceholder` ("Reserved placeholder that keeps deferred tool loading active; never call this tool") |
| `onFailure: 'block'` on the catch-all hook | **a hook that throws lets the call run** (default `continue`): a failed kill-switch read would be fail-open |
| a hook `timeout` (30 s here) | the PreToolUse default is 600 s |
| `HOME` in the built env | a child with no `HOME` resolves the worker's real home from passwd |

## Differences between the live documentation and the design

The pages the design cites were re-read on 2026-11-13 (fetched as Markdown
from `code.claude.com/docs/en/agent-sdk/*`, the sandboxing and CLI hooks pages,
and the TypeScript SDK CHANGELOG through 0.3.323). Where a page and an
observation disagree, both are given.

1. **Skills have their own option and a plugin path.** The design's table has
   only `tools: ['Skill']`. The docs add `skills: string[] | 'all'` ("When
   `skills` is set, the SDK adds the Skill tool to `allowedTools`
   automatically"; passing `'Skill'` in `allowedTools` is deprecated) and name
   the `plugins` option as the way to load skills from a path when
   `settingSources` is set. The design's "the plugins page was not verified" is
   now verified, by the docs and by the run.
2. **Server-managed settings reach an API key.** The design says they are
   fetched "for an organisation credential". The docs: delivery needs a direct
   connection to `api.anthropic.com` and one of several credentials, including
   "a directly configured API key"; the session gets the managed settings of
   the Console organisation that owns the key; "you can't disable them from the
   SDK"; a non-default `ANTHROPIC_BASE_URL` skips the fetch. So whoever owns the
   worker's Console organisation can change the engine's settings at Anthropic.
   Faux mode cannot observe this (its base URL is not the default). Open for
   the owner and for 4b.
3. **More off switches for claude.ai connectors.** Besides `strictMcpConfig`,
   `disableClaudeAiConnectors: true` in settings or
   `ENABLE_CLAUDEAI_MCP_SERVERS=false` in env; `mcpServers: {}` does not
   suppress them.
4. **Auto memory** can also be turned off by `autoMemoryEnabled: false` in
   settings; the agent writes memories only through `Write`/`Edit`, which
   `tools: []` removes.
5. **The permission order has two new parts.** A plugin's *mod* "can still
   approve some such calls" in `dontAsk`, and an SDK MCP server's tools can
   carry `permission_policy: 'always_deny' | 'always_ask'` (0.3.301), applied
   at the deny-rule step. Only built-in plugins and Inflect's skill plugin load
   under lockedOptions; 4b should assert no mod is present.
6. **A hook that fails does not block by default.** `onFailure: 'block'`
   (0.3.317) is opt-in; the design's "hooks run first and their deny cannot be
   overridden" holds for a deny, not for a throw. A timed-out PreToolUse does
   block (as the design says), after a default of 600 s.
7. **Defer.** The design lists `defer` among the hook outcomes. The docs add
   that the run must be resumed with `--resume <session-id>`, which needs the
   transcript: a session store or `persistSession: true`. The CLI hooks page
   also says defer is honoured "only when Claude makes a single tool call in
   the turn" and otherwise "the tool proceeds through the normal permission
   flow", which under lockedOptions would ALLOW it. Observed on 2.1.323, the
   opposite: in a turn with two calls the deferred one did not run and the
   other did. Treat the page as the contract and test each upgrade.
8. **Tool search** is on by default and defers SDK MCP tools; `alwaysLoad`
   keeps their schemas in the prompt, but a placeholder tool remained until
   `ENABLE_TOOL_SEARCH=false` (observed).
9. **`settingSources: []` leaked before 0.3.314.** The CHANGELOG for 0.3.314:
   "Fixed a settings file left out of `settingSources` still supplying some
   settings, such as auto mode rules and saved permission consents". Step 3H's
   proving run pinned 0.3.301, which predates the fix; any adoption pins 0.3.314
   or later.
10. **`permissionMode`.** As the design says, 0.3.302 changed the omitted mode;
    observed under lockedOptions without it: `default`.
11. **Resources.** The hosting page now adds "The 1 GiB starting point … is a
    floor, not the ceiling" and "Measure the per-session ceiling … recording peak
    RSS". The measured subprocess peak is about a quarter of that floor in faux
    mode.
12. **Unchanged and confirmed**: the subprocess model; `env` replacing the
    child environment; `tools: []`; the deny-rule and `dontAsk` semantics; the
    sandbox covering Bash only; cost figures being client-side estimates; no
    programmatic skill registration.

**Observed behaviours the design does not mention**, which 4b must build for:

- **One SDK message per content block.** A model turn with text and two tool
  calls arrives as three `assistant` messages sharing one `message.id`. The
  design's "one `MODEL_CALL` step per `assistant` message" would write three;
  group by `message.id`.
- **`num_turns` is not the number of model calls**: 21 for ten calls; with
  `maxTurns: 5` the run stopped after five calls and reported 6.
- **The iterator throws after an error result** (`Claude Code returned an
  error result: Reached maximum number of turns (5)`), having already yielded
  the result message.
- **The system prompt is not only ours.** The CLI prepends a billing-header
  block and "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  and the first user message carries reminders the options do not remove: the
  working directory, platform, shell, the **host's OS and kernel version**, the
  model's name, a "USD budget" line from `maxBudgetUsd` and the date
  (`verbatimPrompts` and `CLAUDE_CODE_DISABLE_ATTACHMENTS` did not remove
  them). Requests also carry `output_config.effort: "medium"` unless `effort`
  is set.
- **A resumed deferral first reports `tool_deferred_unavailable`**, while the
  in-process server reconnects, then runs the held call and completes. A driver
  that settles on the first `result` would record a failure.

## The three needs

**(1) Deferring a call to a person, mid-run.** Works in faux mode
(`npm run needs`): the hook returns `defer`, the run ends with
`terminal_reason: 'tool_deferred'` and `deferred_tool_use`, and a resumed query
re-asks the hook, which now allows it; the call runs and the run completes.
With `persistSession: false`, which the design's table and global rule 6 set,
the resume fails: `No conversation found with session ID`. So deferral needs a
transcript that outlives the subprocess: on the worker's disk
(`persistSession: true`, lost with the container) or in a `SessionStore` that
Inflect implements over its own database, which rule 6's words ("no session
store") forbid and its intent (nothing stored at Anthropic) allows. The
transcript holds tool results, so it is tenant data and an encryption and
retention decision either way.

**(2) Compaction.** Auto-compaction fired inside a locked run with
`persistSession: false` once `CLAUDE_CODE_AUTO_COMPACT_WINDOW=50000` made the
window small enough; `PreCompact`/`PostCompact` hooks saw each one, and context
went from about 191,000 tokens to about 1,600. At the default window it did not
fire at 190,000 reported tokens. No separate summary request (one without the
profile's tools) reached the faux API, and each compaction took under 70 ms.
Whether a real summary preserves what a run needs is a `--real` question.

**(3) A workspace.** Not probed. Under lockedOptions the engine has no file or
shell tool by design, and the SDK's own sandbox "covers shell commands only.
Claude's file tools, MCP servers, and hooks run outside it", so turning those
tools on in the worker would give tenant agents the worker's filesystem.

## Recommendation on decision 1

Provisional until the owner's `--real` run; the owner decides.

| Need | Engine | Why |
| --- | --- | --- |
| (1) defer a call to a person | **an extension of the Tool Runner** | The SDK supplies the hook, but the durable part, a transcript that outlives the process, is Inflect's to build in either engine (a `SessionStore`, or the Tool Runner's message array saved on the run). In the Tool Runner that is Inflect's own loop stopping at the funnel and resuming from the saved messages, with no subprocess, no spurious first result and no fail-open default to switch off. |
| (2) compaction | **an extension of the Tool Runner** | The Tool Runner already has `compactBeforeNextTurn()` and resumes compaction stops (`docs/claude-tool-runner-design.md`); it is off there by choice, not by inability. Turning it on is a smaller change than a second engine. |
| (3) a workspace | **Managed Agents (Step 5e)** | A workspace is a container, which the Agent SDK in the worker does not give safely, and which Managed Agents provides by design. |

So the spike does **not** recommend adopting the Agent SDK engine now. Its
cost, measured: about 333 MiB more image (growing a third a month), about
250 MiB per concurrent run and 1.7 s of the worker's one core per faux
ten-turn run, 0.8 s
before the first API request on a cold start, and a lockdown that needed eight
more rows than the design's table, three of which were fail-open defaults
(telemetry and a prompt-carrying side call, bundled skills, a throwing hook).
What it would buy for the three needs is either available on the Tool Runner
or belongs in a container.

**If the owner adopts it anyway, the concurrency cap.** The worker has
`mem_limit: 1536m`, `cpus: 1.0` and BullMQ concurrency 5; its compose comment
records a peak of 422 MiB "with no nightly job in them"; importing the SDK adds
about 35 MiB. That leaves about 1,080 MiB. At the faux peak of 265 MiB per run
four would fit with nothing to spare; keeping 256 MiB in reserve for the
nightly chain, whose peak is unmeasured, and for real runs being larger, gives
**3 as the ceiling and 2 as the starting cap** in `run-concurrency-policy.ts`:
`floor((1536 − 460 − 256) / peak)`, re-derived from the `--real` peak. On one
CPU, two concurrent runs already double each run's wall time.

## For the owner: the real run

On a machine with Node 18.14 or later, from a checkout of this branch:

```sh
cd scripts/spikes/agent-sdk
npm install
npm run real -- --reps 2
```

The key is read from a hidden prompt, never from argv or the environment, and
is never printed or written. Four real ten-turn runs, each capped at USD 1. It
prints the same table and writes `results/real-<date>.json`. Still open after
it: whether a server-managed settings fetch happens with an API key on a
direct connection (difference 2), which needs a look at the Console
organisation's managed settings.

## Files

| File | Role |
| --- | --- |
| `docs/claude-agent-sdk-design.md` | the Phase 4 trigger, under decision 1 |
| `scripts/spikes/agent-sdk/package.json`, `tsconfig.json`, `.gitignore`, `README.md` | the self-contained spike package (SDK 0.3.323 pinned), its own typecheck, how to run it |
| `scripts/spikes/agent-sdk/locked-options.ts` | `lockedOptions(run)`: the design's table plus the additions above; `SPIKE_MUTATE` removes a row |
| `scripts/spikes/agent-sdk/faux-server.ts` | the scripted faux Messages API; records every request |
| `scripts/spikes/agent-sdk/egress-logger.ts` | a refusing proxy that records every other host the subprocess tries |
| `scripts/spikes/agent-sdk/profile.ts` | the fixed profile: twenty tools, the ten-turn script |
| `scripts/spikes/agent-sdk/measure.ts` | RSS sampling of the subprocess tree and host; installed sizes |
| `scripts/spikes/agent-sdk/run-spike.ts` | `--faux` / `--real` measurements |
| `scripts/spikes/agent-sdk/hostile-host.ts`, `lockdown-check.ts`, `lockdown.spike.ts` | the lockdown proof |
| `scripts/spikes/agent-sdk/needs-probe.ts`, `concurrency-probe.ts` | needs (1) and (2); N concurrent runs |
| `scripts/spikes/agent-sdk/read-hidden.ts` | the hidden key prompt, copied from the 3H proving run |
| `scripts/spikes/agent-sdk/results/*.json` | the faux-mode results quoted above |

## Decisions

- **Faux mode is the default, and the real mode is the owner's.** No key can
  reach this environment. The faux API records what reached the model, which a
  real API cannot show us, so the lockdown proof is stronger in faux mode; what
  faux cannot give is model latency and real context growth.
- **The test lives under the spike's package, on `node:test`.** Root Jest would
  pick up a `*.test.ts` under `scripts/`, so the file is `lockdown.spike.ts`.
- **Excluded from the root build the way the 3H proving run is**: the root
  `tsconfig.json` excludes `scripts/`; root ESLint still lints these files, and
  they pass it. (The proving run's README says it is excluded from lint; it is
  not.)
- **Telemetry was read once, through a throwaway MITM proxy, to name what is
  sent**, and the finding is the switch, not the payload: with the switch on,
  nothing but the model endpoint is contacted.
- **The recommendation is per need**, as the trigger asked, and states what
  the SDK would cost if adopted anyway, so the owner can overrule it with the
  numbers in hand.
