# 2026-11-25 — Probe runs as monthly evidence (`PROBE_RUNS`, step 8c)

## Design

The third step of the probe-run arc. 8a ingested signed `scanent-probes/1`
reports, and 8b gave them a tab. This step files a month of them as evidence.
The new kind is the `AGENT_HARNESS_SCANS` kind's twin, carried end to end:

```
ProbeRun rows (startedAt in month) ─┐
AgentProberKey holders live in month ┼─ loadProbeFacts ─ ProbePeriodFacts
                                     │        │
                                     │        ├─ probeArtefactCompleteness → status
                                     │        └─ buildProbeRunArtefact      → body
                                     └─ emitAgenticEvidence (one plan per control)
                                        reconcileClosedProbePeriods (previous month
                                        + any month a late run reached)
```

- **Controls** (owner decision): OWASP Agentic ASI01 and ASI02, ISO 27001
  A.8.29, and SOC 2 CC4.1. A.8.29 resolves through `requirementCodeSpellings`,
  so a catalogue numbering it `8.29` is found.
- **Status** (owner decision): APPROVED only when every run in the month
  concluded, none was stopped, and every prober whose key was live in the month
  sent a run. Otherwise it is NEEDS_REVIEW, and the body names each reason.
  - A month with no run is `NO_RUN`, titled NO PROBE RUN RECEIVED.
  - The correction runs in one direction: it reuses `harnessStatusCorrection`
    unchanged.
- **Opt-in**: a tenant that has ever registered a prober key.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261125130000_agentic_evidence_probe_runs_kind/` | Widens `AgenticEvidenceArtefact_kind_known` by `PROBE_RUNS` |
| `src/lib/agentic/evidence-artefact.ts` | The kind, the four targets, the facts, completeness, the body |
| `src/app-layer/usecases/agentic-evidence-emission.ts` | `loadProbeFacts`, the plan, and closed-month reconcile generalised per kind |
| `src/app-layer/jobs/agentic-evidence-emission.ts` | Runs both closed-month reconciles on a scheduled tick |

## Decisions

- **What the agents did never decides the status.** An ACTED outcome is a
  finding, raised by the ingest. The evidence asks only whether the month was
  tested in full: a month in which a prober stopped early, or concluded
  nothing, is not a month in which the agents were shown to resist.
- **No endpoint, excerpt, tool or agent name, by shape.**
  - `ProbeRunFact` has no field that could carry one, and the load selects none.
  - Evidence is read by every evidence reader and can travel in an audit
    pack's share link.
  - The body states the redaction contract, so a reader knows the omission is
    deliberate.
- **The closed-month reconcile was generalised rather than copied.**
  - `reconcileClosedHarnessPeriods` keeps its signature as a wrapper over a
    per-kind `reconcileClosedPeriods`.
  - The kind decides only which table's late rows reach an older month.
  - A second copy would drift on the next fix.
- **A key revoked mid-month still counts.** A prober that held a trusted key
  at any point in the month was expected to report, as for the harness. A key
  revoked before the month began does not.
- **The CHECK is widened by drop and re-add**, as every earlier kind was. An
  old container never writes the new kind, so the rolling deploy is safe, and
  the rollback is a redeploy of the previous image.
