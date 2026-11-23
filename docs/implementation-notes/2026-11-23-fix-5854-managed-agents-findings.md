# 2026-11-23 — Managed Agents: findings 1, 3, 5, 6 and 7 of the Step 5H read (#5854)

**Commits:** `88db2998b fix(agents): check Managed Agents request bodies against an allowlist`,
`2e4490861 fix(agents): settle a session a dead segment never recorded, at the next segment's start`,
`94f88dff9 fix(agents): replace an agent edited or archived in the Console at the next approval`,
`639c05725 fix(agents): re-read a Managed Agents environment before each session, and refuse a drifted one`,
and the docs commit that records decision 8 (all `(#5854)`).

## Design

Issue #5854 tracks the seven findings the Step 5H adversarial read
(`docs/implementation-notes/2026-11-23-step-5h-adversarial-read.md`, "Not
fixed") left open. The owner decided on 2026-11-23: findings 1, 5, 6 and 7 are
built now; finding 3 is accepted as a risk; findings 2 and 4 stay open (the
shared run engine, and evidence from a real workspace).

| # | Finding | What is true now |
| --- | --- | --- |
| 1 | A session can go unrecorded | Every segment first lists the pinned agent's sessions with the crash window's own call (`listCrashWindow`), takes those whose metadata names this tenant AND this run and that the run's ledger does not hold (`readRecordedSessionIds`), records them `SESSION_CREATED` and settles them. It is the lost-create recovery of `cae932f30` (`settleUnrecordedSessions`), called from a second place. |
| 3 | Events forged by another key holder | Accepted (decision 8 of `docs/claude-managed-agents-design.md`). The engine-settings page says so in one sentence (`managedAgentsExplainer.keyHolders`, en and bg). No detection is built. |
| 5 | The request allowlist is a denylist in places | `managedAgentsRequestRefusal` checks every POST body against an allowlist of the members the engine writes; an agent's `system` must equal `MANAGED_AGENTS_PREAMBLE` byte for byte; a session events POST may carry only `user.message`, `user.custom_tool_result` and `user.interrupt`, each with its own members. |
| 6 | A drifted or Console-archived agent cannot be recovered | Provisioning reads the profile's agent at its latest version before updating it, and one `agentDrift` does not pass is replaced by a NEW agent; `readProfileAgent` orders by `createdAt`; the `AGENT_DRIFTED` sentence says to approve a new version. |
| 7 | The environment is not re-read before a session | The run reads it after the agent's drift check and compares it with `AgentProfileProvision.environmentHash` (a new nullable column), refusing `ENVIRONMENT_DRIFTED`; a NULL hash is recorded at first use as what Inflect wrote. |

The order inside a segment is now: the kill switch, the run row, skills, caps,
the offer, the transfer gate, **the unrecorded-session look (1)**, the agent's
drift check, **the environment's drift check (7)**, the budget, the session.
The look comes before the drift checks so a segment that drift then refuses
still settles a dead segment's session.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/managed-agents/preamble.ts` | The preamble, in a module with no imports, so the client can compare `system` with it (5) |
| `src/lib/agentic/tool-runner/client.ts` | The allowlists and three refusal codes (5); `GET /v1/environments/{id}` admitted (7) |
| `src/lib/agentic/managed-agents/definition.ts` | Re-exports the preamble; `environmentNormalForm`, `environmentHashOf`, `writtenEnvironmentHash`, `environmentDrift` (7) |
| `src/lib/agentic/managed-agents/execute.ts` | The segment-start look (1); the new `AGENT_DRIFTED` sentence (6); the environment check and its two sentences (7) |
| `src/lib/agentic/managed-agents/store.ts` | `readRecordedSessionIds` (1); `readProfileAgent` by `createdAt` with the recorded hashes (6); `environmentHash` read and `recordEnvironmentHashOnFirstUse` (7) |
| `src/lib/agentic/managed-agents/provision.ts` | Replace an agent that drifted rather than update it (6); record the environment hash (7) |
| `src/app-layer/usecases/agent-profile-provision.ts` | The audit row names the replaced agent and the environment hash |
| `prisma/schema/agentic.prisma`, `prisma/migrations/20261123140000_agent_profile_provision_environment_hash/` | `environmentHash String?` and its shape CHECK |
| `src/app/t/[tenantSlug]/(app)/admin/ai-features/AgentEnginesSection.tsx`, `messages/en.json`, `messages/bg.json` | The decision-8 sentence (3) |
| `tests/helpers/managed-agents-faux.ts`, `scripts/e2e-anthropic-workspace-faux.mjs` | Console edits and archives of agents and environments; the environment read; the session listing (E2E faux) |
| `docs/claude-managed-agents-design.md`, `CLAUDE.md` | Current state, decision 8, the engine's rules |

## Decisions

- **Finding 6 is recovered by the NEXT approval, not by approving the same
  version again.** A version is approved once (`approveAgentProfileVersion`
  requires `SUBMITTED`), and the provision row is unique per (version,
  connection): re-provisioning the version in force in place would either drop
  the old agent's id, which Step 5c's clean-up reads from that row, or keep the
  row's old `createdAt` and so put the new agent inside an open
  `CONNECTION_REMOVED` clean-up's scope, which would archive it. A new row for
  the next version is written now, after any open clean-up's `coversUntil`, and
  the old agent's id stays on the earlier rows. This is the rule CLAUDE.md
  already stated for a removed-then-re-enabled connection; no new verb was
  added.
- **Provisioning decides by reading the agent, not by a flag a run sets.** The
  real API makes every Console edit a new agent version, and the session pins
  the recorded one, so a run of an EDITED agent is usually not refused at all;
  it is the next update that Anthropic refuses (409). Reading the agent at its
  latest version before an update catches the edit and the archive whether or
  not a run saw them.
- **The environment's first-use hash is what Inflect WROTE, not what the run
  read.** The brief recommended that a run with a NULL hash be allowed and
  record it on first use. Recording what was read would make a Console edit
  made before that first run the baseline every later run compares with, which
  is the defect finding 7 is about. `environmentBodyFor` has not changed since
  Step 5b, so the hash of its body IS what was written; a NULL row is not
  refused for being NULL, and an edited environment is refused on that first
  run as on any other.
- **The environment's normal form reads what can widen reach, and only that.**
  Networking type, allowed hosts, the two `allow_*` switches and every package
  list, with Anthropic's defaults made equal to Inflect's omissions; and any
  member Anthropic adds that holds something, so a new switch turned on is a
  change while a new default left empty is not. Names, descriptions and
  metadata are not compared, so renaming the environment in the Console does
  not stop runs.
- **An archived environment cannot be recovered in the product, and the
  sentence says so.** Inflect makes one environment per connection (the
  Integrations card says so), and a re-enabled connection reuses its first
  environment. Making a second environment would change what the card tells
  the customer, which is an owner's call, not this fix.
- **The segment-start look never blocks the run.** A listing that fails, or a
  ledger longer than one read (`RUN_SESSION_STEPS_READ_CAP`), leaves the
  session to the purge and a connection removal, as before. It skips sessions
  the ledger already names, so an earlier segment's KEPT or failed-delete
  session stays with the settle and the reconciliation that own it; the
  lost-create path gains the same filter.
- **The session and environment bodies are allowlisted too.** The finding named
  agents and events, but the session's top level (`title` passed) and the
  environment's (`description` passed) were denylists of the same kind; the same
  helper closes them.
