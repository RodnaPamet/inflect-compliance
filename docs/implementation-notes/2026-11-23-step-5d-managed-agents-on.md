# 2026-11-23 — Step 5d: turn the Managed Agents engine on

**Commit:** see the branch `feat/feat-4167-managed-agents-on` for issue #4167
(Step 5d of `docs/claude-managed-agents-design.md`). The flag flip is a commit
of its own.

## Design

Production ran `960503a11` (the Step 5c merge, which carries 5b's READ_ONLY
`MANAGED_AGENTS`) on 2026-11-23T08:15Z, so the value may be written. Decisions 3
(a weaker, span-derived Art 12 row) and 4 (sessions deleted at settle unless
the connection keeps them) are recorded as decided, and 7 (the purge keeps no
key) is too.

```
Admin → AI features                         setAgentDriverSetting(MANAGED_AGENTS)
  listed while AGENT_MANAGED_AGENTS on  ──▶   exactly one enabled anthropic-workspace?
  offered while workspace CONNECTED            no  → 409 MANAGED_AGENTS_NO_WORKSPACE / _AMBIGUOUS_WORKSPACE
  explainer (decisions 3 and 4)                yes → stored, audited as a grant with the engine's terms

approve version ──▶ provisionApprovedProfileVersion ── resolveDriverForTenant = managed-agents
                                                        (reads every switch before its short-circuit)
                     readProfileAgent skips archived ─▶ agents.create / agents.update

Test run (approved version only) ──▶ resolveRunDefinition: def.driver = profileEngineRequestFor(stored mode)
                                  ──▶ selectRunDriver ∩ gate ──▶ worker: resolvePinnedRunDefinition
                                                                   def.driver = profileEngineRequestFor(recorded driver)
                                  ──▶ runManagedAgentsDriver: provision archived? → managed_agents_agent_archived
                                  ──▶ session … deleted (or KEPT) ──▶ timeline marks span-derived rows
```

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/agent-driver.ts` | `MANAGED_AGENTS` writable; `DRIVER_IMPLEMENTED['managed-agents']` true (its own commit) |
| `src/lib/agentic/agent-driver-policy.ts` | the short-circuits read the Managed Agents switch; the reporting narrowing asks the profile surface |
| `src/app-layer/usecases/agent-driver-setting.ts` | the engine's terms in the read; the named refusal without exactly one workspace |
| `src/app-layer/usecases/flue-wiring.ts` | the engine's six-term checklist, `WORKSPACE` among them |
| `src/lib/agentic/agent-profile.ts`, `src/app-layer/usecases/agent-profile-runs.ts` | a profile asks for the engine its workspace chose; the worker for the one its run recorded |
| `src/app-layer/usecases/agent-profiles.ts`, `agents/[agentId]/tabs/*` | Test-run state for the engine; the approved version only |
| `src/lib/agentic/managed-agents/store.ts`, `driver.ts` | the workspace state read; an archived provision; `managed_agents_agent_archived` |
| `src/lib/agentic/tool-runner/client.ts` | `managedAgentsOrigin`: the 5a E2E seam extended to the engine's client |
| `src/lib/agentic/run-step-projection.ts`, `agents/runs/[runId]/AgentRunDetailClient.tsx` | the span-derived label |
| `src/app/t/[tenantSlug]/(app)/admin/ai-features/*` | the engine on the settings page, with its explanation |
| `messages/en.json`, `messages/bg.json` | the copy |
| `scripts/e2e-anthropic-workspace-faux.mjs` | the faux now holds agents, environments and sessions per workspace id |
| `tests/e2e/managed-agents-engine.spec.ts`, `tests/e2e/run-queued-agent-run.ts` | the E2E, and the one-run executor it calls |

## Decisions

- **The flip is one line, and the tests do not pin it.** Every test that read
  the flag now asserts against `DRIVER_IMPLEMENTED['managed-agents']`, or is
  skipped while it is false (the live-engine integration suite), so reverting
  the flip commit is the whole rollback and leaves the suite green.
- **A profile asks for the chosen engine, not the Tool Runner always.** Profile
  definitions asked for `tool-runner` unconditionally, so a workspace on
  Managed Agents would have been refused `PROFILE_NEEDS_REASONING_ENGINE`.
  Admission reads the stored mode; the worker reads the RECORDED driver, so a
  change of engine between admission and the worker does not move a queued run
  to another engine.
- **The resolver's short-circuit was a latent block.** With Flue and the Tool
  Runner off, `resolveDriverForTenant` answered `ENV_DISABLED` before reading
  the tenant, whatever `AGENT_MANAGED_AGENTS` said; and the settings read did
  not pass that switch to the gate at all. Both are fixed.
- **Re-enabling a removed connection: refuse, and re-provision on the next
  approval.** The smaller safe option. A provision is archived when a
  `CONNECTION_REMOVED` record of its connection covers it, by the clean-up's own
  rule (`coversUntil >= createdAt`). Re-provisioning the version in force in
  place was rejected: the row is unique per (version, connection), and
  rewriting it either loses the archived agent's id from the record or, kept
  with its old `createdAt`, puts the new agent inside an open clean-up's scope,
  which would then archive it. Automatic re-provisioning at run time was
  rejected too: it would put agent writes on the run path. The remedy is named
  in the refusal: approve a new version.
- **A Test run tries the approved version only** on this engine, because
  approval is what provisions. Provisioning a version under review would put an
  unapproved tool set on the customer's agent; refusing by name before a run row
  exists is the smaller change. Whether a reviewer should be able to try a
  version on this engine before approving it is left open.
- **The timeline reads the step, not the decision row.** The engine writes the
  MODEL_CALL step (`spanDerived`, `inputBasis: 'INFLECT_SENT'`) and the
  `anthropic-managed-agents:span-derived` row in one handler. The projection is
  pure and shared by the page, the feed and the live tail, so reading the step
  labels every surface without a join to `AiDecisionLog`.
- **The E2E seam.** `managedAgentsOrigin` returns the loopback faux only when
  `NEXT_TEST_MODE` and `AUTH_TEST_MODE` are both `1`, as 5a's Test does, and the
  client's middleware pins whichever origin the client was built for. No tenant
  value names a host. The harness runs no worker, so the spec runs the queued
  run once with `runAgentRunExecute`, in a child process carrying the same two
  flags; it is the job body the worker would call, for that run id only.
- **Known limit, not fixed here: #5802.** A DSAR erasure reaches only tenants
  named by the person's own audit rows, so a tenant where they never acted keeps
  any KEPT session. The fix needs the erasure's operator entry point, which does
  not exist yet. The engine page does not mention erasure at all, so the limit
  is recorded here and in `CLAUDE.md` rather than on the page.
- **`AGENT_MANAGED_AGENTS` stays off in production.** #5797 (whether Anthropic
  returns `anthropic-workspace-id` on `GET /v1/agents`) blocks turning it on, and
  no deployment file changes in this step.
