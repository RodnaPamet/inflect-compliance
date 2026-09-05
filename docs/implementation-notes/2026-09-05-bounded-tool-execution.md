# 2026-09-05 — Bound tool execution (OWASP ASI05)

**Commit:** `<pending>` feat(agentic): bound tool execution — a cap halts and reports, never truncates

## The population, established before anything was built

The scope was "any agent-reachable tool that executes code or shells out". The
honest answer is that **there are none today**, and the survey that establishes
it is mechanical rather than impressionistic:

| Question | How it was answered | Result |
| --- | --- | --- |
| What can an agent call? | `MCP_TOOL_NAMES` in `src/lib/mcp/tool-catalogue.ts`, which `tests/guards/mcp-tools-use-shared-authz.test.ts` pins against the two registries | 14 tools — 10 read, 4 propose |
| Do any of them execute code? | Every one is a thin wrapper over a read/propose usecase (`McpReadTool.run`'s contract: "MUST call exactly one existing read usecase"); none imports an executor | No |
| Can orchestration reach further? | `workflow-runs.ts` dispatches only `READ` / `PROPOSE` / `HUMAN_CHECKPOINT` / `SYNTHESIS`, and the first two call `runReadTool` / `runProposeTool` | No |
| Can automation? | `action-executor.ts` switches on `NOTIFY_USER` / `CREATE_TASK` / `UPDATE_STATUS` / `WEBHOOK` / `INVOKE_SUBFLOW` | No |
| What in `src/` spawns at all? | `grep` for every `child_process` import | **2 files**, both cloud-posture collectors |
| Anything evaluating code in-process? | `grep` for `node:vm`, `new Function(`, dynamic `eval(` | 0 (three comment-only mentions) |

The two spawn sites — `cloud-posture/powerpipe-core.ts:92` and
`aws-posture-provider.ts:355` — are reached by a scheduled integration check,
not by an agent, and **both are already bounded** at `maxBuffer: 64 MiB` +
`timeout: 15 min`, and both already refuse an incomplete run through
`powerpipe-exit.ts`. There is no unbounded executor in `src/` to report.

So this is a SEAM, not a retrofit. It was built where such a tool would be
added, and the guard is what makes it non-optional.

## Design

```
     an agent-reachable tool that shells out          (none today)
                        │
                        ▼
        runBoundedTool()   src/lib/agentic/bounded-exec.ts
          │
          ├── deadline ── two layers ──┐
          │     • `timeout` passed to the executor           (belt)
          │     • a race against an injectable timer that    (braces)
          │       ABORTS the child                            → ToolExecutionTimeoutError
          │
          ├── exit ─── describeChildExit()  ← REUSED from powerpipe-exit.ts
          │              └── classifyChildExit()  (generic outcome vocabulary)
          │
          ├── cap ── two INDEPENDENT detectors ──┐
          │     1. the child's own ERR_CHILD_PROCESS_STDIO_MAXBUFFER
          │     2. our own Buffer.byteLength of what came back
          │                                        → ToolExecutionOutputCapError
          │
          └── otherwise ──────────────────────────→ ToolExecutionFailedError
                        │
                        ▼
              BoundedToolResult — the ONLY shape carrying output
```

**A cap halts; it never truncates.** A truncated tool output is not a degraded
result, it is a wrong one that announces nothing: the agent reads a JSON
document that stops early and reasons over it as complete, and the bytes that
would have said otherwise are exactly the bytes that were dropped. Every
non-`completed` outcome therefore throws. There is no arm of the module that
returns partial output, and `stdout` exists on the success shape only — so a
caller cannot read partial bytes by forgetting to check a field.

The same argument makes an aborted tool an error rather than an empty success.
`{ stdout: '' }` reads as "ran, found nothing", which is a conclusion nobody is
entitled to draw from a killed process.

**Two cap detectors, because one of them is the executor's own cooperation.**
`maxBuffer` is a property of `execFile`. An injected executor, a future
`spawn`-based adapter or a streaming runner can hand back a gigabyte having
reported a clean exit. Detector 2 measures what actually arrived, on the success
path, after classification. A bound that is only as strong as the thing it
bounds is not a bound.

**Two deadline layers, for the same reason** — and the wrapper's own race is
what makes the deadline testable at all: it is a plain `setTimeout` on an
injectable timer API, so the test drives it with no subprocess and no waiting.
The race also calls `controller.abort()`, because a wrapper that merely stops
*waiting* for a child leaves a subprocess nobody is watching.

**Exit classification is reused, not reinvented.** `powerpipe-exit.ts` already
solves the awkward part: a `maxBuffer` overflow sets `code: 'ERR_…'` *and*
`signal: 'SIGTERM'`, so it is indistinguishable from a timeout kill to anything
that checks the signal first. `describeChildExit` keeps `code` / `signal` /
`failure` apart and discriminates on `typeof code === 'number'`; this module
imports it. What is added on top is a *generic* outcome vocabulary —
`classifyPowerpipeExit` cannot be reused wholesale because powerpipe overloads
exits 1 and 2 to mean "completed, and found something", whereas for an arbitrary
tool a numeric status is just a status and its meaning is the caller's business.

**A refusal reports a byte count and a digest, never the bytes.** A cap breach
is precisely the case where nobody has read the output, so it is the case where
nobody can say it holds no credential. `ToolExecutionOutputCapError` carries
`stream` / `limitBytes` / `observedBytes` / `digest` (16 hex chars of SHA-256) /
`detectedBy`, and the log line carries the same fields. No captured byte appears
in the message or in any enumerable field a structured logger would serialise.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/bounded-exec.ts` | The seam. Bounds, outcome vocabulary, three error classes, `classifyChildExit`, `digestOutput`, `nodeToolExecutor`, `runBoundedTool`. |
| `tests/unit/agent-tool-execution-bounds.test.ts` | The behaviour: the deadline aborts, the cap halts and reports, the success path returns whole output, the classifier separates an overflow from a plain kill. Executor and clock both injected — no subprocess is spawned. |
| `tests/guards/tool-execution-is-bounded.test.ts` | That the bounds are REACHED. Exact-equality allowlist of every `src/` file able to execute code; both options required at every buffered call site; streaming spawners and in-process evaluators refused outright; **zero** executors permitted under the agent-reachable roots; plus a vacuity companion asserting the call-site extractor still resolves the calls it claims to police. |

## Decisions

- **The seam has no current caller, and that is stated rather than hidden.**
  `bounded-fetch.ts` deleted its own second timeout for exactly this reason ("a
  longer bound that nothing uses is worse than no bound — the prose asserts a
  design the code does not implement"). The difference here is the guard: a
  build fails without the seam the moment an executor appears on the agent
  surface, so it is required rather than merely available. The distinction is
  worth keeping honest — this module is enforced-by-CI, not aspirational.

- **No spreadable `TOOL_EXEC_BOUNDS` convenience object.** An early draft
  exported one and had the two posture collectors import it, which is tidy and
  also means a cloud-posture collector depends on `lib/agentic` to learn two
  integers — a dependency edge that misdescribes the system. The guard checks
  that every call site carries BOTH options, which is the actual invariant. Only
  the two scalars survive, and they are consumed as `runBoundedTool`'s defaults.

- **The collectors were not refactored onto `runBoundedTool`.** Their exit
  semantics are powerpipe's overloaded ones (1 = alarms, 2 = control errors,
  both meaning "the run completed"). Folding them into a generic wrapper would
  either lose that or push it back in as a second classification scheme, which
  is the thing `powerpipe-exit.ts` exists to prevent. They stay bounded where
  they are, and the guard now holds them there.

- **The guard asserts it is not vacuous.** The boundedness rule iterates
  `spawnerBindings × callSites`; if either extractor stopped recognising a call
  — a new import form, an aliased binding — the rule would pass by finding
  nothing to check, and an unbounded executor would ship green. A companion
  asserts every file in the spawn population resolves at least one call, so an
  absence and a clean bill of health stop looking identical. Proved by mutation:
  making the extractor return nothing reddens the companion and NOTHING else.

- **In-process evaluators (`new Function`, `vm.*`) are refused outright, not
  allowlisted.** They execute on the same thread: there is no child to kill and
  no stream to cap, so "bounded" is not expressible for them at all. There are
  none in `src/` today (the three matches are comment text).

- **Streaming spawners (`spawn`, `spawnSync`, `fork`) are banned in `src/`
  outright rather than allowlisted.** They accept no `maxBuffer`, so
  "bounded" cannot be expressed on the call at all — a caller who needs the
  output has to accumulate it, which is how an unbounded read gets written by
  accident. There are none today; the ban is what keeps it that way.

- **The guard's boundedness rule requires BOTH options, not either.** An
  executor with only `timeout` still gives its heap away to a chatty child;
  one with only `maxBuffer` still gives its worker slot away to a hung one.
  Each alone is unbounded in the direction it omits.

- **`scripts/**` and `tests/**` are out of the population, deliberately.**
  They are developer and CI tooling, not reachable by a tenant or an agent, and
  `tests/helpers/repo-files.ts` legitimately shells `git` with a generous buffer
  and no deadline. Widening the population there would trade a real invariant
  for a maintenance chore.

- **No new model, no new route, no new permission.** Nothing here is
  tenant-scoped or reachable over HTTP, so there is no RLS triple to add and no
  `AUTHZ_DENIED` path to wire. Authorization for a future executing tool is
  unchanged: it goes through `authorizeToolCall` like every other tool.
