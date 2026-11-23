# 2026-11-23 — Step 5H part 1: an adversarial read of the Managed Agents engine (#4169)

**Commits:** `5a97d2864 fix(agents): never let the SDK re-send a Managed Agents POST`,
`2e7677228 fix(agents): settle a refused Managed Agents session create with codes, not the provider's text`,
`1e11749b6 fix(agents): stop a Managed Agents run whose session is edited mid-run`,
`483561e63 fix(agents): cap a Managed Agents session at what the run has left`,
`d292b3edc fix(agents): reconcile a Managed Agents session a dead worker abandoned`,
`cae932f30 fix(agents): find and settle a Managed Agents session whose create got no answer`
(all `(#4169)`).

## Design

Item 1 of Step 5H in `docs/claude-managed-agents-design.md`: read Steps 5a to
5d together, assuming a hostile tenant admin, a hostile customer workspace admin
holding the workspace's key, and an unreliable network and worker, and answer
the design's five questions with evidence. Step 5e is not built. Parts 2 to 4 of
5H need a real workspace and are not part of this note.

The read covered every file under `src/lib/agentic/managed-agents/`,
`managedAgentsClientFor` and `managedAgentsRequestRefusal` in
`src/lib/agentic/tool-runner/client.ts`, the `anthropic-workspace` provider,
`usecases/agent-profile-provision.ts`, `usecases/managed-agents-cleanup.ts`,
`usecases/agent-driver-setting.ts`, the worker's run path
(`jobs/agent-run-execute.ts`, `executeQueuedWorkflowRun`, `executeFrom`,
`in-flight-runs.ts`), and `@anthropic-ai/sdk` 1.8.0's own retry and error code
(`client.js`, `core/middleware.js`, `core/error.js`) and Managed Agents types.

Six defects were found and fixed, each with a test that fails without its fix.
Five more findings are not fixed: four are hardening options or questions that
need an owner, and one needs the real workspace of parts 2 to 4.

### 1. Can a tenant's instructions reach the agent object?

**No path found.** Evidence:

- **Create and update.** `provisionManagedAgent`
  (`managed-agents/provision.ts:51`) takes no instructions; its body is
  `agentBodyFor` (`definition.ts:169`), whose `system` is the constant
  `MANAGED_AGENTS_PREAMBLE` (`definition.ts:183`). An update sends the same
  body (`provision.ts:66`). The usecase does not even select the version's
  instructions (`agent-profile-provision.ts:78`). Held by the existing test
  "the tenant's instructions are in the session override and never in an
  agents.create or agents.update body".
- **Re-provision and drift repair.** There is no automatic repair: a drifted
  run is refused, and the only writer of an agent is the approval's
  provisioning, above. A re-approval of a version already provisioned returns
  the stored record and sends nothing (`provision.ts:56-57`).
- **The session.** Instructions travel only in `agent_with_overrides`
  `system` (`sessionSystemFor`, `definition.ts:290`), and the client refuses a
  session body whose `agent` carries any key but `type`, `id`, `version`,
  `system` (`client.ts`, `SESSION_REACHES_BEYOND_SYSTEM`). Inflect never updates
  a session: the route `POST /v1/sessions/{id}` is not in the allowlist.
- **Error messages.** One leak of the provider's text was found and fixed
  (below, under "provider response text"). No Inflect log or row carries the
  instructions: the run's settlement sentences are fixed text plus codes.
- **An SDK re-send** cannot put them on an agent either; it could have created
  a second, unrecorded SESSION holding them (fixed, question 3).

### 2. Can a session survive a worker restart undeleted?

**It could, and indefinitely. Fixed twice; one narrow window remains.**

How a run continues after its worker dies: `agent-run-execute` is retried
(`attempts: 3`, `jobs/types.ts:1332`), `executeQueuedWorkflowRun` re-enters a
RUNNING run from the ledger (`workflow-runs.ts:1913`, `:2004`), and a SIGTERM
drain marks in-flight runs PAUSED for a person's resume (`in-flight-runs.ts`).
Either way the Managed Agents driver runs again from the top: the run is
**re-run in a new session, never resumed in the old one**. Nothing reads an
earlier session of the run. The engine deletes its session in `finally`
(`execute.ts:969`), which a dead process never reaches.

Crash at each await between `sessions.create` and settle:

| Point of death | Before | After |
| --- | --- | --- |
| `sessions.create` sent, no answer (network) | session made, nothing recorded; the SDK re-sent the create, making a second | not re-sent (`SEND_ONCE`); the run lists the pinned agent's sessions by this run's metadata, records and settles what it finds (`settleUnrecordedSessions`) |
| `sessions.create` refused (a status) | thrown out of the driver; BullMQ retried into another create | settled `managed_agents_session_not_created` with codes; no retry |
| answer received, process dies before `SESSION_CREATED` is written | unrecorded; only a purge or connection removal finds it (crash-window listing) | **unchanged** — see "Not fixed" |
| any await after `SESSION_CREATED` (stream, tool, ledger, interrupt, settle) | only `SESSION_CREATED` on the ledger; the reconciliation never took it; a DSAR never did either | the reconciliation settles it once it is older than any segment (`isAbandonedSession`): deleted and recorded DELETED, or recorded KEPT on a keeping connection |
| `SESSION_DELETE_FAILED` recorded | retried by the reconciliation (#5843) | unchanged |

A BullMQ retry of the same job is a new segment like any other: a new session,
and with this branch the old one is settled by the reconciliation. Every
session a segment creates is on the ledger except in the one window in the
table.

Tests: `isAbandonedSession` (unit, over lifecycles and ages), "the
reconciliation settles a session a dead worker abandoned …" (integration, real
DB, faux workspace, both a deleting and a keeping connection, a fresh session
left alone), "a session whose create response the network lost is found by
this run's metadata, recorded and settled" (unit, both connection kinds, another
run's and another tenant's sessions on the same agent untouched).

### 3. Can a custom tool result be sent twice?

**Yes, through the SDK's own retry. Fixed.**

- **The SDK.** `@anthropic-ai/sdk` retries a request whose connection failed or
  timed out, and a 408, 409, 429 or 5xx, up to twice by default
  (`client.js`, `shouldRetry` and the fetch-error branch; a fetch-origin error
  passes the middleware's `isRetryableError`). No request carries an idempotency
  key. A `user.custom_tool_result` the workspace had taken, whose answer was
  lost, was therefore sent again. Reproduced on the faux: two results for one
  call id. Every POST the engine sends now carries `SEND_ONCE`
  (`{ maxRetries: 0 }`, `definition.ts:151`): events, `sessions.create`,
  `agents.create`/`update`, `environments.create`. A failed send fails the run
  closed and the session is deleted, as a send that could not be made already
  did.
- **Stream reconnects.** Not a path. Every event is deduplicated by id
  (`execute.ts:838`), a reconnect reads the full history first
  (`execute.ts:869`), and `answer` marks a call answered before it sends
  (`execute.ts:681`), so a replayed `agent.custom_tool_use` is never queued
  again. Held by the existing tests "a dropped stream with a pending custom tool
  call resumes and answers it exactly once" and "a drop after a completed call
  replays the history without counting any event twice".
- **Job retries.** Not to the same session: a retry creates a new one
  (question 2). The calls of the earlier segment are not answered twice, but
  the model of the new session may ask for them again, so a tool can RUN twice
  across segments. That is a property of re-running, shared with every
  reasoning engine; see "Not fixed".
- **Concurrent workers on one run.** `agent-run-execute` is enqueued with no
  `jobId` and `executeQueuedWorkflowRun` claims nothing beyond `status ===
  'RUNNING'`, so a stalled-job redelivery can run one run twice at once. Each
  worker drives its own session and answers only its own calls, so no session
  receives a result twice; the two would collide on the ledger. Generic to the
  run engine; see "Not fixed".

Tests: "a tool result whose response the network lost is never sent again",
"a session create whose response the network lost is not sent again", "an
agent create whose response the network lost is not sent again".

### 4. Can a customer admin's Console edit widen what a run reaches?

**An agent edit cannot. A session edit could; it now stops the run.**

- **The agent's system or tools, a new agent version.** Every edit makes a new
  version; the session pins the recorded one, and the drift check reads THAT
  version before the session exists (`execute.ts:565`, `agentDrift`,
  `definition.ts:267`), comparing `system` and the normalised `tools` to what
  Inflect wrote and refusing any MCP server, skill or sub-agent. An archive in
  the Console reads `ARCHIVED`. Existing tests: "drift in system or tools refuses
  the run before a session exists".
- **Adding MCP servers or skills to the agent.** Same: a new version, and
  refused at the pinned one if somehow present.
- **The environment (networking, packages).** Not checked before a session,
  and does not need to be for reach: a container is reachable only through a
  toolset tool, which the agent cannot hold (drift) and the session can gain
  only through a session edit, which now stops the run. The environment the run
  sees is the one recorded, but a Console edit of it is not detected; see "Not
  fixed".
- **The running session.** Anthropic lets anyone holding the workspace's key
  replace a session's `tools` and `mcp_servers` (and its `budget`) while it is
  idle, which it is whenever it waits for Inflect to answer a call. The engine
  ignored the `session.updated` event that reports it, so a toolset or an MCP
  server was noticed only at its first use, after Anthropic had run it
  (`agent.tool_use` / `agent.mcp_tool_use`, `execute.ts:799`), and a budget edit
  never. A `session.updated` carrying `agent` or `budget` now stops the run
  (`execute.ts:804`, `managed_agents_session_edited`). Residual: the edit is read
  after the answer that preceded it, so the next model request can start with
  the new tool, and Anthropic may run one call before the stop; it is then
  caught as before. Tests: "a customer admin edits the running session", four
  cases and a title-only positive control.

### 5. Can the dollar budget be exceeded by more than one request?

**Within one session, no. Across a run, it could. Fixed.**

- **One session.** Anthropic checks the budget before each model request, so
  only the request in flight can overrun it (`BetaManagedAgentsBudgetLimit`,
  "stops issuing new model requests once the tracked list cost reaches
  `max_list_cost`"). There is one thread: no sub-agents (drift, and the client
  refuses `multiagent`). `amount` is in minor units (`BetaMonetaryAmount`), as
  `sessionBudgetFor` writes it.
- **Across segments.** Every segment's new session was given the budget of the
  run's WHOLE token cap and wall clock. Inflect's own token count carries across
  segments and still binds, but the backstop behind it allowed the whole cap
  once per segment. It now takes `budget.remaining('TOKENS')` and
  `budget.remaining('RUNTIME_MS')` (`execute.ts:589`). Test: "a resumed run's
  session gets the spend cap of what the run has LEFT" (208 cents sent where 104
  were left, before the fix).
- **An edited budget.** Raising or removing the session's budget mid-run is a
  `session.updated` and now stops the run (question 4). Inflect's token count
  would still have bound it to one request over.
- **Tokens Inflect never counted.** A request in flight when a worker dies is
  never seen as a `span.model_request_end`, so the next segment's remainder
  overstates by at most that request, once per death.

### Briefly: the response's workspace on the run path

**Not verified anywhere on the run path.** The 5a Test passes only when the
response's `anthropic-workspace-id` names the configured workspace; the engine
sends the header on every request (`managedAgentsClientFor`) and reads the
response's header on none. A workspace-scoped key sent with another workspace's
header is refused by Anthropic ("if sent, it must match"), so this matters only
if Anthropic ignores the header, which is #5797's question. See "Not fixed".

### Briefly: provider response text in a log or audit row

**One leak, fixed.** `sessions.create` was the one provider call on the run
path outside a `try`. Its refusal threw the SDK's `APIError`, whose message is
`<status> <the response body as JSON>` (`core/error.js`, `makeMessage`), out of
the driver, into the worker's `job failed` log line (`scripts/worker.ts`) and
BullMQ's stored failure. It is now settled with the status and error type only.
Everything else on the path already logs and records codes
(`providerCodeOf`, `outcomeOfError`); provisioning logs `err.name`; the 5a
provider classifies by the error text and never shows or logs it; the SDK's
logger drops the request and response it is handed. Test: "a refused session
create settles the run with codes only", which spies on every logger level.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/managed-agents/definition.ts` | `SEND_ONCE` |
| `src/lib/agentic/managed-agents/execute.ts` | `SEND_ONCE` on every POST; the create settled with codes, and a no-answer create's session found and settled (`settleUnrecordedSessions`); `session.updated` stops the run; the budget from what is left |
| `src/lib/agentic/managed-agents/provision.ts` | `SEND_ONCE` on the environment and agent POSTs |
| `src/app-layer/usecases/managed-agents-cleanup.ts` | `isAbandonedSession`, `settleAbandonedSessionsFor`; the connection reader learns `keepSessions`; the ledger reader learns each session's CREATED time |
| `src/lib/observability/integration-metrics.ts` | `agentic.managed_agents.abandoned_session` |
| `src/app-layer/jobs/executor-registry.ts` | Comment: the reconciliation's third duty |
| `tests/helpers/managed-agents-faux.ts` | `loseResponse`, `failSessionCreate`, `sessionEditAfterTurn` |
| `tests/unit/agentic/managed-agents-driver.test.ts` | The engine's new tests |
| `tests/unit/agentic/managed-agents-cleanup.test.ts` | `isAbandonedSession` |
| `tests/integration/managed-agents-cleanup.test.ts` | The abandoned-session pass over a real DB |
| `CLAUDE.md`, `docs/claude-managed-agents-design.md` | The reconciliation's scope |

## Decisions

- **No retry rather than a smarter retry.** A 429 on a tool result now fails
  the run where the SDK would have re-sent it. Re-sending safely would need the
  engine to read the session's history to learn whether the first send landed;
  failing closed is the behaviour the engine already had for a send it could
  not make. GETs and DELETEs, which are idempotent, keep the SDK's retry.
- **Abandoned is decided by age, not by the run's status.** A segment's wall
  clock runs from the run's start or a person's resume, the session is created
  after that, and a segment stops at `ENGINE_CAPS.WALL_CLOCK_MS` and settles in
  minutes, so the wall clock plus ten minutes proves no live segment can still
  settle it, whatever the run row says. The run's status alone could not: a
  RUNNING run may be on its next segment, and a PAUSED one may never resume.
- **An abandoned session on a keeping connection is recorded KEPT, not
  deleted.** That is what the run's own settle would have written (decision 4),
  and it is what lets a DSAR erasure, which takes KEPT sessions only, reach it.
- **The one reconciliation, no second mechanism.** CLAUDE.md requires it; the
  abandoned pass reuses the seven-day ledger read the lost-delete half already
  makes. A session abandoned more than seven days before a successful
  reconciliation is left to the purge and a connection removal.
- **The lost-create recovery is the purge's own crash-window call**, by the
  pinned agent and this tenant's metadata, then filtered to this run. It never
  lists the workspace.
- **A `session.updated` with only a title or metadata is ignored.** It reaches
  nothing; stopping on it would let anyone with the key stop runs at will
  without widening anything, which they can do by deleting the session anyway.

## Not fixed

Each needs a decision, or evidence only the real workspace of parts 2 to 4 can
give.

1. **The window between `sessions.create`'s answer and the `SESSION_CREATED`
   write.** A process death there leaves a session only the purge and a
   connection removal find. Options: (a) at the start of every segment, list the
   pinned agent's sessions by this run's metadata and settle any the ledger
   does not hold (one list call per segment, and the agent must still be
   readable); (b) the reconciliation lists every recorded agent's sessions for
   the tenant's settled runs (provider calls every day for every tenant); (c)
   accept it, as the window is one database write wide.
2. **A run re-runs, it does not resume.** A dead worker's segment is re-run in a
   new session from the opening message, so tools the first segment ran can run
   again (a second proposal, for instance), and `agent-run-execute` has no
   `jobId` or claim, so a stalled-job redelivery can run one run twice at once.
   Both are properties of the shared run engine, not of this one. Options:
   re-attach to the recorded session when it is still idle, a `jobId` per run,
   or a lease on the run row. An owner decision on the run engine.
3. **Events and edits from someone else with the key.** A workspace admin can
   post `user.custom_tool_result`, `user.message` or `user.tool_confirmation`
   events into the session, or attach resources, and the engine does not tell
   them from its own. The data they could reach is already theirs, but the
   model may act on a result Inflect did not send, and the decision rows'
   digest covers only what Inflect sent. Options: stop on any `user.*` event
   whose id Inflect did not create (needs the real `events.send` answer, to see
   whether it returns ids); before each answer, read the session and compare its
   agent with the recorded one (closes the read-after-answer window of question
   4, still racy); or accept it as the customer's own processor's act
   (decision 5's framing).
4. **The workspace on the run path (#5797).** Options: verify the response's
   `anthropic-workspace-id` on every response in the client's middleware and
   fail closed, which needs part 2's evidence that every endpoint, the event
   stream included, returns it; or rely on Anthropic refusing a mismatched
   header.
5. **Hardening of `managedAgentsRequestRefusal`.** An agent body is checked for
   forbidden members, not against an allowlist (`execution_identity` and
   `description` pass), its `system` is not checked against the preamble, and an
   events POST is not checked for its event types (a `user.tool_confirmation`
   would pass). Inflect sends none of these today, and `agentBodyFor` is pinned
   by test; tightening the middleware would make each a refused request rather
   than a reviewed diff.
6. **Recovering a drifted or Console-archived agent.** `agentDriftedMessage`
   says to approve the version again, but a version already provisioned
   re-provisions nothing (`provision.ts:56-57`), and the next version's update
   names the recorded version, which a Console edit has moved, so Anthropic
   refuses it (`PROVIDER_ERROR`, logged) for every later version, as it does for
   an agent archived in the Console. Only removing and re-enabling the
   connection recovers. Options: provision a NEW agent when the recorded one is
   drifted, archived or ahead of the record; or correct the sentence. Liveness,
   not reach.
7. **The environment is not re-read before a session.** No reach follows from
   an edit (question 4), but the run uses an environment whose networking
   Inflect no longer knows. Options: read it with the agent and refuse
   `ENVIRONMENT_DRIFTED`, or leave it, as nothing can use it.
