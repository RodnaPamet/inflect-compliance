# 2026-10-30 — Organizations flip the agent profile and Tool Runner switches

**Commit:** see the PR closing #4557.

## Design

`AGENT_PROFILES` and `AGENT_DRIVER_TOOL_RUNNER` were deployment-wide booleans.
The owner asked for both to be flippable per organization from the org admin
page, with the deployment able to veto (decisions of 2026-10-30):

```
env value          effect
1 / true           on for every workspace
any other value    off for every workspace (the veto; a typo vetoes too)
unset              the workspace's organization decides
                   (no organization: off, as before)
```

`AGENT_PROFILES_TENANTS` keeps opening the slugs it names, ahead of the veto,
because it is the operator's own narrower instruction and read that way before.

Three layers:

- `src/lib/agentic/agent-switches.ts` — the pure rule (`readDeploymentSwitch`,
  `resolveAgentSwitch`, `switchActor`). No server imports, so the org page and
  the engines page hold the same rule the server enforces.
- `src/lib/agentic/agent-switches-policy.ts` — the only reader:
  `agentProfilesDecisionFor(slug)` and `toolRunnerDecisionFor({tenantId|tenantSlug})`.
  It reads `Organization` through the workspace's own row, and only when the
  deployment left the switch open.
- `usecases/org-agent-switches.ts` + `GET/PUT /api/org/:slug/agent-switches` +
  `/org/:slug/settings` — the organization's write path. The PUT is
  `requireOrgPermission('canManageAgentSwitches')` (ORG_ADMIN), audited
  `ORG_AGENT_SWITCHES_CHANGED` with the before and after of each switch that
  moved and the deployment's state at the time.

Every former reader of the variables moved onto the policy: the profile route
gate, the profile usecases and test-run admission, the agent page's Behaviour
tab, `resolveDriverForTenant` on the run path, `getAgentDriverSetting` and the
`flue-wiring` checklist. `agentProfilesEnabled` / `agentProfilesEnabledFor`
were deleted rather than kept, so no synchronous env-only reader survives.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/auth.prisma`, `enums.prisma`, migration `20261030120000_org_agent_switches` | Two `Organization` booleans (default false), one `OrgAuditAction` value |
| `src/lib/agentic/agent-switches.ts` | The pure three-state rule |
| `src/lib/agentic/agent-switches-policy.ts` | The one reader of env + organization |
| `src/app-layer/usecases/org-agent-switches.ts` | Org read and write, audited |
| `src/app/api/org/[orgSlug]/agent-switches/route.ts` | GET (portfolio viewers), PUT (`canManageAgentSwitches`) |
| `src/app/org/[orgSlug]/(app)/settings/*` | The org Settings page and its section |
| `src/lib/permissions.ts` | `OrgPermissionSet.canManageAgentSwitches` |
| `src/lib/agentic/agent-driver-policy.ts`, `agent-profile-flag.ts`, `usecases/agent-profiles.ts`, `agent-profile-runs.ts`, `agent-driver-setting.ts`, `flue-wiring.ts` | Readers moved onto the policy |
| `admin/ai-features/agent-engine-display.ts`, `AgentEnginesSection.tsx` | The engines page names the organization when it holds the switch |

## Decisions

- **Defaults false, so nothing moves on deploy.** With every organization off,
  an unset variable still means off for every workspace, exactly as before.
- **The write is allowed while the deployment overrides it.** The page says the
  choice changes nothing today and applies once the variable is unset. A refusal
  would leave an admin unable to prepare a rollout.
- **The run path reads the organization only when the variable is unset.**
  `resolveDriverForTenant` still short-circuits without a query when Flue is off
  and the Tool Runner variable is a veto. A failed organization read is OFF,
  with a WARN: the switch grants, so its safe end is closed.
- **`basis` travels with the Tool Runner's availability** on the engines
  payload, so the headline and the checklist name the organization, not the
  operator, when the organization holds it. An operator cannot help a
  workspace whose organization left the engine off.
- **One `ADD VALUE` deploy for the audit action**, on the
  `ORG_TENANT_DELETED` precedent: only new code writes it, and an old container
  meets it only if an admin flips a switch inside the roll.
- **The sub-processor note changed.** The Anthropic row said the Tool Runner
  runs only where the operator sets the variable. With it unset, an org admin
  plus a workspace owner can now make it run; `docs/sub-processors.md` says so.
- **ORG_OWNER is the next step** (#4557's follow-up). Today ORG_ADMIN holds
  `canManageAgentSwitches`; the owner role, when it lands, holds it too.
