# 2026-11-24 — Step 6b: the hosted Managed Agents path, behind a constant that is false

**Commit:** see the branch `feat/feat-6b-hosted-managed-agents` for issue #4172
(Step 6b of `docs/claude-managed-agents-design.md`, shape MA-C1). The Step 6a
notice (#5842) was issued on 2026-11-24; its objection window closes on
2026-12-24, so nothing here may let tenant data reach Inflect's organisation.

## Design

```
HOSTED_MANAGED_AGENTS_ACTIVE = false            (hosted-activation.ts, a leaf: imports nothing)
        │
inflectHostedWorkspace()  ── the key's ONE reader; first statement:
        │                    if (!ACTIVE) return HOSTED_NOT_ACTIVE   ← before env is read
        ▼
resolveManagedAgentsWorkspace(ctx)               (workspace.ts, the ONE resolution)
   own anthropic-workspace connection?  one → TENANT
                                        ambiguous / unreadable → refuse (never falls back)
                                        none → Inflect's workspace when, in order:
                                               ACTIVE · CONFIGURED (env pair) · OPTED_IN
                                               · residency ≠ LOCAL_ONLY · ENTITLED
                                               else the first that failed, by name
   asked by: the driver, provisioning, and (key-free twin) the engine setting
        │
driver ── provision? archived? ── HOSTED → claimHostedSlot ── managedAgentsClientFor (unchanged)
                                            │
                     hosted_managed_agents_claim_slot()  SECURITY DEFINER, one advisory lock:
                     count RUNNING runs with a live lease and hostedManagedAgents,
                     per tenant (cap 1) and per deployment (cap 2) → CLAIMED / refuse

opt-in  ── PUT admin/hosted-managed-agents (requirePermission admin.tenant_lifecycle)
           setHostedManagedAgentsOptIn: OWNER key, a person, audited;
           opt-in refused unless offered/entitled/not LOCAL_ONLY; opt-out → 5c clean-up

clean-up ── readCleanupConnections adds Inflect's workspace (id 'inflect-hosted') for a
            tenant with a hosted footprint; purge record of it stays OPEN and is retried;
            the reconciliation enumerates hosted tenants; a DSAR erasure skips it
```

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/managed-agents/hosted-activation.ts` | `HOSTED_MANAGED_AGENTS_ACTIVE = false`, a leaf module |
| `src/lib/agentic/managed-agents/workspace.ts` | `inflectHostedWorkspace` (the key's one reader), `resolveManagedAgentsWorkspace`, `readManagedAgentsWorkspaceState`, `INFLECT_HOSTED_CONNECTION_ID` |
| `src/lib/agentic/managed-agents/hosted-capacity.ts` | the two caps and `claimHostedSlot` |
| `src/lib/agentic/managed-agents/driver.ts` | asks the resolution; claims a hosted slot; names every hosted refusal |
| `src/lib/agentic/managed-agents/execute.ts` | `workspaceKind` on the route, the `SESSION_CREATED` step and each `MODEL_CALL` step |
| `src/app-layer/usecases/agent-profile-provision.ts` | provisions through the resolution |
| `src/app-layer/usecases/agent-driver-setting.ts`, `flue-wiring.ts`, `ai-features/agent-engine-display.ts` | a `HOSTED` workspace satisfies the engine choice |
| `src/app-layer/usecases/hosted-managed-agents-opt-in.ts`, `src/app/api/t/[tenantSlug]/admin/hosted-managed-agents/route.ts` | the opt-in's one writer and its route |
| `src/app/t/[tenantSlug]/(app)/admin/ai-features/HostedAgentsSection.tsx`, `messages/{en,bg}.json` | the owner's section, in plain words |
| `src/app-layer/usecases/managed-agents-cleanup.ts` | Inflect's workspace in purge, opt-out, reconciliation; DSAR skips it |
| `src/lib/billing/entitlements.ts` | `GatedFeature` `hostedManagedAgents`, granted to no plan |
| `src/env.ts` | `AGENT_MANAGED_AGENTS_HOSTED_WORKSPACE_ID`, `AGENT_MANAGED_AGENTS_HOSTED_API_KEY` |
| `prisma/migrations/20261124140000_hosted_managed_agents/` | the opt-in column, the run's slot column and index, the claim function, two cleanup CHECKs |

## Decisions

- **The constant is asked inside the key's reader, not only at the resolution.**
  Every path to Inflect's key (a run, provisioning, the clean-up, the
  reconciliation, the settings page) goes through `inflectHostedWorkspace`, so
  one first statement closes all of them, and a guard can pin it by reading one
  function. The resolution does not read the tenant's terms either while it is
  false.
- **A tenant's own connection that cannot be used refuses; it never falls back**
  to Inflect's workspace. Falling back would move the tenant's data to a
  processor it did not choose because its own key was mistyped.
- **Hosted records carry the fixed connection id `inflect-hosted`.**
  `AgentProfileProvision.connectionId` and `ManagedAgentsCleanup.connectionId`
  are plain ids with no FK, so Inflect's workspace needs no
  `IntegrationConnection` row, and every per-connection rule of 5b to 5d (the
  provision lookup, the archived check, the clean-up scope) applies unchanged.
  Each tenant gets its own environment there, named by that id.
- **Opting in is refused unless the deployment can honour it** (offered,
  entitled, not `LOCAL_ONLY`); opting out is always allowed. So while the
  constant is false no workspace can opt in, and the opt-in a customer reads is
  one that runs. The run's resolution asks every term again.
- **Opting out is a `CONNECTION_REMOVED` clean-up under `inflect-hosted`.** That
  reuses 5c's record and its scope rule, so a later re-opt-in reads the old
  provisions as archived and provisions new agents, as a re-enabled connection
  does.
- **A run over a cap is refused, not held.** Holding would keep a worker and its
  run lease busy doing nothing; re-enqueueing the segment would be dropped by
  BullMQ, because #5900 names each segment's job by the instant that authorised
  it. A refusal settles before any client exists, with a named reason.
- **The count is the run lease's own "executing".** RUNNING with a live lease on
  the database's clock; a slot is never released by hand, so a dead worker
  cannot leak one (its lease lapses in 60 s). A hosted run with no lease is
  refused. The count is a SECURITY DEFINER function, as #5187's are, so it sees
  every tenant's runs under `app_user` while returning counts only, and it
  checks that the caller's tenant context names the run's tenant.
- **Caps 1 and 2.** The binding limit is the Environments API's five concurrent
  requests per organisation, and every segment reads its environment before its
  session; production and staging are two deployments of one organisation.
  Source constants, so raising one is a reviewed diff.
- **The purge of Inflect's workspace is retried.** Decision 7's one attempt and
  its terminal `PURGED_KEY_DESTROYED_UNFINISHED` follow from destroying the
  customer's key with the tenant's rows. Inflect's key is deployment
  configuration that no purge destroys, and its intent (keep no customer key)
  is untouched, so an unfinished hosted purge record stays `OPEN` and
  `data-lifecycle` retries it from the ids it carries (the tenant's provisions
  are gone by then, so the retry now reads the record's `pendingAgentIds` too).
  Two CHECKs hold both halves. With the constant false such a record cannot be
  opened, and ends `ABANDONED` with the alert after 30 days.
- **A DSAR erasure skips Inflect's workspace**: it takes KEPT sessions only, and
  a hosted session is never kept. A failed hosted delete is the
  reconciliation's, which now enumerates hosted tenants from their provisions.
- **No plan is entitled.** `hostedManagedAgents` is a yes/no `GatedFeature`
  beside `PLAN_LIMITS`, false for every plan, ENTERPRISE (and so self-hosted)
  included. Which plans get it is the owner's product decision.
- **Usage per tenant reuses what exists.** The run is marked
  `hostedManagedAgents`; its `costTokens` and each span-derived `MODEL_CALL`
  step (now carrying `workspace`) are the per-tenant record. No new table or
  metric. Session-hours are not recorded separately.
- **The settings section renders nothing until hosting is offered**, and always
  renders for a workspace that opted in, so it can opt out.
