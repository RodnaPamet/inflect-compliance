# 2026-11-25 — The Managed Agents switch moves to the workspace (#5964)

**Commit:** `feat(agents): the Managed Agents switch is the workspace's (#5964)`

## Design

Owner decisions of 2026-11-25:

1. A per-workspace toggle on Admin → AI features, OWNER-only, a person only,
   audited, effective at once.
2. `AGENT_MANAGED_AGENTS` becomes the operator's override, in the three states
   of the other agent switches: unset leaves it to the workspace, `1`/`true` is
   on everywhere, anything else is off everywhere.
3. Off stops runs and keeps the set-up.

```
AGENT_MANAGED_AGENTS ──readDeploymentSwitch──┐
                                             ├─ resolveWorkspaceAgentSwitch ─► { on, basis }
TenantSecuritySettings.managedAgentsEnabled ─┘   (pure, agent-switches.ts)
          (read only while the variable is UNSET)

managedAgentsDecisionFor({tenantId}|{tenantSlug})   (agent-switches-policy.ts, the one reader)
   ├─ resolveDriverForTenant      the run gate (and both short-circuits)
   ├─ getAgentDriverSetting       the Agent engines section, with `basis`
   ├─ listAvailableProvidersFor   the integrations page's provider list
   ├─ upsert / testConnection     refused MANAGED_AGENTS_OFF for anthropic-workspace
   ├─ resolveRunDefinition        a new profile run on the engine: MANAGED_AGENTS_OFF
   ├─ executeQueuedWorkflowRun    a queued segment: FAILED managed_agents_off
   ├─ resumeWorkflowRun           a person's resume: MANAGED_AGENTS_OFF, run left paused
   └─ get/setManagedAgentsSwitch  the section's own read and the one writer
```

The provider registry is per process, so it can no longer be the gate:
`AnthropicWorkspaceProvider` is registered unconditionally and the per-tenant
gate moved to the three integration usecases. Nothing else reaches the
provider: it declares no checks (the automation runner resolves by check key),
its connection carries no webhook signing secret (a webhook delivery fails
verification, as for every other provider without one), and the clean-ups read
the connection row directly.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/auth.prisma`, migration `20261125150000_managed_agents_workspace_switch` | `TenantSecuritySettings.managedAgentsEnabled Boolean @default(false)` |
| `src/lib/agentic/agent-switches.ts` | `WORKSPACE_ON` / `WORKSPACE_OFF` bases, `resolveWorkspaceAgentSwitch`, `switchActor` → `tenant` |
| `src/lib/agentic/agent-switches-policy.ts` | `managedAgentsDecisionFor`, `managedAgentsOnFor`, `managedAgentsDeployment` |
| `src/lib/agentic/managed-agents-switch.ts` | Rewritten: the `MANAGED_AGENTS_OFF` refusal and `assertManagedAgentsOn` (the old env reader is gone) |
| `src/lib/agentic/agent-driver-policy.ts` | The run gate asks the decision; the first short-circuit fires only on `OFF` |
| `src/app-layer/usecases/managed-agents-switch.ts` | The one writer of the column, and the section's read |
| `src/app/api/t/[tenantSlug]/admin/managed-agents/route.ts` | GET `admin.view`, PUT `admin.tenant_lifecycle` |
| `src/lib/security/route-permissions.ts` | The two method-scoped rules |
| `src/app-layer/integrations/bootstrap.ts` | The provider is always registered |
| `src/app-layer/usecases/integrations.ts` | `listAvailableProvidersFor`; save and Test refused by name |
| `src/app-layer/usecases/agent-profile-runs.ts`, `workflow-runs.ts` | Admission, the worker and resume refuse by name |
| `src/app-layer/usecases/agent-driver-setting.ts`, `flue-wiring.ts` | Report the decision's `basis`; the ENV term's actor follows it |
| `src/app/t/[tenantSlug]/(app)/admin/ai-features/ManagedAgentsSwitchSection.tsx` | The section, above Agent engines |
| `src/app/t/[tenantSlug]/(app)/admin/ai-features/agent-engine-display.ts`, `AgentEnginesSection.tsx` | A workspace-held OFF names the owner, not the operator |
| `messages/en.json`, `messages/bg.json` | `admin.managedAgentsSwitch.*`, two engine sentences, the audit action label |
| `tests/guards/managed-agents-switch-single-reader.test.ts` | One reader of the variable and the column |
| `src/app-layer/jobs/managed-agents-provision-on-switch-on.ts`, `jobs/types.ts`, `jobs/executor-registry.ts` | The switch-on provisioning job (on demand, one attempt) |

## Decisions

- **A queued or paused run of a now-disabled workspace is refused, by name.**
  The worker FAILS a queued segment (`managed_agents_off: …`) rather than run it,
  and rather than let the gate move it to the built-in engine, which would
  settle a profile run with the static engine's placeholder answer. A person's
  resume is refused with `MANAGED_AGENTS_OFF` before anything is claimed, and
  the run stays PAUSED / AWAITING_APPROVAL, so turning the switch back on lets
  it resume. A segment already executing is not interrupted: the switch stops
  what has not started. A session an earlier segment left open is settled by
  the session reconciliation, which never asks the switch.
- **The refusal at admission is in `resolveRunDefinition`, not after the gate.**
  Without it, admission resolved STATIC and refused
  `PROFILE_NEEDS_REASONING_ENGINE`, a name that says nothing about why. It is
  asked only when the workspace chose the engine, so no other run pays the read.
- **Switching it on provisions what was approved while it was off** (owner
  decision 2026-11-25, #5964 comment 7162402419). A write that moves the switch
  from off to on enqueues `managed-agents-provision-on-switch-on` after the
  write and its audit row have committed. The job re-reads the owner who turned
  it on (`resolveMemberContext`, still holding `admin.tenant_lifecycle`) and
  runs `provisionProfilesInForce`, which calls the approval's own
  `provisionApprovedProfileVersion` for every profile's version in force
  (agents not RETIRED, at most 200 profiles, a truncation recorded). It
  provisions nothing, without failing, when the switch is off again, no usable
  Anthropic workspace exists, or the workspace has not chosen the engine. It is
  idempotent because `provisionManagedAgent` returns an existing record for a
  version already provisioned in the workspace. Every outcome, a failure
  included, is logged and written as `MANAGED_AGENTS_PROFILES_PROVISIONED`, and
  the job result is ERROR when a version failed; nothing it does touches the
  switch. An enqueue that fails is caught, logged and recorded
  (`ENQUEUE_FAILED`), and the switch stays on.
- **A job, not inline.** Each version is up to three calls to the customer's
  Anthropic workspace (environment, retrieve, create or update), and a
  workspace can hold many profiles, so inline it would hold the owner's request
  for as long as the slowest answer, past the request timeout. One attempt,
  not BullMQ's retries: a provider failure between creating an agent and
  recording it would create a second agent on an automatic retry; turning the
  switch off and on again re-runs it, idempotently.
- **The engine cannot be chosen while the switch is off** (the same owner
  decision). `setAgentDriverSetting` refuses a move to `MANAGED_AGENTS` with
  409 `MANAGED_AGENTS_OFF` and the basis, before anything is written. A stored
  choice made while it was on is kept when it goes off, and moving away from it
  is always allowed.
- **Writes are accepted in every deployment state**, as an organization's
  switches are; the section disables its button when the operator decides and
  says what the saved choice will do once they stop. The audit row records the
  override and the effective answer before and after, so a write that changed
  nothing that runs is visible as such.
- **One error, `ConflictError` 409 with `reason: MANAGED_AGENTS_OFF` and the
  basis**, for every refusal, with a sentence naming who can change it (the
  owner, or the operator for `DEPLOYMENT_OFF`).
- **No backfill.** With the variable unset no workspace could reach the engine
  before the column existed, so `false` keeps every workspace where it was;
  with it set, the column is not read.
- **Approval while off provisions nothing**: provisioning asks
  `resolveDriverForTenant`, which answers static. The switch-on job above is
  what provisions such a version, so nothing is created at Anthropic for an
  engine the owner turned off.
- **The org switches' `AGENT_SWITCHES` list is unchanged.** It is what an
  organization's settings page writes, and this switch is not an organization's.
