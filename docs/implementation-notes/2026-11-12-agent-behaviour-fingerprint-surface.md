# 2026-11-12 — Agent behaviour fingerprint: the surface and the accepted baseline (Morpheus 1.3)

**Commit:** `feat(agentic): the behaviour fingerprint's surface, and a person's "accept as new normal" (Morpheus 1.3)`

Morpheus roadmap (`docs/ai-architecture/morpheus.md`) sub-phase 1.3: the
anomaly on the agent's Overview tab and on `/agents/reports`, with a "why"
panel listing the features. It also settles the question the 1.x note left
open — whether the fingerprint needs a re-baseline control of its own beside
the breaker's `ACCEPTED_NEW_BASELINE` close. It does, and it is the narrowest
one. No schema change, so this is not a SIGNIFICANT change.

## Design

```
GET  /api/t/:slug/admin/agents/:agentId/behaviour-fingerprint   admin.agent_registry
POST /api/t/:slug/admin/agents/:agentId/behaviour-fingerprint   admin.agent_registry, body { confirm: 'ACCEPT_NEW_BASELINE' }
        │
        ▼
usecases/agent-behaviour-fingerprint-read.ts
   getAgentBehaviourFingerprint   30 scored days, 10 anomalies (drivers), detector state,
                                  the person-set epoch, acceptBaseline { allowed, refusal }
   listAgentBehaviourAnomalies    the tenant's anomalies, last 30 days, cap 200 (+1 read)
   acceptAgentBehaviourBaseline   AgentCircuitBreaker.baselineEpoch := now   (CLOSED only)
        │
        ├─ Overview tab: BehaviourFingerprintCard  (shown with the register read key)
        └─ /agents/reports?tab=behaviour: BehaviourTab  (server read, register key only)
                    both render components/agentic/BehaviourAnomalyWhy
```

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/agent-behaviour-fingerprint-read.ts` | The two reads and the acceptance; the refusal rules, pure and shared by read and write |
| `src/app/api/t/[tenantSlug]/admin/agents/[agentId]/behaviour-fingerprint/route.ts` | GET and POST under the breaker route's key |
| `src/components/agentic/BehaviourAnomalyWhy.tsx` | The "why" list and the tier badge, shared by both surfaces |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/BehaviourFingerprintCard.tsx` | The Overview card and the confirmation |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient.tsx` | Mounts the card behind `canReadRegistry` |
| `src/app/t/[tenantSlug]/(app)/agents/reports/{page.tsx,ReportsClient.tsx,behaviour/BehaviourTab.tsx}` | The third reports tab, loaded on demand |
| `src/lib/agentic/behaviour-fingerprint.ts` | Doc only: the epoch now has two writers |
| `src/lib/observability/integration-metrics.ts` | `agentic.agent_fingerprint.baseline_accepted` |
| `messages/{en,bg}.json` | `admin.agentDetail.fingerprint.*`, `agents.reports.behaviour*` |

## Decisions

- **A separate acceptance, because the breaker's close cannot reach every
  case.** `ACCEPTED_NEW_BASELINE` is a reason for closing an OPEN breaker. An
  anomaly at threshold A, or at any tier while `AGENT_BEHAVIOUR_DETECTOR_LATCH`
  is off, latches nothing, so there was no breaker to close. An anomalous day
  never enters a later baseline, so an intended step change was re-scored
  ANOMALOUS every night until the pre-change days aged out of the 90-day
  look-back, and the one finding per agent reopened every night a person
  closed it. The integration test shows the treadmill before it shows the exit.
- **It writes the breaker's column, not a column of its own.** One decision
  ("this change was intended"), one `baselineEpoch`, read by both detectors
  through `personSetBaselineEpoch`. A fingerprint-only epoch would need a
  migration and would be a second control free to disagree with the first:
  an agent accepted on one detector and judged against its old self by the
  other. The cost is that accepting also restarts the hourly breaker's
  baseline. The confirmation says so in as many words.
- **Only on a CLOSED breaker.** An OPEN breaker is decided by its close, which
  makes the person choose RESOLVED or ACCEPTED_NEW_BASELINE. A second button
  that re-baselined an open breaker without closing it would let that choice
  be skipped. The write is `updateMany … where state = 'CLOSED'`, so a latch
  landing between read and write refuses (`BREAKER_OPEN`) rather than being
  re-baselined under.
- **Only with something to accept.** An anomaly row created after the last
  person-set epoch, or `NOTHING_TO_ACCEPT`. It is not a way to wipe an agent's
  history on a whim, and a second click is refused rather than moving the epoch
  again.
- **A person, never a credential or an agent** (`NOT_A_PERSON` for `apiKeyId`
  or `agentId`): an agent must not be able to declare its own behaviour normal.
  The floor is the breaker close's, `assertAgentGovernanceAdmin(ctx,
  'agent_registry')`, behind the route's literal `requirePermission`.
- **No breaker row is refused (`NO_BREAKER`), not created.** The row has one
  insert site, and a defaulted epoch equal to `createdAt` reads as "nobody
  decided", so a row minted here to carry the acceptance would not carry it.
  Every agent that makes a funnel call has a row (`openBreakerGate`).
- **It closes no finding.** Re-baselining stops tomorrow's re-raise (the agent
  is LEARNING again). Closing today's finding is the findings workflow's act.
- **The affordance is computed by the server.** The read returns
  `acceptBaseline.allowed` from the same two predicates the write asserts
  (`baselineAcceptRefusalForCaller`, `baselineAcceptRefusalForState`), so the
  card never offers an act the usecase refuses.
- **Read under `admin.agent_registry`, not the inventory view key.** The
  fingerprint is the breaker's sibling and sits beside it. An AUDITOR who holds
  `/agents/reports` through the view key is not offered the behaviour tab, and
  the page answers `?tab=behaviour` with the pack for them. Widening it to the
  view key is an owner decision (it would also need the edge's
  `AUDITOR_ADMIN_READ_PATHS`).
- **Empty is worded from the detector's state.** Off for the deployment, off
  for the workspace, on but never scored, and scored with nothing found are
  four sentences. "No anomalies" from a detector nobody turned on would be a
  claim about an agent nobody watched.
- **No table on the reports view.** A card per anomaly with its "why" list,
  newest first, capped at 200 with a truncation notice. The view has no
  filters, which keeps it inside the reports page's own "fixed artefact" rule.
- **A counter, not a guess.** `agentic.agent_fingerprint.baseline_accepted`
  sits beside `.days{verdict="anomalous"}`. A deployment that accepts nearly
  every anomaly has thresholds tuned to fire on ordinary work, which is how
  this control would die.
