# 2026-11-11 — Agent behaviour fingerprint: the CPU detector in the worker

**Commit:** `feat(agentic): nightly agent behaviour fingerprint — the CPU detector (Morpheus Phase 1)`

Morpheus roadmap (`docs/ai-architecture/morpheus.md`) Phase 1, decision D-L1-3:
a baseline-and-z-score job in the worker answers "is this agent behaving unlike
itself" before Morpheus DFP is considered. This is a SIGNIFICANT change (a
schema migration); the rollback plan and risk assessment are below.

## Design

```
01:53 UTC  agent-fingerprint (BullMQ, runJob)
   │  operator keys? AGENT_BEHAVIOUR_DETECTOR + tenant in _TENANTS  ── no ──▶ metric outcome=disabled, nothing read
   ▼  per named tenant, for the UTC day that just closed
readLedgerDay  ── 3 groupBy reads, column allowlist ──▶ 8 counts per active agent
   │
   ▼  per agent not already scored that day
scoreDay (pure)  ── last 28 in-baseline days, mean / floored σ, upward z
   ├─ < 14 days ............ LEARNING   (row, nothing raised)
   ├─ z < 4 ................ STEADY     (row)
   ├─ z ≥ 4 ................ ANOMALOUS FINDING  (row inBaseline=false + anomaly row + finding)
   └─ z ≥ 8 ................ ANOMALOUS LATCH    (… + after commit, with the latch key:
                                                  latchOnBehaviourAnomaly → existing AgentCircuitBreaker)
   ▼
IntegrationExecution (agentic.agent_fingerprint) + metric agentic.agent_fingerprint.pass{outcome}
```

The signal was derived from the real tables because Phase 0's written decision
is on a parallel branch. Features, all per agent per UTC day:

| Feature | Source | Columns read |
| --- | --- | --- |
| `readCalls`, `proposeCalls`, `orchestrateCalls` | `AgentBehaviourWindow` (authorized MCP calls by class) | sums |
| `activeHours` | `AgentBehaviourWindow` | row count (one row per active hour) |
| `proposals`, `guardFlags` | `AgentProposal` | count, by `guardVerdict` ∈ {FLAGGED, QUARANTINED} |
| `modelCalls`, `tokens` | `AiDecisionLog` | count, `tokensIn + tokensOut` |

`WorkflowStep` guard verdicts are not a feature: counting them per agent needs a
join through `WorkflowRun`, and the proposal guard verdict already carries the
signal for the propose path.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/behaviour-fingerprint.ts` | Pure: features, allowlist, thresholds, `scoreDay`, finding text |
| `src/lib/agentic/behaviour-detector-switch.ts` | Pure: the G9 two-key decision and the third (latch) key |
| `src/app-layer/usecases/agent-behaviour-fingerprint-ledger.ts` | The one read of the ledger, held to the allowlist |
| `src/app-layer/usecases/agent-behaviour-fingerprint.ts` | One tenant's pass: score, write rows, reconcile the finding, latch after commit |
| `src/app-layer/jobs/agent-fingerprint.ts` | The sweep and the BullMQ executor body under `runJob` |
| `src/lib/agentic/circuit-breaker{,-store}.ts` | `BEHAVIOUR_ANOMALY_TRIP` and `latchOnBehaviourAnomaly` — the same latch write as the guard-block trip |
| `prisma/schema/agentic.prisma`, migration `20261111230000_agent_behaviour_fingerprint` | `AgentBehaviourBaseline`, `AgentBehaviourAnomaly`, RLS, CHECKs |
| `src/env.ts` | `AGENT_BEHAVIOUR_DETECTOR`, `_TENANTS`, `_LATCH` |
| `src/app-layer/jobs/{types,executor-registry,schedules}.ts` | Payload, retry policy (1 attempt), registration, 01:53 UTC slot |
| `src/lib/observability/integration-metrics.ts` | `agentic.agent_fingerprint.pass{outcome}` and `.days{verdict}` |
| `CircuitBreakerTab.tsx`, `messages/*.json` | The trip reason's label |
| `docs/data-retention.md` | Both models classified Operational |

## Decisions

- **Mean and σ, not the breaker's median and MAD.** The roadmap names "rolling
  mean/σ", and the two suppressions that made mean/σ unusable in the hourly
  breaker are handled differently here: an anomalous day never enters the
  baseline (so one spike cannot inflate σ to hide the next), and a σ floor of
  `max(1, 0.1 × mean)` stops a flat history from making every change infinite.
- **Upward only, with an absolute delta per feature.** A quieter agent is not
  the threat; a quiet agent's 2 → 6 is not a tripling worth a finding.
- **One finding per agent, not per day.** `sourceRef = BEHAVIOUR_ANOMALY:<agentId>`:
  open, reopen a CLOSED one, or leave an open one. Each day keeps its own
  anomaly row (with `findingId`) for the "why".
- **The latch is a third key and happens after commit.** Threshold B stops an
  agent with no human in the loop, so it needs `AGENT_BEHAVIOUR_DETECTOR_LATCH`
  in addition to the two G9 keys, and it runs after the rows commit through
  the breaker's own never-throwing seam. A failed latch leaves `latchedAt` NULL
  and the finding standing.
- **No wildcard tenant list.** A deployment that turns it on names every tenant;
  the env value is the record of who it was turned on for.
- **Idempotent on (tenant, agent, day).** The unique index is the key and the
  pass reads it first, so a retry or manual re-run writes nothing. Retries are
  therefore 1 attempt.
- **The register is read first, and the ledger only for its ids.**
  `AgentBehaviourWindow` is unswept by decision (ADR 0002), and its guard
  requires every read to sit on the `(tenantId, agentId, windowStart)` prefix.
  The first draft grouped a tenant's whole day without naming `agentId` and the
  guard refused it. The pass now reads at most `FINGERPRINT_MAX_AGENTS` (2000)
  agents, one past the cap so truncation is recorded (`registerTruncated`), and
  anchors all three ledger reads on those ids — which also drops decision-log
  rows naming an agent id the register never issued.
- **No new container** (capacity rule): the job runs in the existing worker.
- **No new notification type.** The latch already rings
  `AGENT_CIRCUIT_BREAKER_TRIPPED`; a finding-level bell would need a
  `NotificationType` enum change, left for the surface step (1.3).

## Risk assessment

- **Blast radius when off (the default):** none. The scheduled tick reads two
  env vars and returns; no tenant data is read.
- **When on, findings only:** a false positive is an OBSERVATION finding
  assigned to the agent's owner. The thresholds are the unmeasured defaults
  above until Phase 0 replaces them.
- **When the latch key is on:** a false positive stops an agent until a person
  closes the breaker — the same recovery path as every existing trip. This is
  why the latch is a separate key.
- **Migration:** additive only — two new tables, no change to an existing table
  or type, so a rolling deploy's old containers are unaffected.
- **Reads:** three `groupBy`s per tenant per night on tenant-leading
  `createdAt`/`windowStart` indexes, and a 90-day baseline read bounded by one
  row per agent per active day.

## Rollback plan

1. Immediate: unset `AGENT_BEHAVIOUR_DETECTOR_LATCH` (stops latching) or
   `AGENT_BEHAVIOUR_DETECTOR` (stops the job reading anything). No redeploy.
2. A latched agent: close its breaker on the agent's Circuit breaker tab, as
   for any trip.
3. Code: redeploy the prior image. The two tables are unread by the old code.
4. Schema: forward-fix only, per the change-management policy. The tables can
   stay empty indefinitely; dropping them is a later, separate migration.
