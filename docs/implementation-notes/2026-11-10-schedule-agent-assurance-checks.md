# 2026-11-10 — Scheduling the four agent assurance checks (#5014)

## Design

The register's Assurance section reads each agentic check's newest
`ControlTestRun` from any plan whose `automationConfig` names the check. The
checks, their handler and the runner had existed since 2026-09-06, but no path
in the product wrote that config. The test-plan editor preserves
`automationConfig` and never sets it. So every tenant read "never run" for all
four checks, indefinitely.

```
register  "Schedule these checks"
   │  POST /admin/agents/assurance-checks {apply:false}  → dry run: check → control
   │  POST … {apply:true}
   ▼
setUpAgentAssuranceChecks (usecases/agent-assurance-checks-setup.ts)
   │  per AGENTIC_CHECK_IDS without a plan:
   │    createTestPlan(ctx, control)  →  scheduleTestPlan(ctx, plan,
   │        INTEGRATION, '40 6 * * *' UTC, { check })
   ▼
control-test-scheduler (5 min tick) → control-test-runner → agentic handler
```

The setup copies the audit pilot's setup (`audit-pilot-setup.ts`):
- It is a dry run by default.
- Every write goes through the existing usecase under the caller's context, so it hits the same refusals and writes the same audit rows.
- It is idempotent: a plan that already exists is UNCHANGED, or DIFFERS when somebody has re-scheduled it, and it is never overwritten.
- Every named refusal is decided before the first write.

## Files

| File | Role |
|---|---|
| `src/app-layer/usecases/agent-assurance-checks-setup.ts` | The setup: maps each check to its control, then reports or writes |
| `src/app-layer/schemas/agent-assurance-checks.schemas.ts` | `.strict()` body: `apply`, optional `controls` |
| `src/app/api/t/[tenantSlug]/admin/agents/assurance-checks/route.ts` | `POST`, `admin.agent_registry` |
| `src/app-layer/usecases/agent-registry.ts` | `AgenticCheckStatus.scheduled` |
| `src/app/t/[tenantSlug]/(app)/agents/AgentsClient.tsx`, `page.tsx` | "not scheduled" vs "never run"; the setup button, offered only where the server takes it |

## Decisions

- **Daily at 06:40 UTC** (owner decision, 2026-11-10). The drill check reads the newest `AgentKillSwitchDrill`, and the drill runs at 06:00, so 06:40 reads that morning's drill. The cadence is daily, not hourly, because the review-quality check is the costliest of the four.
- **Mapped by the first OWASP Agentic risk the check covers that has a linked live control.** A check's evidence is filed against its plan's control, so the control has to be one that discharges the risk the check evidences. The match is by framework family (`frameworkFamilyId`), as the evidence emitter does, because a tenant's controls can hang off either OWASP Agentic representation. Two controls for one risk is `CONTROL_AMBIGUOUS`, unless the body names one; the setup never picks one. No control is `CONTROL_MISSING`.
- **"Not scheduled" is its own state on the register.** "Never run" with no plan behind it sent the reader looking for a broken job. The new label says the plan does not exist, and the button is the fix.
- **No new authority.** The route takes the register key. The usecase also asks for `tests.create`, which both of its writes already take. The page offers the button only when both are held.
