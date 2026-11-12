# 2026-11-12 — Agent builder and Tool Runner engine, observed in production

**Commit:** see the pull request that adds this note (Steps 1H #4145 and 2H #4152, second parts).

## Design

Steps 1H and 2H each end with production evidence, and both were gathered in the
same session in the proving tenant on 2026-11-11, through the product only: no
database read, no log read, no VM access. Everything below was read off the agent's
Behaviour tab and the run pages.

The run page carries enough to stand in for a log read because of two earlier
changes. #4537 made the run client record each request's shape (method, path,
top-level body key names, whether a `thread` member is present) and #4551 put that
shape on each `MODEL_CALL` step's input as `wire`. No value from a body is recorded.

### Phase 1 — a profile authored and approved

- Agent "Proving Agent", `cmwc7djln000o01o5l8c2ay4c`.
- Profile `cmwc7sgtz002301o5nkwb5prt`, version 1: written at 14:28 UTC by one
  member, approved at 14:29 UTC by a different member.
- Instructions hash `e4221e1c4669532b50cebf95754f553af154a6d00a79ae5eb86461d5911b0f97`.
- Tools `list_controls`, `list_risks`, `list_tasks`; no skills; Balanced; Medium
  effort; 10 turns; answer only; Test run the only trigger.

The audit rows were not read. The version history shows the same two people and
times that `AGENT_PROFILE_SUBMITTED` and `AGENT_PROFILE_APPROVED` record.

### Phase 2 — the engine's three outcomes

| Run | Started (UTC) | Steps | Tokens | Outcome |
| --- | --- | --- | --- | --- |
| `cmwc8pgt2000301o5927h6ozw` | 14:54 | 3 model, 2 tool | 25,119 | Completed, last stop `end_turn` |
| `cmwclvwva001301o5iycngfi0` | 21:03 | 3 model, 2 tool | 49,465 | Aborted: kill switch engaged for this agent |
| (id not captured) | 21:08 | 0 | 0 | Failed: `tool_runner_local_only_unserved` |

Each model call has one Art 12 decision row, so the two runs with steps have three
each. Both tool calls ran `list_risks` then `list_controls`, guard clean.

**The kill switch.** The stop was pressed while the Aborted run's last model call
(44,107 tokens) was in flight. The Tool Runner checks the switch after every model
call and after every tool call, and does not interrupt a call in flight. So that
call finished, the check after it found the switch engaged, and the run settled
Aborted with nothing sent after it. Every step reading Done beside an Aborted status
is the check working: the run carries no result, and its settlement wrote a
`WORKFLOW_RUN_AGENT_KILLED` audit row naming the switch and when it was engaged.

**No conversation stored at Anthropic.** All six recorded requests were
`POST /v1/messages` with body keys `fallbacks`, `max_tokens`, `messages`, `model`,
`output_config`, `stream`, `system`, `thinking`, `tool_choice`, `tools`, and
`threadMember: absent`. The guard that records the shape runs on every attempt,
retries included, and refuses any request that carries `thread`, `container` or
`mcp_servers`.

### The adversarial read (2H item 1)

Recorded in #4537 and carried here. No defect in any question.

| Question | Answer | Where |
| --- | --- | --- |
| Can a run's client outlive the run? | No. `clientForRun` builds a client per call and caches nothing. | `tool-runner/client.ts`, `driver.ts` |
| Can two tool calls run at once? | No. One serial queue per run, shared with `activate_skill`; the ledger seq is taken inside the queued task. | `tools.ts`, `skills.ts` |
| Can a fallback model's message skip the guard? | No. Every yielded message goes through the egress scan, a `MODEL_CALL` step and an Art 12 row. | `execute.ts` loop |
| Can the prompt carry another version's instructions? | No. The worker and resume rebuild from the pinned version id and refuse a key or hash mismatch. | `agent-profile-runs.ts`, `workflow-runs.ts` |
| Is `thread: false` on every path, retries included? | Yes. No body carries a `thread` member, and the guard sees every attempt. Observed in production above. | SDK `makeRequest` / `retryRequest`; `messagesOnlyFor` |

## Files

| File | Role |
| --- | --- |
| `docs/claude-agent-sdk-design.md` | Phase 1 and Phase 2 rows of the Operational evidence table; Step 1H header |
| `docs/claude-tool-runner-design.md` | Current state bullet; Step 2H delivered |
| `CLAUDE.md` | What a kill engaged during a Tool Runner model call looks like |

## Decisions

- **The Aborted run counts as the kill-switch drill.** The checklist asks for a run
  halted before its next model call. This run had no next call to halt, because the
  stop landed during its last one; it shows the other half, that an engaged switch
  turns a run that would have completed into an Aborted one and its answer is not
  delivered. The per-model-call check is held for every engine by the conformance
  suite's kill scenario.
- **The proving agent, not the drill agent.** A Test run needs an approved
  profile, and the approved profile was on the proving agent. The kill switch is
  read by the same code for either; the drill agent only changes the metric's
  `drill` label.
- **No person's name or address is recorded.** The evidence names the profile, the
  version, the hash and the times. The two people are recorded only as different.
