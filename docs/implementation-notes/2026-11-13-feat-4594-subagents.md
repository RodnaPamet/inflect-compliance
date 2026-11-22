# 2026-11-13 — Inline sub-agents on the Tool Runner engine (#4594, Step 2e, PR C)

**Commit:** `feat(agents): inline sub-agents on the Tool Runner engine (#4594)`, then
`feat(agents): turn sub-agents on for the Tool Runner (#4594)`

## Design

The design is "Delegation" in `docs/claude-tool-runner-design.md`, drawn to the
owner's decisions of 2026-11-13. PR B (the org-level turn caps) is this
branch's base.

```
AgentProfileVersion.subagentsJson (encrypted, canonical, ≤4, frozen, hashed)
        │  usecases/agent-profiles.ts — sanitise, subset-check, scan, refuse by name
        ▼
compileProfileDefinition → ProfileRunSpec.subagents   (strict read-back)
        │  admission: RUNS_SUBAGENTS[driver] or PROFILE_SUBAGENTS_NOT_RUNNABLE
        ▼
tool-runner/execute.ts
   parent loop ── runModelLoop(subagent = null) ──┐
        │ offers `delegate` (tool-runner/delegate.ts) beside its tools
        ▼                                         │ ONE loop body
   delegate.run: steps 1-12 in the design's order │
        └─ child loop ── runModelLoop(subagent = name) ┘
              tools = offerToolSet(parent invocation, sub.toolNames,
                       parent latch, guard source tool-runner-subagent.<name>)
                       ∩ parent's offered set
```

The child shares the parent's `RunBudget`, ledger counter, stops, client and
review latch; its request signal is `AbortSignal.any([parent, child])`. Every
child step carries `WorkflowStep.subagentName`; the `delegate` marker step
closes the span the run page already groups.

`runModelLoop` is the one loop body. Before EVERY model call, in both loops, it
reads the kill switch and the breaker and charges one STEPS (owner decision 4).
"Before the next call" is placed by calling `runner.generateToolResponse()` at
the end of the body: the SDK caches that response and reuses it rather than
running the turn's tools twice, so the checks sit between the tools and the
next request.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261113150000_agent_profile_subagents/` | the column + CHECK, the lifecycle function replaced so the freeze covers it, `WorkflowStep.subagentName` + NOT VALID CHECK then VALIDATE |
| `prisma/schema/agentic.prisma`, `src/lib/security/encrypted-fields.ts` | the two columns; `subagentsJson` in the Epic B manifest |
| `src/lib/agentic/agent-profile.ts` | `ProfileSubagent`, `checkProfileSubagents`, canonical serialise / strict parse, `describeSubagentsForReview`, `RUNS_SUBAGENTS` |
| `src/app-layer/schemas/agent-profile.schemas.ts` | strict sub-agent schema (no description), `SUBAGENTS_WITH_FLOW` |
| `src/app-layer/usecases/agent-profiles.ts` | save and approval checks, the versioned content hash, audit facts, the view |
| `src/app-layer/usecases/agent-profile-runs.ts` | strict compile, `PROFILE_SUBAGENTS_NOT_RUNNABLE` at admission, resume and preview |
| `src/lib/agentic/tool-runner/delegate.ts` | the `delegate` tool, the nested loop's set-up and marker |
| `src/lib/agentic/tool-runner/execute.ts` | `runModelLoop`, shared by both loops; the breaker stop and its settlement |
| `src/lib/agentic/tool-runner/{tools,params,skills,supplied-tools}.ts` | sub-agent label on every step, `subagentGuardSource`, `lockedParams({ subagent })`, `delegate`'s register entry |
| `src/lib/agentic/engine-tools/{offer-tools,delegate-answer}.ts` | optional shared `review` latch; `guardDelegateAnswer` moved here with a required prefix (Flue binds `'flue'`) |
| `src/lib/agentic/drivers/step-recorder.ts`, `run-step-projection.ts` | the label in the column and the audit row; `delegate` is a marker; `subagent` on each row |
| `BehaviourSubagentsSection.tsx`, `BehaviourEditorSheet.tsx`, `BehaviourTab.tsx`, `AgentRunDetailClient.tsx`, `ToolsTab.tsx` | editor section, approval view and diff, history count, run-page badge, the new appears-when |

## Decisions

- **One loop body, not two.** The per-message checks moved out of
  `executeToolRunnerRun` into `runModelLoop`; the parent calls it with no
  sub-agent and each delegation with the sub-agent's name. Charging STEPS and
  reading the breaker before each model call therefore applies to the parent
  too, as decision 4 requires; a parent run may halt at STEPS sooner than the
  Step 2H evidence showed.
- **The breaker settles with its own reason.** OPEN settles
  `tool_runner_breaker_open`; an unreadable latch stops the run
  (`tool_runner_breaker_unreadable`), as an unreadable kill switch does. It is
  settled after a kill and before a cap.
- **The span's lower bound is exclusive.** The marker's `fromSeq` is the last
  seq taken before the delegation, so `delegationSpans` (strictly between)
  claims exactly the child's steps.
- **A child's request for a tool it was not offered is ledgered.** The SDK
  answers it `not found`; the loop body also writes a FAILED step,
  `SUBAGENT_TOOL_NOT_OFFERED`, labelled with the sub-agent, naming the tool only
  when it is one the run knows. The parent's loop records no such step, as
  before.
- **`SUBAGENTS_UNREADABLE` (409)** is approval's refusal for a stored list this
  build cannot read back, the twin of `FLOW_UNREADABLE`.
- **The zod cap is loose on purpose.** The schema bounds the array at 16 only to
  keep a body small; the cap of 4 is the usecase's, so a fifth sub-agent is
  `SUBAGENTS_TOO_MANY` with the cap in `details`.
- **Audit facts are named at the sink** (`no-raw-prompt-logging`): count, names
  and each sub-agent's tools; never instructions.
- **Turning the engine on is its own commit.** `RUNS_SUBAGENTS['tool-runner']`
  flips in the last commit, with the end-to-end integration test and the copy
  that depends on it. Reverting that commit refuses every sub-agent version by
  name rather than running it without its delegates.
