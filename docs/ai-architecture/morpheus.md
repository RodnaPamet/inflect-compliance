inflect · ai architecture · morpheus · roadmap v1 · 2026-10-29

# NVIDIA Morpheus — behavioural anomaly detection over the agent ledger, Layer 1

> **Status: living design** — the integration roadmap for NVIDIA Morpheus,
> named by the target architecture for Layer 1 as "real-time pipeline
> protection & anomaly detection". The **Current state** section is true
> today (main 3.338.0, `a1c2f05c`). The **Roadmap** section is the plan. This
> is a child of
> [`docs/ai-architecture-roadmap.md`](../ai-architecture-roadmap.md): read that
> first for the target map, the global rules **G1–G12**, and the sequencing.
> If the code contradicts a fact here, the code wins and the pull request that
> finds it corrects this document.

## Where it sits in the master roadmap

| | |
| --- | --- |
| Layer · box | 1 — Security, guards & alignment · "NVIDIA Morpheus" |
| Wave | 3 (last of the Layer 1 additions; needs the optional Layer 5 for its GPU arm) |
| Depends on | a signal with volume (Phase 0 decides); [`modal-inference.md`](./modal-inference.md) Phase 2 for the GPU arm |
| Unblocks | an automated latch on `AgentCircuitBreaker` from behaviour, not only from guard blocks |
| Owner decisions | **D-L1-3** (the signal, and CPU-first) |

## Current state (true today)

- **The signals Morpheus would read already exist, structured and
  immutable.** The hash-chained `AuditLog`/`OrgAuditLog`; the audit event
  stream (C.4) — HMAC-signed batches of structured `detailsJson` with
  free-text `details` deliberately dropped; the AI decision log (Art 12 rows
  per model and tool call); the agent run ledger (`WorkflowStep`, proposals,
  receipts on `/agents/receipts`); MCP activity and quarantine; harness
  scans; A2A receipts.
- **Responses to anomalous behaviour exist too.** `AgentCircuitBreaker`
  (latched by repeated guard blocks), tenant and platform kill switches with
  drills, proposal sampling (`proposal-sampling.ts`), the review-quality
  surface, `automation-bias.ts`, `failure-isolation.ts`. What does not exist
  is a *detector* that reads behaviour over time — an agent whose read volume
  tripled overnight trips nothing today unless a guard fires.
- **No stream processor, no GPU, no Morpheus.** The SIEM is the customer's
  (audit stream destination); Inflect runs no analytics over its own ledger
  beyond `analytics.prisma` snapshots for dashboards.

## Fit, and what is deliberately not adopted

**What Morpheus is.** NVIDIA's GPU-accelerated cybersecurity pipeline
framework (Apache-2.0, Python): streaming stages over logs/events with
Triton-served models; its flagship pipeline is **Digital Fingerprinting (DFP)**
— a per-entity behavioural baseline with anomaly scoring.

**Adopted (as a candidate).** DFP over the *agent ledger*: one fingerprint per
`RegisteredAgent` (tool-call rates by scope, token spend, proposal rate,
read volume, time-of-day), scored nightly or per batch; a high anomaly score
raises a Finding and may latch the agent's circuit breaker through the
*existing* latch — never a second breaker. For an AI-governance product,
"your agent is behaving unlike itself" is a defensible, on-brand control.

**Not adopted, with the reason.**

- *Network-level ML security* (the blueprint's "zero-trust sidecar over ERP
  transactions"). There is no ERP transaction stream here, and the network
  perimeter is Caddy + the edge middleware, not a GPU pipeline.
- *Morpheus as the first detector.* The ledger is Postgres; a baseline-and-
  z-score job in the worker (CPU) answers the same question for the volumes
  this product has. Morpheus pays when the feature set and volume outgrow a
  nightly SQL+TypeScript job — Phase 0 measures that rather than assuming it.
- *A streaming deployment.* Scale-to-zero batch scoring on Modal (optional
  Layer 5) over an export of the signed audit stream; nothing always-on.
- *Free text as a feature.* The audit stream already strips `details`; the
  fingerprint reads counts, scopes, ids and timestamps only (G4 is not in
  play because no content moves).

## Roadmap (future direction)

### Phase 0 — The signal, measured on CPU

**Sub-phases.**
- [ ] 0.1 D-L1-3: define the fingerprint features from existing rows (per
      agent per day: calls by tool scope, proposals, reads, tokens, guard
      flags, hours active).
- [ ] 0.2 A scratch analysis over the seed tenant's ledger: feature volumes,
      and whether a simple baseline (rolling mean/σ per feature) separates
      an injected anomaly (a scripted agent that triples its reads).
- [ ] 0.3 Decide: CPU detector first (Phase 1), Morpheus later only if volumes
      or feature complexity exceed it (Phase 2).

**Prompt.**
```text
Context (main 3.338.0): the agent ledger is structured and immutable — WorkflowStep,
decision-log rows, proposals, receipts, MCP activity; the audit stream ships detailsJson
only; AgentCircuitBreaker latches on guard blocks; kill switches and drills exist. There
is no behavioural detector. The target names NVIDIA Morpheus (DFP) for Layer 1.

Task: docs/implementation-notes/2026-MM-DD-agent-fingerprint-decision.md. (1) Define
per-agent daily features computable from existing rows (calls by scope, proposals,
reads, tokens, guard flags, active hours). (2) A scratch script (not under src/) over
the seed tenant that computes them for 30 days of seeded activity and tests whether a
rolling mean/σ baseline flags an injected anomaly (an agent tripling its reads) without
flagging the baseline days. (3) Recommend D-L1-3: CPU detector in the worker first;
Morpheus DFP only above a stated volume/feature threshold.

Constraints: features are counts, scopes, ids and timestamps — never content. Seed
tenant only. No dependency added.

Done when: the note has the feature table, the detection result on the injected
anomaly, and the threshold at which Morpheus would be reconsidered.
```

### Phase 1 — The CPU detector in the worker

**Sub-phases.**
- [ ] 1.1 Job `agent-fingerprint` (G8, nightly after the ledger settles):
      computes features per agent, keeps a rolling baseline in a
      tenant-scoped table (`AgentBehaviourBaseline`, RLS, retention
      classified), scores the day, writes an anomaly row with the features
      that drove it.
- [ ] 1.2 Outcome: a Finding on the agent (through the existing findings
      usecase) at score ≥ threshold; at a higher threshold, latch the
      *existing* circuit breaker with reason `BEHAVIOUR_ANOMALY` — a human
      unlatches, as today.
- [ ] 1.3 Surface: the anomaly on `/agents/[agentId]` Overview and on
      `/agents/reports`; a "why" panel listing the features.
- [ ] 1.4 Two-tenant test; a test that the seeded anomaly latches and the
      baseline days do not; a test that content never enters a feature.

**Prompt.**
```text
Context (main 3.338.0 + Phase 0): features and thresholds are decided; jobs live in
src/app-layer/jobs/ under runJob(); the circuit breaker is latched through
src/lib/agentic/circuit-breaker.ts and unlatched by a person; findings are created
through the findings usecase; new tenant-scoped models need RLS, a tenantId-leading
index, a retention row and a two-tenant test (docs/new-subsystem-checklist.md).

Task: the agent fingerprint detector. (1) Model AgentBehaviourBaseline (+ AgentBehaviour
Anomaly) in agentic.prisma with RLS migration, indexes, retention classification. (2)
Job agent-fingerprint: nightly per tenant; compute features from the ledger; update the
rolling baseline; score; write anomaly rows. (3) Outcomes: Finding at threshold A; latch
the existing circuit breaker with reason BEHAVIOUR_ANOMALY at threshold B. (4) Surface on
the agent Overview tab and /agents/reports with the driving features. (5) Tests: two-
tenant; seeded anomaly latches, baseline days do not; a guard that the feature builder
imports no content-bearing field (allowlist of columns).

Constraints: no second breaker; no content in features; worker only; bounded queries.

Done when: the seeded anomaly produces a Finding and a latch on the seed tenant, the
guard refuses a content column, and the two-tenant test is green.
```

**Hardening.** G7, G8, G10 (the column allowlist is the guard that keeps
this a behaviour detector and not a content reader), "no second mechanism"
(the breaker is the breaker).

### Phase 2 — Morpheus DFP on Modal (only above the Phase 0 threshold)

**Sub-phases.**
- [ ] 2.1 `deploy/modal/morpheus.py`: a batch function running the DFP
      pipeline over an exported day of fingerprint features (not raw events),
      model on a Volume; scale-to-zero.
- [ ] 2.2 The worker job ships features (ids and counts) to the function and
      stores the score beside the CPU score; the latch rule reads the higher.
- [ ] 2.3 Sub-processor: Modal's row gains the category "agent behaviour
      features: agent ids, counts, scopes, timestamps — no content".
- [ ] 2.4 Parity window: four weeks of both scores recorded; Morpheus becomes
      primary only if it finds anomalies the CPU detector missed and the
      review-quality surface confirms them.

**Hardening.** G2 (even ids and counts are a category on the row), G12
(optional), G11 (the parity window is the record that promotes it).

## Evals for this framework

| What | How |
| --- | --- |
| Detection | seeded anomaly set (Phase 0) re-run nightly; precision on baseline days |
| Content-free | column allowlist guard |
| Usefulness | anomalies confirmed vs dismissed on `/agents/review-quality` |

## Updating the master

Flip the row on the master [Status board](../ai-architecture-roadmap.md#status-board)
per phase; D-L1-3 in the decision table. If Phase 0 concludes the CPU detector
suffices indefinitely, the row reads "CPU detector shipped; Morpheus dormant
until <threshold>".
