# 2026-10-18 — Agent owner-orphan pass and credential hygiene (agentic IAM 2b)

**Commit:** `feat(agentic): owner-orphan pass and agent credential hygiene (2b)` (#3670)

## Design

UC2's second leaver direction: when a PERSON leaves, the agents they own stop.
And a daily pass that reports weak agent credentials.

```
04:00  hris-sync-dispatch          Employee.status
05:00  identity-leaver-dispatch    the person's own directory accounts
05:15  agent-owner-orphan-pass     the agents the person owned
06:00  agent-credential-hygiene    findings for weak agent credentials
```

**Orphan pass.** Per tenant (discovered: any live non-placeholder agent, or a
non-DISABLED mode), one transaction reads the ACTIVE agents, their owners'
memberships and addresses, and the HR roster (one past a 10 000 cap). The pure
module `lib/agentic/owner-orphan.ts` decides each owner: no ACTIVE membership
(DEACTIVATED / REMOVED / INVITED / ABSENT), or exactly one `Employee` on the
owner's `emailKey` that is TERMINATED. Then, by the tenant's mode:

- DISABLED → a `MODE_DISABLED` row, nothing evaluated.
- DRY_RUN → one NOT_APPLICABLE row listing every orphan with its signals, and an
  `AGENT_OWNER_DEPARTED` bell to the ACTIVE OWNERs (minus the departed owner).
- AUTOMATIC → per orphan: `engageOwnerDepartedKill` (kill first: it stops runs in
  flight), `suspendAgentForOwnerDeparture`, a transfer task for the manager when
  one is known (once per kill engagement), the bell; one PASSED/PARTIAL row.

The lift side: `liftKillSwitch` refuses an OWNER_DEPARTED kill until a COMPLETED
`AgentOwnershipTransfer` of the agent completed after the kill, and admits only
the agent's current owner, who must be that transfer's recipient. A trigger holds
the same rule beneath the usecase, and a CHECK pins the code to the system actor.

**Hygiene.** Per tenant (discovered: unrevoked keys, `mcp-server` connections, or
open hygiene findings), one transaction reads every live key, every `mcp-server`
connection (grant kind via `resolveMcpCredentials`, kind kept, secret dropped)
and the open hygiene findings; the pure planner `lib/agentic/credential-hygiene.ts`
returns assert / resolve / hold; the usecase creates, reopens and closes
`Finding` rows through `FindingRepository` and writes one execution row.

## Files

| File | Role |
|---|---|
| `prisma/migrations/20261018090000_agent_owner_departed_notification/` | `AGENT_OWNER_DEPARTED` notification type, alone, `IF NOT EXISTS`, `BEFORE 'GENERAL'` |
| `prisma/migrations/20261018090100_agent_owner_orphan_pass/` | mode columns; `AgentKillSwitch.reasonCode`; CHECK; lift/immutability trigger |
| `src/lib/agentic/owner-orphan.ts` | departure signals, HR match, row status, constants (actor, automation key, ceiling) |
| `src/lib/agentic/credential-hygiene.ts` | the five rules and the reconcile planner |
| `src/app-layer/usecases/agent-owner-orphan-policy.ts` | the mode: read (coerced), refusal, set (audited) |
| `src/app-layer/usecases/agent-owner-orphan-pass.ts` | the pass and its execution rows |
| `src/app-layer/usecases/agent-credential-hygiene.ts` | the hygiene pass |
| `src/app-layer/usecases/agent-kill-switch.ts` | `engageOwnerDepartedKill`; the lift precondition; `reasonCode` on the record |
| `src/app-layer/usecases/agent-registry.ts`, `repositories/RegisteredAgentRepository.ts` | `suspendAgentForOwnerDeparture`, `suspendIfActive` |
| `src/app-layer/jobs/agent-owner-orphan-pass.ts`, `jobs/agent-credential-hygiene.ts` | the sweeps |
| `src/app-layer/jobs/{schedules,types,executor-registry}.ts` | 05:15 and 06:00, one attempt each |
| `src/app/api/t/[tenantSlug]/admin/agents/owner-orphan-pass/route.ts` | GET/PUT the mode, `admin.tenant_lifecycle` |
| `src/lib/agentic/report-definitions.ts`, `usecases/agent-governance-reports.ts`, `lib/agentic/pack-document.ts` | OWNER_DEPARTED kills counted apart |
| `src/app-layer/notifications/agentic.ts` | the bell's copy |
| `src/lib/observability/integration-metrics.ts` | outcome counters for both passes |
| `src/app-layer/usecases/integrations.ts` | agentic rows excluded from the control-check list |

## Decisions

- **The reason code is a column, not the reason text.** The issue says the kill
  carries "reason OWNER_DEPARTED", and `reason` is free text a person types. A
  kill identified by its text could be forged into one excluded from incident
  counts and unliftable without a transfer. So the code is `reasonCode`, pinned
  by CHECK to the system actor; the text also begins `OWNER_DEPARTED` for the
  operator surface, and nothing reads it.
- **The audit rows carry no user.** `buildSystemContext`'s principal is the
  `system` sentinel, which the audit seam maps to NULL, with `actorType: 'JOB'`.
  The kill row's own `engagedByUserId` is the named system actor; the audit row
  carries it in `detailsJson.after`. A principal of `system:agent-owner-orphan-pass`
  on the context itself would fail `AuditLog.userId`'s foreign key.
- **ABSENT and INVITED are departures.** The issue names DEACTIVATED and REMOVED;
  the product's Remove action deletes the membership row, so a REMOVED status is
  rarely there to read. INVITED is included for the same fail-closed reason —
  accountability needs an active member. Both are recorded by name.
- **The lifter must be the new owner**, not any holder of the kill key. Q6 says
  "the new owner lifts it with a reason"; a holder of the key who is not the new
  owner is refused. A new owner holding the transfer key but not the kill key
  (an ADMIN with a narrow custom role) cannot lift until given it — the narrower
  reading, on purpose.
- **Every refusal writes a row, including DISABLED.** The issue's checklist
  requires it, and it closes the "a DISABLED tenant looks like a dead worker"
  gap the identity leaver carries. One small row per tenant per day.
- **DRY_RUN rows are NOT_APPLICABLE** ("record each orphan as a NOT_APPLICABLE-
  style execution row"), and still count towards the dwell's one-pass evidence.
- **Hygiene's rotation age is a 90-day default.** No tenant setting exists. Skipping
  the rule would make an unrotated key look compliant, so the conservative
  option is to apply a stated default and say so on every row.
- **Hygiene's "no named owner" fires on every app-only connection** because no
  owner column exists (passport P11); step 2d gives it a source.
- **06:00 is shared with the kill-switch drill**, the issue's stated time. The
  drill's 06:00 exists to keep its finding out of the identity chain's minutes;
  hygiene is not in that chain, and neither job reads what the other writes.
- **No blast-radius breaker on automatic kills.** The leaver has one for
  directory disables. Here stopping is the security-conservative direction and
  reversible by transfer; whether a mass-departure breaker is wanted is left to
  the owner.
- **One task per kill engagement.** A kill already in force (a person's, or an
  earlier pass's) opens no second task.
