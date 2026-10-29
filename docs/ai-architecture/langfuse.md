inflect · ai architecture · langfuse · roadmap v1 · 2026-10-29

# Langfuse — LLM tracing, datasets and scores, Layer 4

> **Status: living design** — the integration roadmap for Langfuse, named by
> the target architecture for Layer 4 as "tracing & observability" (the
> diagram pairs it with LlamaIndex; see § Fit for why LlamaIndex is not
> planned). The **Current state** section is true today (main 3.338.0,
> `a1c2f05c`). The **Roadmap** section is the plan. This is a child of
> [`docs/ai-architecture-roadmap.md`](../ai-architecture-roadmap.md): read that
> first for the target map, the global rules **G1–G12**, and the sequencing.
> If the code contradicts a fact here, the code wins and the pull request that
> finds it corrects this document.

## Where it sits in the master roadmap

| | |
| --- | --- |
| Layer · box | 4 — Knowledge & deep RAG · "Langfuse / LlamaIndex (tracing & observability)" |
| Wave | 2 (after the first RAG wave has something to trace and evaluate) |
| Depends on | nothing to deploy; [`presidio.md`](./presidio.md) Phase 1 before any content capture |
| Unblocks | the eval UI for [`ragas.md`](./ragas.md), [`inspect.md`](./inspect.md); per-tenant cost views |
| Owner decisions | **D-L4-5** (self-host vs Langfuse Cloud EU vs OTel-only), **D-L4-6** (content capture off by default) |

## Current state (true today)

- **Observability is OpenTelemetry, and it already carries the agent runs.**
  `src/lib/observability/` (OTel traces + metrics, Sentry errors, structured
  logging through `log()` / `logger` with AsyncLocalStorage context),
  `traceUsecase` / `traceOperation` spans, the BullMQ worker's `execute <job>`
  spans linked to the `enqueue` span, Epic E's graceful shutdown draining
  audit buffers → OTel → Sentry under per-stage budgets.
- **The AI record of record is not a trace.** Every model call and tool call
  writes an EU AI Act Art 12 row in the decision log
  (`src/app-layer/ai/decision-log/`); human review stamps Art 14; proposals
  pin `policyCardVersion`; `WorkflowRun.costTokens` is charged from per-turn
  usage; the tenant has a monthly token budget (`monthly-budget-policy.ts`)
  and the assistant a spend ceiling (`assistant/spend-ceiling.ts`). Flue's
  telemetry (`flue/telemetry.ts`) is guarded to carry **no content**
  (`tests/guards/flue-telemetry-carries-no-content.test.ts`).
- **Prompts are code, and policy cards are versioned rows.** Prompt text lives
  in modules such as `risk-assessment/prompt-builder.ts`; agent instructions
  are approved, frozen `AgentProfileVersion`s whose hash the resolver
  recomputes; policy cards are pinned per run. There is no prompt registry
  and nothing to migrate one from.
- **Evaluation records are in-house and recomputed from raw answers**
  (`flue/skills/evaluation-record.ts`, `identity-match/evaluation-record.ts`):
  a stored rate is a refusal.
- **No Langfuse, no LlamaIndex** (`package.json`, `src/`).

## Fit, and what is deliberately not adopted

**Adopted.** Langfuse (MIT core) for three things the OTel stack does not have
a UI for: *LLM-shaped traces* (prompt → tool calls → completion with token
counts per generation), *datasets and runs* (the eval sets and their records,
browsable), and *scores* attached to traces. The TypeScript SDK is OTel-native
(a span processor/exporter on the existing OTel pipeline), so there is no
second instrumentation layer — which is the only reason this is cheap enough
to adopt.

**Not adopted, with the reason.**

- *Prompt management.* A second source of truth for text the product already
  freezes, hashes and approves (profiles, policy cards, pinned prompts). The
  repo's own rule, quoted in `assistant/turn-provider.ts`: "the single most
  expensive mistake available here is building a second one of any of them".
- *Langfuse as the record.* The decision log is the Art 12 record and the
  hash-chained audit trail is the audit record; Langfuse is observability,
  rebuildable and deletable.
- *LlamaIndex.* A Python-first orchestration/RAG framework whose job the
  retriever seam, the knowledge index and the engines already divide between
  them; LlamaIndex.TS would be a third engine. Not planned; recorded here so
  the diagram's pairing is answered.
- *Content capture by default.* Prompts and completions are business content
  (and, for `discovered-agent-review`, a person reference). Traces carry no
  content unless an explicit switch, a tenant residency that permits it, and
  masking are all on (D-L4-6).

**The decision (D-L4-5).** Langfuse v3 self-hosted needs its own Postgres,
ClickHouse, Redis and S3-compatible store — four more services on one VM.
Langfuse Cloud's EU region removes the weight but is a sub-processor receiving
traces (G2, 30-day notice), and `LOCAL_ONLY` tenants could never be exported
to it. The third option is honest: OTel + the decision log already answer
"what happened and what did it cost"; Langfuse adds the eval/dataset UI.
Phase 0 puts the three in front of the owner with the weights measured.

## Roadmap (future direction)

### Phase 0 — Decide hosting and content policy

**Sub-phases.**
- [ ] 0.1 Measure the self-host footprint locally (containers, idle memory);
      record digests (G5).
- [ ] 0.2 Write the D-L4-5 memo: self-host / Cloud EU / OTel-only, with the
      sub-processor consequence spelled out for Cloud.
- [ ] 0.3 Write D-L4-6 into the same note: content capture is off by default;
      on requires `LANGFUSE_CAPTURE_CONTENT=1` **and** tenant
      `aiResidency = EXTERNAL` (for Cloud) **and** the Presidio mask hook.
- [ ] 0.4 If Cloud: start the four-step process now (the 30 days run in
      parallel with Phase 1).

**Prompt.**
```text
Context (main 3.338.0): observability is OTel + Sentry (src/lib/observability/) with Epic
E shutdown drain; the AI record is the Art 12 decision log; Flue telemetry carries no
content by guard; prompts/profiles/policy cards are versioned in code or DB. The target
names Langfuse for tracing. Sub-processors follow docs/sub-processor-change-policy.md.

Task: docs/implementation-notes/2026-MM-DD-langfuse-decision.md. (1) Stand Langfuse v3
up locally from its reference Compose; record containers, idle memory, image digests.
(2) Compare three options — self-host, Langfuse Cloud (EU region), OTel-only — on VM
weight, sub-processor consequence, LOCAL_ONLY tenant handling, and what each adds beyond
the decision log. (3) Record D-L4-6: content capture off by default; on only with
LANGFUSE_CAPTURE_CONTENT=1 AND residency permits AND masking. (4) If recommending Cloud,
draft the docs/sub-processors.md row and name the data shared.

Constraints: no code, no dependency. Say plainly what Langfuse adds that OTel + the
decision log do not, and what it duplicates.

Done when: the note exists and the owner has initialled D-L4-5 and D-L4-6.
```

**Hardening.** G2 (the notice clock starts at the decision, not at the
code), G5, G10.

### Phase 1 — Exporter behind a flag, no content

**Sub-phases.**
- [ ] 1.1 `src/env.ts`: `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`,
      `LANGFUSE_SECRET_KEY`, `LANGFUSE_CAPTURE_CONTENT` (default off). Absent
      URL = nothing registered (G9).
- [ ] 1.2 Register the Langfuse OTel span processor in
      `src/instrumentation.ts::register()` beside the existing exporters, and
      add its flush to `shutdownTelemetry` under the OTel stage budget (Epic E
      — a slow exporter never blocks the drain).
- [ ] 1.3 Attribute allowlist: `tenantId`, `runId`, `agentId`, `driver`,
      `model`, token counts, guard verdicts, decision-log row ids — **never**
      prompt or completion text while `LANGFUSE_CAPTURE_CONTENT` is off. A
      guard in the style of `flue-telemetry-carries-no-content` asserts the
      exporter's attribute set.
- [ ] 1.4 If self-hosted: Compose services, digest-pinned, no published port;
      `caddy` routes the Langfuse UI only behind the operator's own auth.
- [ ] 1.5 Sub-processor row (Cloud) or in-deployment row (self-host).

**Prompt.**
```text
Context (main 3.338.0): OTel is initialised in src/instrumentation.ts::register() and
drained by installShutdownHandlers() with per-stage budgets (src/lib/observability/
shutdown-budget.ts); tests/guards/flue-telemetry-carries-no-content.test.ts is the
pattern for "telemetry carries no content". Phase 0 chose the hosting option.

Task: add Langfuse tracing with no content. (1) LANGFUSE_BASE_URL / PUBLIC_KEY /
SECRET_KEY / LANGFUSE_CAPTURE_CONTENT (default off) in src/env.ts; absent URL = nothing
registered. (2) Register the Langfuse OTel span processor in register(); add its flush
to shutdownTelemetry under the existing OTel stage budget. (3) An attribute allowlist
module src/lib/observability/langfuse-attributes.ts and a guard asserting no prompt/
completion attribute is exported while capture is off. (4) Self-host: Compose services
digest-pinned, UI behind operator auth; Cloud: the sub-processor row already approved.
(5) Decision-log row id as a trace attribute so a trace links to its Art 12 record.

Constraints: the decision log remains the record; Langfuse is deletable. LOCAL_ONLY
tenants' spans are exported ONLY to a self-hosted instance (assert in the processor:
drop the span otherwise, with a counter). Keys are secrets in .env.prod.

Done when: a Flue run appears as a trace with tokens and guard verdicts and no text;
the drain completes within budget with Langfuse unreachable; the content guard is green.
```

**Hardening.** G1 (LOCAL_ONLY spans never leave), G4-adjacent (no content),
Epic E (bounded flush), G9. The attribute allowlist is a *guard*, not a
convention: the day a developer adds `input` to a span attribute is the day a
tenant's policy text lands in a trace store.

### Phase 2 — Datasets and scores from the house records

**Sub-phases.**
- [ ] 2.1 A job `evals-publish` (G8) that pushes each committed evaluation
      record (skills, RAG, parse, Inspect) to Langfuse as a dataset run with
      per-item scores — **the record stays the source**; Langfuse holds a copy.
- [ ] 2.2 Scores on live traces from the review latch (guard verdicts) and
      from human review outcomes (Art 14 `humanOutcome`), as numeric scores
      with the decision-log id — so "do these approvals mean anything?"
      (`/agents/review-quality`) has a trace-level view too.
- [ ] 2.3 No score may be *entered* in Langfuse and read back as a fact; the
      TS validators recompute from raw answers (G11).

**Prompt.**
```text
Context (main 3.338.0 + Phase 1): evaluation records exist in the house shape (set +
raw answers + model revision; aggregates recomputed) for skills and, after ragas.md,
for RAG; human review outcomes are Art 14 stamps on decision-log rows; the review-quality
surface asks whether approvals mean anything.

Task: publish records as Langfuse datasets/runs and attach scores. (1) Job evals-publish:
for each committed record, upsert a dataset (keyed by set hash) and a run (keyed by
model/retriever revision) with per-item scores; idempotent. (2) On the live trace,
attach guard verdicts (review latch) and humanOutcome as scores, with the decision-log
id. (3) Nothing reads a score back from Langfuse into product state.

Constraints: worker only; Langfuse unreachable = skipped with a counter, never a failed
run. Dataset items carry case ids and expectations, never customer content (records are
built on seed/fixture sets by rule).

Done when: a skill's evaluation record is browsable as a dataset run, and a reviewed
proposal's trace shows its humanOutcome score.
```

**Hardening.** G11 (copies, not sources), G8, G9. The one-way arrow —
records → Langfuse, never back — is what keeps the eval gate honest.

### Phase 3 — Cost and quality views on `/agents/reports`

**Sub-phases.**
- [ ] 3.1 Per-tenant token spend by agent/model/driver read from the product's
      own metrics (not from Langfuse) and shown on `/agents/reports`; Langfuse
      links out per run for operators.
- [ ] 3.2 Capture-on mode for EXTERNAL tenants with the Presidio mask hook
      ([`presidio.md`](./presidio.md) Phase 2), behind D-L4-6's three
      conditions; a tenant-level switch in `TenantSecuritySettings`
      (`aiTraceCapture`), default off, two keys (G9).

**Hardening.** G9 (two keys), G1, G2 (capture-on with Cloud changes the data
category on the sub-processor row — same diff).

## Evals for this framework

| What | How |
| --- | --- |
| No-content invariant | guard on the exporter's attribute set (Phase 1) |
| Drain budget | shutdown test with Langfuse unreachable |
| Residency | "LOCAL_ONLY spans never reach a non-self-hosted sink" unit test |
| Usefulness | the eval UI is what Phases 2–3 of the other roadmaps use; if nobody opens it in a quarter, D-L4-5 is revisited |

## Updating the master

Flip the row on the master [Status board](../ai-architecture-roadmap.md#status-board)
per phase; D-L4-5/6 in the decision table. If the owner picks OTel-only,
mark this framework "declined" in the master with the note's link — the
diagram's box is then answered by the existing stack, which is a legitimate
outcome of a roadmap.
