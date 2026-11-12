# 2026-11-12 — The master AI roadmap after the 2026-11-11 wave

**Commit:** `docs(ai-architecture): bring the master roadmap up to the integrated 2026-11-11 wave`

## Design

Twenty-three work items ran in parallel on 2026-11-11 against the child
roadmaps under `docs/ai-architecture/`. Each was told not to edit the master,
`docs/ai-architecture-roadmap.md`, because every one of them would have edited
the same status board, decision table and diagrams. Twenty-two are integrated
on one branch; the twenty-third, the Presidio Phase 1 `PiiDetector` seam, is
being reconciled separately. This change is the one edit to the master that
the twenty-two left for the coordinator, made after their integration so that
every fact it states can be checked against the integrated code rather than
against each item's report.

The items' reports were the input, and the code was the authority. Where the
two disagreed, the master follows the code:

- The agent-flow Phase 1 report said the Tool Runner already runs flow
  versions. A review fix in the same wave (`runsFlows`, refused with
  `PROFILE_FLOW_NOT_RUNNABLE` at admission and on the worker's pinned path)
  made a flow version run on no engine until Phase 5. The master says so.
- The retriever Phase 0 report proposed a 0.03 overall / 0.05 Bulgarian
  recall margin; the benchmark that landed beside it carries 0.05 absolute
  (`D_L4_3_RECALL_MARGIN`). The new D-L4-10 row proposes the code's value and
  names the child's difference.
- The Web Bot Auth reports disagreed on whether Phase 0.1 (reading the primary
  texts) was done; the integrated child ticks it, from the working group's and
  Cloudflare's source repositories. Phase 0 is still not "on `main`", because
  its done-when needs the outcome metric observed in production.
- Presidio's seam is described as in progress and its `PiiDetector` names are
  kept out of Current state, since `src/lib/ai/pii/` on this branch holds only
  Phase 0's scope and record modules.

## Files

| File | Role |
| --- | --- |
| `docs/ai-architecture-roadmap.md` | Current state per layer, target diagram classes, status board, capacity lines, G5/G6/G7, sequencing timeline and dependency graph, evals table, decisions table |
| `docs/implementation-notes/2026-11-12-ai-roadmap-wave-integration.md` | this note |

## Decisions

- **Amber now means two things, and the legend says both.** A node is amber
  when part of the framework runs, or when its seam is built and nothing runs
  through it yet. Most of the wave is the second kind: modules off by default,
  with no container behind them (each new service is held by the capacity rule
  until C1). Green stays reserved for production use, so no node turned green.
  Langfuse and cuOpt became grey (declined) rather than green, because the
  decision that completed them is a decision not to adopt.
- **"Phase on `main`" follows each child's done-when literally.** NeMo
  Guardrails reads 0 because its done-when (input-scan tests, D-L1-2) is met,
  even though its 0.2 and 0.3 boxes are open; the row names them. Morpheus,
  garak, Web Bot Auth and Agent Pay read "—" although later sub-phases are
  built, because their Phase 0 done-whens are not met; the Status column
  carries what is built.
- **G6 records the owner's amendment as a rule, with its pattern.** An
  in-deployment service — an operator-set URL, read by exactly one module,
  never tenant-writable — must resolve inside the deployment (private,
  loopback or ULA, every address) and is dialled with a deadline and an
  aborting byte cap; `safeFetch` stays the rule for every host outside. The
  embedding seam's `perimeter.ts` is named as the pattern because it already
  does exactly this. The rule keeps its number; the NeMo and Docling clients,
  which still dial through `safeFetch`, are named as the two that move.
- **The owner's session decisions get rows, not just prose.** The TLS-fetch
  taxonomy (D-L1-15) and keeping a refusal for a `flag` on run input (D-L1-16)
  are recorded as decided rows beside D-EV-6 and D-L4-7, so the table stays the
  one place a decision is looked up.
- **New open questions get ids in their layer's series, numbered after the
  last id any document uses.** Inspect's note already used D-EV-6 to D-EV-10,
  so the shared-cap question became D-EV-11. The Layer 1 additions from
  Cloudflare's policy and the draft (D-L1-13, D-L1-14) are separate rows from
  D-L1-6 and D-L1-7, whose rows now say they were adopted at their defaults
  only.
- **The capacity arithmetic was redone from the wave's figures, not carried
  over.** The vector line drops to +0.5 GB inside `postgres` (the vector-store
  note's estimate), the embedding and rerank lines take the small candidates'
  fp32 weight sizes from the retriever's Phase 0 research, and traces cost
  nothing on the VM under OTel-only. The result is a range, about 8.5 to 12 GB with small models and
  about 16 GB with the Nemotron pair, because D-L4-3's winner is not yet known.
- **The timeline moves three roadmaps into Wave 0** (Langfuse, cuOpt,
  SWE-bench), since a decision completed each. The dependency graph drops the
  Langfuse capture-on node and its edge from Presidio, and gains a prose note
  that Inspect's Phase 1 depends on garak's agent-run route (1.1b).
