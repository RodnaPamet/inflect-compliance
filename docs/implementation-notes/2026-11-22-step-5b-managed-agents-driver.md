# 2026-11-22 — Step 5b: the Managed Agents driver, reader-only

**Commit:** see the pull request for issue #4165 (Step 5b of `docs/claude-managed-agents-design.md`).

## Design

The whole engine is built and conformance-proven, and no input selects it:
`DRIVER_IMPLEMENTED['managed-agents']` is false, and `MANAGED_AGENTS` is a
READ_ONLY value of `AgentDriverMode` (deploy 1 of 2) that no writer accepts.

```
approval ──▶ provisionApprovedProfileVersion ── resolveDriverForTenant ≠ managed-agents ─▶ ENGINE_NOT_IN_FORCE (always, in 5b)
                 │ (5d)
                 ▼
            provisionManagedAgent ── environments.create (one per connection: cloud, limited, no hosts)
                                  ── agents.create / agents.update(version)   system = Inflect's preamble only
                                                                               tools  = custom tools only
                                  ── recordProvision {agentId, version, environmentId, systemHash, toolsHash}

run (worker) ─▶ runManagedAgentsDriver
                  LOCAL_ONLY? ─ def is a profile asking for this engine ─ ONE enabled anthropic-workspace connection
                  ─ provision for (version, connection) ─ managedAgentsClientFor(decrypted key, workspace header)
               ─▶ executeManagedAgentsRun
                  kill ─ run row ─ skills + pins ─ invocation, caps, wall clock ─ offer (toolRunnerToolsFor, 'managed-agents')
                  ─ empty? ─ transfer gate ─ DRIFT: agents.retrieve(id, version) vs hashes ─ dollar budget
                  sessions.create(agent_with_overrides{id, version, system: preamble + catalogue + instructions},
                                  environment_id, budget, metadata{tenant, run})  ── SESSION_CREATED step
                  stream first, then user.message
                  per event: dedupe ─ kill + operator abort
                     agent.message          guardEgress
                     agent.custom_tool_use  queued
                     span.model_request_end MODEL_CALL (span-derived) + Art 12 row (provider …:span-derived)
                                            ─ STEPS, TOKENS, RUNTIME_MS ─ breaker ─ run the turn's queued calls
                                              (runnable: stop? STEPS, turn cap, TOOL_CALLS, guarded call, TOOL_CALL, kill)
                                              ─ user.custom_tool_result (is_error on refusal), once per call
                     agent.tool_use / mcp   stop: beyond custom tools
                     status_idle            requires_action → run queue; else the session's end
                  drop ─▶ reopen stream, list history, dedupe, continue (≤ 5)
                  stop ─▶ pending answered is_error + user.interrupt ─ drain to idle (≤ 3 rounds)
                  finally ─▶ poll status ≠ running ─ DELETE session ─ SESSION_DELETED
                             (or SESSION_KEPT when the connection keeps sessions; SESSION_DELETE_FAILED with the status)
                  settle: abort ▸ kill ▸ breaker ▸ cap ▸ guard ▸ beyond tools ▸ failure ▸ stream lost ▸ session end ▸ COMPLETED
```

## Files

| File | Role |
| --- | --- |
| `prisma/schema/enums.prisma`, `prisma/migrations/20261122140000_agent_driver_mode_managed_agents/` | `MANAGED_AGENTS`, `ADD VALUE` alone in its file, deploy 1 of 2 |
| `prisma/schema/agentic.prisma`, `prisma/schema/auth.prisma`, `prisma/migrations/20261122140100_agent_profile_provision/` | `AgentProfileProvision`, the RLS triple, CHECKs on the hashes and version |
| `src/lib/agentic/agent-driver.ts` | `'managed-agents'`; READ_ONLY in `STORED_DRIVER_MODES`; `DRIVER_IMPLEMENTED` false; reasoning engine; the gate's branch |
| `src/lib/agentic/agent-driver-policy.ts`, `src/app-layer/usecases/agent-driver-setting.ts` | pass `AGENT_MANAGED_AGENTS` to the gate |
| `src/lib/agentic/agent-profile.ts` | runs profiles; no flows, sub-agents or deferrals |
| `src/lib/agentic/drivers/index.ts` | the driver mapped |
| `src/lib/agentic/tool-runner/client.ts` | `managedAgentsClientFor` and `managedAgentsRequestRefusal`, in the one file that may load the SDK |
| `src/lib/agentic/managed-agents/definition.ts` | every body the engine writes, the hashes, drift, the dollar backstop |
| `src/lib/agentic/managed-agents/store.ts` | the connection read (decrypted key), the provision reads, the one provision writer |
| `src/lib/agentic/managed-agents/provision.ts` | create or update the profile's agent, record it |
| `src/lib/agentic/managed-agents/driver.ts` | plan and refusals, the hand-off |
| `src/lib/agentic/managed-agents/execute.ts` | the session job: stream, bridge, stop, settle |
| `src/lib/agentic/managed-agents/model-decision.ts` | the span-derived Art 12 row |
| `src/app-layer/usecases/agent-profile-provision.ts`, `src/app-layer/usecases/agent-profiles.ts` | the approval hook |
| `src/lib/agentic/drivers/run-settlement.ts`, `empty-catalogue-message.ts`, `external-residency-gate.ts` | the engine's prefix |
| `messages/en.json`, `messages/bg.json` | the engine's name for a stored value |
| `docs/data-retention.md` | `AgentProfileProvision` classified |
| `tests/helpers/managed-agents-faux.ts` | the faux workspace and SSE transport |

## Decisions

- **The client lives in `tool-runner/client.ts`.** `local/anthropic-client-single-seam`
  lets one file load the SDK. A second exempted file would have been a second
  seam; a second named constructor in the one seam keeps the rule's sentence
  true. `managed-agents-client.test.ts` holds that there are exactly two
  constructions there and only the driver and the provisioning usecase call
  this one.
- **The engine reuses the Tool Runner's runnables.** `toolRunnerToolsFor` and
  `activateSkillTool` already do the stop check, the charges, the turn cap, the
  guarded call, the TOOL_CALL step and the kill read after, and their `run`
  takes a session event as its tool use. A third copy would drift. The guard
  prefix is this engine's own (`managed-agents`).
- **A turn's calls run after its `span.model_request_end`, not on arrival.** The
  SDK allows answering at once, but then the token cap and the scan of the
  turn's text would be read after its tools ran. Queuing them keeps the Tool
  Runner's order. `the token cap is read … before any tool` proves it.
- **The stop sends the interrupt at once, mid-request.** A kill or Abort found
  at a span start reaches Anthropic while that request is in flight, so the
  session stops after it. A kill found while a tool runs must first answer the
  pending call, and that lets the model start one more request: the variance.
- **The faux models the weaker stop.** An interrupt is honoured after the
  request in flight, and the events of one POST are processed in order. That is
  the documented "safe boundary"; a faux that stopped at once would make the
  kill variance untestable. With it, the shared kill and abort scenarios still
  hold for a kill found between calls, and a test shows the extra request for a
  kill found during a tool.
- **The ledger records the session's life as `SYNTHESIS` steps**, label
  `managed-agents-session`, `input.lifecycle` one of `SESSION_CREATED`,
  `SESSION_DELETED`, `SESSION_KEPT`, `SESSION_DELETE_FAILED`. No new
  `WorkflowStepKind` (another two-deploy enum), and the conformance scenarios
  count only `MODEL_CALL` and `TOOL_CALL`. `SESSION_CREATED` is written before
  anything else in the guarded block, so a crash leaves an id for 5c.
- **A span-derived decision row is marked by its `provider`**
  (`anthropic-managed-agents:span-derived`), not a new column on the
  append-only `AiDecisionLog`. Its input is `{ basis: 'INFLECT_SENT', agent,
  system, sent }`: what Inflect had sent the session when the call ended.
- **Provisioning reads Inflect's static catalogue** (`READ_TOOLS`,
  `PROPOSE_TOOLS`). A version naming an external connection's tool is refused
  `TOOL_NOT_EXPRESSIBLE` rather than provisioned without it.
- **The agent's `activate_skill` names no skill.** The Tool Runner's has an
  `enum` of skill names, and a tenant skill's name is the tenant's text; the
  agent is never deleted. The runnable still refuses any name the run did not
  mount and pin.
- **Drift also refuses MCP servers, skills or sub-agents on the agent**, and a
  run stops if the agent calls a built-in or MCP tool, since only a Console edit
  could have added one.
- **The budget prices every token of the TOKENS cap at the output rate, plus the
  session-hours of the wall-clock cap.** It is a backstop that must not bind
  before the run's own count does. A model with no list price is refused.
- **Provisioning never throws into the approval.** A version that was not
  provisioned is refused by name at run time (`managed_agents_not_provisioned`).
- **One connection or none.** Two enabled workspace connections refuse the run
  (`managed_agents_ambiguous_workspace`): a run never chooses between them.
- **The hashes are of what Inflect wrote.** If Anthropic normalises a tool's
  schema on the way back, every run would read as drifted. 5H checks this
  against a real workspace.
