# 2026-11-11 — AI roadmap: seven child roadmaps advanced by recorded owner decisions

**Commit:** on branch `wf/decision-completions` (docs only, no code)

The owner initialled a set of AI-architecture decisions on 2026-11-11. This
note is the Phase 0 record for the child roadmaps those decisions complete or
advance, with each code fact re-verified at main 3.365.0 (`8733323f`). The
child documents in `docs/ai-architecture/` carry the same records in place;
this note is where they point.

## Design

| Roadmap | Decision | Outcome |
| --- | --- | --- |
| `swe-bench.md` | D-EV-5: declined | **complete at Phase 0** |
| `langfuse.md` | D-L4-5: OTel-only; D-L4-6: content capture off by default | **complete at Phase 0** |
| `cuopt.md` | D-L3-3: no GPU-scale optimisation problem; CPU seam only if a feature wants one | **complete at Phase 0** (no feature wants one) |
| `nemoclaw.md` | D-L1-4: reference-only; runtime and routed inference declined | Phase 0 complete; two tightenings → Phase 1 |
| `morpheus.md` | D-L1-3: CPU detector in the worker before Morpheus | Phase 0 signal defined; seeded check open |
| `ares.md` | D-EV-3: the operator labels, seed data only | Phase 0.1 decided; labelling open |
| `langflow.md` | D-L2-2: engines enforce flow checkpoints before the canvas offers one | decision recorded; Phase 5.1 unchanged |

### SWE-bench — declined

SWE-bench scores an agent that edits a repository and runs its test suite. No
Inflect agent writes or runs code. Engines reach tools only through
`runGuardedTool`. Flue's sandbox, shell and sandbox-filesystem exports are
refused by import in `src/lib/agentic/flue/refused-capabilities.ts`: 23
names, 16 sandbox and shell, 5 filesystem and 2 channel, held by
`tests/guards/flue-refused-capabilities.test.ts`. OpenShell confines only the
product's own collector binaries.

The nearest relevant evaluations are the Inspect tasks (`inspect.md`) and a
fixture test of the harness scanner's code reading, which belongs to the
agentic IAM roadmap. Three decisions would have to change before SWE-bench
became relevant, and none is this roadmap's to take:

1. let a model write code;
2. let it run that code, through the OpenShell confinement, with a written
   reason in `refused-capabilities.ts`;
3. make that a product capability worth a capability eval, which would then
   run through Inspect.

The placeholder option was not taken. A box gated on three reversals reads as
an unstarted task.

### Langfuse — OTel-only

What exists:
- OTLP/HTTP traces and metrics (`src/lib/observability/instrumentation.ts`).
  They are off unless `OTEL_ENABLED=true`, export to
  `OTEL_EXPORTER_OTLP_ENDPOINT`, and Epic E drains them on shutdown.
- The Art 12 decision log (`AiDecisionLog`). It stores an input digest and a
  bounded output summary, never raw content.
- The in-house evaluation records, whose rates are recomputed from raw answers.

Langfuse would add a browsing UI for LLM-shaped traces, datasets and scores.
Weighed against that:
- It would duplicate the trace pipeline, and the record if treated as more
  than a copy.
- Self-hosting does not fit the VM. The master's capacity budget records
  ClickHouse alone at 8 GiB.
- Cloud EU would be a sub-processor that `LOCAL_ONLY` tenants could never use.

So OTel-only means no service, no dependency, no sub-processor row and no
notice clock. `package.json` and `src/` contain no Langfuse or LlamaIndex.

D-L4-6 is stated for any trace sink, not only Langfuse. Prompt and completion
text enter a trace only when all three hold:
- an explicit deployment switch is on;
- the tenant's residency permits the sink;
- the Presidio mask hook has run first.

OTel-only builds no capture switch, so the rule is met by construction today.
Phases 1–3 stay in the document as the plan if D-L4-5 is reopened. A later
Langfuse would be one more OTLP destination, not a second instrumentation
layer.

### cuOpt — declined, no problem in the code

Searched for each candidate the roadmap named:
- **Remediation portfolio.** `src/lib/control-roi.ts` describes itself as "a
  per-control valuation, not a portfolio simulation". `rankByRoi` sorts the
  priced controls and takes the top N for the best-value leaderboard
  (`usecases/control/roi.ts`). That is a sort under a cap, with no budget
  constraint and no joint choice.
- **Test calendar.** Each control's `nextDueAt` comes from its own frequency
  (`computeNextDueAt`). Nothing balances tests across testers.
- **Evidence.** Evidence carries `ownerUserId` and `nextReviewDate`, set by a
  person. There is no evidence-request model, and nothing assigns work under
  capacity.

There is no solver dependency and no `solver`, `knapsack`, `simplex` or `MILP`
identifier in `src/`. The remaining combinatorial code is keyed random sampling
and dagre graph layout.

Phase 0.1 and 0.2 (formulate and time one problem) were not run, because they
would measure a hypothetical. A feature that needs a joint choice under a
constraint reopens Phase 1, with formulation as its first step.

### NemoClaw — reference-only, two tightenings found

**Sources.** Read on 2026-11-11 from NVIDIA's `NemoClaw` repository on GitHub,
`main` branch:
- the README;
- `nemoclaw-blueprint/blueprint.yaml`;
- `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`;
- the `policies/presets/` listing.

NVIDIA's documentation site was unreachable from this session, and the
Releases page showed no release. So `main` is what was mapped, not a release.

**What it is.**
- An early-preview reference stack that runs OpenClaw, Hermes or Deep Agents
  inside OpenShell.
- The blueprint is `0.1.0`. It pins OpenShell `0.0.116` as both minimum and
  maximum.
- That pin is a different version string from this repository's gateway pin,
  `0.1.6`. Nothing here depends on comparing the two.

**The component map.** It is in `nemoclaw.md`. In summary:
- *Refused:* the agent runtime, routed inference, channel messaging, run-time
  presets and the dynamic policy approval flow.
- *Absent and not wanted:* the host CLI and onboarding, and state persistence.
- *Answered:* lifecycle, pinning, the default policy and hardening.

**Policy diff.** `openclaw-sandbox.yaml` was compared with `collector-policy.ts`.

| Property | Result |
| --- | --- |
| Enforcement | Equal: every endpoint enforces in both. |
| Wildcard hosts | Equal: none in either. |
| Landlock | Ours tighter: `hard_requirement` against `best_effort`. |
| Writable paths | Ours tighter: one scratch directory against six paths plus the workdir. |
| Run-as user | Ours equal or tighter. |

NemoClaw is tighter in two places, and both are taken as Phase 1:

1. **Binaries per rule.** Every NemoClaw rule names the executables that may
   use it. Ours names none, so any process in the sandbox reaches any listed
   host. The pinned 0.1.6 schema carries `NetworkPolicyRule.binaries`.
2. **L7 rules.** Every NemoClaw rule is `protocol: rest` with method and path
   allowlists. Ours are host-level, and `aiplatform.googleapis.com` admits
   Vertex AI inference alongside the configuration reads, which
   `collector-policy.ts` already records as the L7 residual. A REST rule that
   admits measured reads and refuses `:predict` / `:generateContent` closes it.

Both need a real run's measurements: a guessed binary or path fails the
collection closed. Nothing looser in NemoClaw is taken:
- the inference rule that admits `curl` and `python3` on any path;
- `allow_encoded_slash`;
- run-time presets.

The vendored `generate-sandbox-policy` skill already teaches binaries and REST
rules, so it needs no change.

### Morpheus — the signal, defined around the breaker that exists

The re-verification corrected `morpheus.md`. The agent circuit breaker is a
behavioural detector already:
- `circuit-breaker.ts` / `circuit-breaker-store.ts` keep one
  `AgentBehaviourWindow` row per agent per active hour, written at the end of
  `authorizeToolCall`.
- Three signals use a median/MAD baseline: `PROPOSAL_RATE`, `TOOL_MIX` and
  `REJECTION_RATE`.
- A `GUARD_BLOCK` trip fires at 3 blocks in a window.
- Judgement is lazy, on the agent's next call.

The document had said the breaker latches only on guard blocks. The roadmap's
example gap still stands. `readCalls` is recorded but never judged:
`TOOL_MIX` is scale-invariant, so an agent whose reads triple trips nothing.

The breaker also never reads tokens, runs or active hours. Phase 0's daily
features are exactly those gaps, from columns that exist:
- `AgentBehaviourWindow` counts and hours;
- `WorkflowRun` status, `stepCount` and `costTokens`;
- `AiDecisionLog` `tokensIn` / `tokensOut` by `agentId`;
- `FLAGGED` guard verdicts on `WorkflowStep` and `AgentProposal`;
- `AgentProposal` review outcomes.

The content columns the detector must never read are listed in the document.
The seeded-anomaly measurement (0.2) is still open.

Morpheus is reconsidered only if Layer 5 is taken up and one of two facts is
measured:
- the nightly CPU job overruns its slot for the largest tenant; or
- a wanted signal needs per-call sequences rather than daily counts.

### ARES and the agent-flow canvas — decisions recorded

- **ARES (D-EV-3).** The operator labels the triples, from seed data only. With
  one labeller, the 30-triple agreement overlap is either a second person's
  labels or the operator's own after an interval. The note that ships the set
  says which, because intra-rater agreement is the weaker claim.
- **Agent-flow canvas (D-L2-2).** Reasoning engines enforce flow checkpoints
  (Phase 5.1) before the `checkpoint` kind enters the schema and the palette,
  in the same pull request. An advisory checkpoint is never offered.

## Files

| File | Role |
| --- | --- |
| `docs/ai-architecture/swe-bench.md` | Phase 0 record; complete, declined |
| `docs/ai-architecture/langfuse.md` | Phase 0 record; complete, OTel-only; D-L4-6 for any sink; Phases 1–3 marked not pursued |
| `docs/ai-architecture/cuopt.md` | Phase 0 record; code search; complete, declined |
| `docs/ai-architecture/nemoclaw.md` | component map, policy diff, D-L1-4; Phase 1 sub-phases for the two tightenings |
| `docs/ai-architecture/morpheus.md` | Current state corrected (the breaker exists); feature table; D-L1-3 |
| `docs/ai-architecture/ares.md` | D-EV-3 recorded; overlap consequence |
| `docs/ai-architecture/langflow.md` | D-L2-2 recorded |

## Decisions

- **Completed documents stay `living`.** Each keeps its banner and its two
  sections, with "Complete" stated in the banner and the "Where it sits" table.
  Reclassifying them would edit the contended classification file for no
  reader's benefit. The plans they did not pursue stay as the reopening plan.
- **The master is not edited here.** Its status board and decision table
  belong to the coordinator. Each child document's "Updating the master"
  section states the row text to write.
- **NemoClaw does not complete at Phase 0.** The diff found two real
  tightenings. Recording "none" to close the roadmap would have discarded the
  only concrete thing the comparison produced.
- **No issues were opened** for the two NemoClaw tightenings. This session
  opens none, so they are Phase 1 sub-phases for the coordinator to file.
