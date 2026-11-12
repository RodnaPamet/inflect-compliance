inflect · ai architecture · cuopt · roadmap v1 · 2026-10-29

# NVIDIA cuOpt — optimisation as an agent skill, Layer 3

> **Status: living design** — the integration roadmap for NVIDIA cuOpt, named
> by the target architecture for Layer 3 as an "optimisation tool for ERP/SAP
> scheduling & logistics routing". **Phase 0's decision is taken: declined (D-L3-3,
> decided by the owner 2026-11-11) — no feature has an optimisation problem
> today, and none at GPU scale.** The roadmap is complete once the master's
> decision table and status board record it; that edit is the coordinator's
> and is outstanding (§ Updating the master). The **Current state** section is true today
> (re-verified 2026-11-11 at main 3.365.0, `8733323f`). The **Roadmap**
> section records the decision; Phase 1 is kept as the plan for the day a
> feature wants a solver. This is a
> child of [`docs/ai-architecture-roadmap.md`](../ai-architecture-roadmap.md):
> read that first for the target map, the global rules **G1–G13**, and the
> sequencing. If the code contradicts a fact here, the code wins and the pull
> request that finds it corrects this document.

## Where it sits in the master roadmap

| | |
| --- | --- |
| Layer · box | 3 — Cognitive & reasoning · "NVIDIA cuOpt" |
| Wave | 4 (decision taken 2026-11-11; Phase 1 only if a feature asks for a solver). The GPU arm (Phase 2) is optional Layer 5 work, after every other roadmap is complete |
| Depends on | nothing for Phases 0–1; Layer 5 ([`modal-inference.md`](./modal-inference.md)), optional and last, for Phase 2 |
| Unblocks | nothing |
| Owner decisions | **D-L3-3** decided 2026-11-11: no GPU-scale optimisation problem; cuOpt only as a CPU seam's backend if a feature ever wants one |
| Complete at | Phase 0's recorded decline — decided 2026-11-11 (no feature wants a solver); complete when the master records it. Phase 1 reopens only when one does; Phase 2 is optional Layer 5 work |

## At a glance

Green: decided or on `main`. Grey dashed: a path not taken today, kept as the plan if a feature asks for a solver. Slate dashed: optional Layer 5 work, which starts only after every other roadmap is complete. Pink: the evaluation record that path would need.

```mermaid
flowchart LR
  P0(["Phase 0 · decided 2026-11-11<br/>no optimisation problem in the code<br/>D-L3-3"]):::done
  DEC["No feature wants it<br/>declined"]:::done
  P1["Phase 1 · optimisation seam, CPU<br/>only if a feature asks<br/>plans become proposals"]:::declined
  P2["Phase 2 · cuOpt on the Layer 5 VM<br/>same seam, parity record"]:::optional
  MOD["Layer 5<br/>optional, after completion"]:::optional
  FIX["Fixture instances<br/>known optima"]:::eval
  P0 -.->|if a feature asks| P1
  P0 -->|today| DEC
  P1 -->|only if measured scale<br/>exceeds the CPU solver| P2
  MOD -.-> P2
  FIX -.-> P1

  classDef done fill:#d1fae5,stroke:#047857,color:#064e3b
  classDef todo fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a
  classDef gate fill:#ede9fe,stroke:#6d28d9,color:#3b0764
  classDef ext fill:#ffffff,stroke:#64748b,color:#334155,stroke-dasharray:3 3
  classDef eval fill:#fce7f3,stroke:#be185d,color:#831843
  classDef declined fill:#f3f4f6,stroke:#6b7280,color:#374151,stroke-dasharray:4 3
  classDef optional fill:#f1f5f9,stroke:#475569,color:#334155,stroke-dasharray:6 3
```

## Current state (true today)

- **No optimisation solver of any kind.** No LP/MILP/VRP library in
  `package.json`; no `cuopt` anywhere; no `solver`, `knapsack`, `simplex` or
  `MILP` identifier in `src/`.
- **No feature computes an optimal plan.** Searched 2026-11-11 for the three
  candidate shapes below:
  - *Remediation portfolio.* Mitigation ROI (`src/lib/control-roi.ts`,
    `usecases/control/roi.ts`) values each control on its own — "a per-control
    valuation, not a portfolio simulation", in the module's own words — and
    `rankByRoi` sorts the priced controls and takes the top N for the
    best-value leaderboard. A sort under a hard cap is not a knapsack: there is
    no budget constraint and no joint choice.
  - *Control-test calendar.* Each control's `nextDueAt` is computed from its
    own frequency (`computeNextDueAt`); nothing spreads tests across testers
    or weeks.
  - *Evidence collection.* Evidence carries an `ownerUserId` and a
    `nextReviewDate` that a person sets (`evidence.prisma`); there is no
    evidence-request model, and nothing assigns evidence work under capacity.

  The remaining combinatorial code is not optimisation in this sense: keyed
  random sampling (`proposal-sampling.ts`, `workpaper-review-sampling.ts`),
  and graph layout for the canvas (`@dagrejs/dagre`).
- **The scheduling-shaped data the product holds** is compliance work, not
  logistics: audit cycles and packs (`audit-workflow.prisma`), control tests
  and test plans (`controls.prisma`, `usecases/control/test-plans.ts`), tasks
  with owners and due dates (`tasks.prisma`), risk treatment with a priced
  Mitigation ROI per item (RQ3, `docs/rq3-roadmap-complete.md`), evidence
  with owners and review dates. The SAP work in this repo is
  *transaction review* (`workflows/sap-transaction-review.ts`,
  `docs/sap-agent-integration-roadmap.md`), not routing or scheduling.
- **Instance sizes are small.** A large tenant has hundreds of controls, tens
  of audits, thousands of tasks — hundreds to low thousands of decision
  variables. That is CPU territory by three orders of magnitude.
- **Agents reach tools only through the funnel** (G3); an optimisation call
  would be a read tool returning a plan, and a plan becomes real only as
  proposals a human approves (propose-not-commit).

## Fit, and what is deliberately not adopted

**What cuOpt is.** NVIDIA's GPU-accelerated LP / MILP / vehicle-routing solver
(open-sourced under Apache-2.0), with a self-hosted REST server image and a
Python API. It pays at scale — hundreds of thousands of variables, large VRPs
— where CPU solvers take minutes to hours.

**Where it *could* fit here**, in descending plausibility:

1. *Evidence-collection scheduling for an audit cycle* — assign evidence
   requests to owners under capacity and deadlines, minimising late items.
2. *Control-test calendar balancing* — spread recurring tests across the year
   under tester capacity.
3. *Remediation portfolio selection* — choose treatments under a budget
   maximising ROI (RQ3 prices the items; the portfolio is a knapsack).

**Not adopted, with the reason.**

- *cuOpt as the first solver.* Every problem above is a few hundred variables.
  A CPU solver (HiGHS or OR-Tools behind the same seam) solves them in
  milliseconds with no GPU, no Layer 5, no sub-processor. Adopting
  cuOpt first would be adopting a runtime for a problem size that does not
  exist.
- *The blueprint's ERP/SAP logistics routing.* Not a capability of this
  product; the SAP roadmap is about judgement over transactions.
- *The NIM container* (blueprint §3): the open-source server image is the
  de-NIM path if the GPU arm is ever built.

**The recommendation (D-L3-3), adopted by the owner 2026-11-11.** Build the *optimisation seam* with a
CPU backend when one of the three problems is wanted as a feature; put cuOpt
behind the same seam on the Layer 5 GPU VM only if Layer 5 is taken up and a
measured instance exceeds what the
CPU backend solves inside the engine's step budget.

## Roadmap (future direction)

### Phase 0 — Find the problem and measure it (decided 2026-11-11: declined; master record outstanding)

**The record.** D-L3-3 was decided by the owner on 2026-11-11 (relayed to this
change by the coordinating session; the owner's initials go in the master's
decision table, which this change does not edit): there is no
optimisation problem at a size that needs a GPU, and cuOpt enters only as a
backend behind a CPU seam if a feature ever wants one. The code was then
checked for a feature that wants one today (§ Current state), and none does:
the nearest candidate, Mitigation ROI, ranks controls one by one and was
designed not to be a portfolio. So the decline is recorded and the roadmap
completes at Phase 0. Formulating and timing a problem no feature asks for
would measure a hypothetical, so 0.1 and 0.2 are not run; they become Phase
1's first step if a feature is proposed. Recorded in
`docs/implementation-notes/2026-11-11-ai-roadmap-decision-completions.md`.

**Sub-phases.**
- [x] 0.1 Pick one of the three candidate problems with the owner; write its
      formulation (variables, constraints, objective) in an implementation
      note. *Not run: no feature picks one (2026-11-11). Done first, and with
      the owner, if Phase 1 is ever opened.*
- [x] 0.2 Export an anonymised instance from the seed tenant at 1×, 10×, 100×
      scale; solve with a CPU solver in a scratch script; record wall-clock.
      *Not run, for the same reason; the instance-size estimate below
      (hundreds to low thousands of variables) stands unmeasured.*
- [x] 0.3 Decide D-L3-3: CPU seam now / cuOpt later / neither. *Neither, now
      (2026-11-11); a CPU seam when a feature wants one; cuOpt only behind
      that seam and only if a measured instance outgrows it.*

**What reopens it.** A feature proposal that needs a joint choice under a
constraint — "pick the treatments that fit this budget", "spread these tests
across these testers" — not a better sort.

**Prompt.**
```text
Context (main 3.338.0): the product holds audit cycles, control tests, tasks with owners
and due dates, and RQ3-priced risk treatments; there is no optimisation solver. The target
names NVIDIA cuOpt (GPU LP/MILP/VRP). Agents reach tools only through runGuardedTool and
plans become real only as proposals.

Task: docs/implementation-notes/2026-MM-DD-optimisation-seam-decision.md. (1) Formulate
ONE candidate problem (evidence-collection scheduling, control-test calendar balancing,
or remediation portfolio under budget): variables, constraints, objective. (2) Build
synthetic instances at 1×/10×/100× of the seed tenant; solve with a CPU MILP solver in a
scratch script (not committed to src/); record wall-clock and variable counts. (3) State
at what scale, if any, a GPU solver would be justified. (4) Recommend D-L3-3.

Constraints: no production code; no dependency added; synthetic data only.

Done when: the note has the formulation, the timing table and a recommendation the
owner can initial.
```

### Phase 1 — The optimisation seam with a CPU backend (if wanted)

*Not started: no feature wants it (D-L3-3, 2026-11-11). Kept as the plan.*

**Sub-phases.**
- [ ] 1.1 `src/lib/ai/optimisation/`: `types.ts` (`Optimiser.solve(problem) →
      plan`, problem types per formulation), `highs-provider.ts` (CPU, in
      process or a tiny service — decide by the dependency's build story),
      `stub-provider.ts`.
- [ ] 1.2 A read tool `plan_<problem>` in `src/lib/mcp/tools/` that reads the
      instance under RLS, solves, and returns a plan — a *suggestion*; the
      agent turns it into proposals (`propose_*`) a human approves.
- [ ] 1.3 Bounded: instance size cap, solver time limit, result size cap —
      every bound labelled in the outcome metric.
- [ ] 1.4 A behavioural test: a plan never references an entity outside the
      caller's tenant; an infeasible instance returns a named reason, not an
      empty plan.

**Prompt.**
```text
Context (main 3.338.0 + Phase 0): D-L3-3 chose a CPU seam for <problem>. Read tools live
in src/lib/mcp/tools/ (name, description, inputSchema, resourceScope) and are reached
through runGuardedTool; writes are proposals a human approves; dependencies follow
docs/dependency-governance.md (runtime role, strict peers, risk review for parsers).

Task: the optimisation seam. (1) src/lib/ai/optimisation/{types,highs-provider,stub-
provider}.ts with the Phase 0 formulation as the problem type. (2) A read tool
plan_<problem>: read the instance under RLS via the repositories, solve with a time
limit, return a plan with per-item rationale. (3) Caps: instance size, solver time,
result size, each with an outcome label. (4) Tests: two-tenant ("a plan never names
another tenant's entity"), infeasible ("returns INFEASIBLE with the binding constraint,
never an empty plan"), time-limit ("returns the best incumbent with a TIMEOUT label").

Constraints: the tool proposes nothing itself — the agent proposes, the human approves.
No GPU, no Layer 5, no cuOpt in this phase.

Done when: an agent granted plan_<problem> produces proposals from a plan on the seed
tenant, and the three tests are green.
```

**Hardening.** G3 (funnel), G7 (RLS reads), propose-not-commit (a plan is a
suggestion), bounded everything (the engine's caps are per run; a solver can
burn a step's budget alone).

### Phase 2 — cuOpt on the Layer 5 VM, behind the same seam (optional, Layer 5; only if Phase 0 found the scale)

**Sub-phases.**
- [ ] 2.1 The open-source cuOpt server on the Layer 5 GPU VM
      ([`modal-inference.md`](./modal-inference.md) Phase 2), deployed from the
      Layer 5 scripts, behind an operator-held token.
- [ ] 2.2 `cuopt-provider.ts` behind `Optimiser`, configured by operator
      settings like the local model route (absent = CPU backend). The VM is in
      the operator's own project, so `LOCAL_ONLY` tenants may use it too.
- [ ] 2.3 Parity test: CPU and cuOpt agree on the objective value for the
      fixture instances within tolerance.
- [ ] 2.4 No sub-processor change while the VM is in the operator's own
      Google Cloud project (the Laya precedent in `docs/sub-processors.md`).

**Hardening.** G1, G12 (optional Layer 5), G11-style parity record.

## Evals for this framework

| What | How |
| --- | --- |
| Correctness | fixture instances with known optima; CPU vs cuOpt parity |
| Isolation | two-tenant plan test |
| Usefulness | acceptance rate of plan-derived proposals on `/agents/review-quality` |

## Updating the master

Outstanding, and the coordinator's to do (this change does not edit the
master, whose cuOpt row still reads "missing; CPU seam first if any" and whose
D-L3-3 row shows only the default-if-undecided). Write:

- **Status board**, cuOpt row, current-state column: "declined — no
  optimisation problem in the product, none at GPU scale (D-L3-3,
  2026-11-11)", linking the implementation note.
- **Decisions for the owner**, D-L3-3: "**decided 2026-11-11** (owner): no;
  CPU seam if a feature wants it", in place of the default-if-undecided text.

Once both read so, the roadmap is complete at Phase 0. A feature that asks for
a solver reopens Phase 1 and flips the row back.
