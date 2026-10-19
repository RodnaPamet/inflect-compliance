# 2026-10-19 — The auditor agent's narrative of a period's workpapers (#3749, part B)

**Commit:** see the pull request for #3749 part B.

## Design

```
person (static engine) or the auditor's agent-bound key (Flue)
  POST /api/t/:slug/agent-runs  { workflowKey: 'audit-narrative', input: { periodLabel } }
    startWorkflowRun → mount gate pins iam-audit-procedures (passing record) → run row
      Flue: offered the READ surface alone (readOnly) — list_audit_workpapers among it
        model answers with ONE JSON block: { periodLabel, narratives[≤6] }
          recordModelDecision → AiDecisionLog.outputSummary (≤4000 chars)
  executeFrom settles the run
    captureAuditNarrativeAfterRun ─▶ captureAuditNarrative     (the ONE writer)
      run row: this workflow, COMPLETED, FLUE, the skill pinned
      sealed context → periodLabel
      readNarrativeFromAnswer          (schema, or a named refusal)
      the named workpapers of THIS tenant and THAT period, from the database
      checkNarrativesAgainstRecord     (conclusion, codes, text — or refuse ALL)
      ▼
    AuditWorkpaperNarrative per workpaper not yet narrated (write-once, encrypted)
      ▼
    the review sheet shows it beside the workpaper; the period read flags `narrated`
```

The five procedures are deterministic code on the control-test runner and
need no model. What a model adds is the prose a reviewer reads: what was
tested, what the sample showed, and the conclusion. That prose is the one part
of the auditor's output that is not a code, so it is the part held hardest to
the record before it is stored.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/workflow-types.ts` | `readOnly?: true` on a definition |
| `src/lib/agentic/flue/tools-adapter.ts`, `flue/execute.ts` | a read-only run is offered no propose tool; each withheld one is an omission `READ_ONLY_WORKFLOW` |
| `src/lib/agentic/audit-narrative.ts` | the output contract: read the block, hold each narrative to the record |
| `src/lib/agentic/workflows/audit-narrative.ts`, `workflow-registry.ts` | the workflow: `periodLabel` in, one READ step, read-only |
| `src/lib/agentic/flue/skills/iam-audit-procedures/` | v2: the narrate section, every exception code named, a code only for a raised exception; the evaluation set's narrate cases; the record |
| `prisma/schema/audit-workflow.prisma`, migration `20261019180000_audit_workpaper_narrative` | the table, RLS, grants, the code-checking insert trigger, write-once |
| `src/app-layer/usecases/audit-workpaper-narrative.ts` | the capture, its after-run hook, the per-workpaper read |
| `src/app-layer/usecases/workflow-runs.ts` | the hook at the settlement seam |
| `src/lib/agentic/audit-workpaper-view.ts`, `AuditWorkpaperRepository.ts`, `usecases/audit-workpaper.ts` | the period read's `narrated` flag; `recordedCodes` |
| `src/app-layer/usecases/audit-workpaper-sample-review.ts`, `WorkpaperReviewSheet.tsx`, `messages/*.json` | the narrative on the review sheet |
| `src/lib/security/encrypted-fields.ts`, `usecases/tenant-purge.ts`, `docs/data-retention.md` | encrypted, retained with its workpaper, classified |

## Decisions

- **The skill is the existing `iam-audit-procedures`, with a second section**,
  because the issue and the owner named it. Its description says both things it
  does, and the narrate section says what to read, what to write and in what
  shape.
- **`readOnly` withholds the propose surface on Flue.** A definition without a
  PROPOSE step is not read-only on Flue: the model chooses its own calls from
  whatever the agent is granted, and the auditor agent is granted
  `propose_finding` by the 3c pilot setup. Owner decision 2 was that this
  workflow proposes nothing, so the definition says so and the engine enforces
  it. The same gap on `discovered-agent-review` is filed as #3775.
- **One bad narrative refuses the whole answer.** A model that misstated one
  workpaper's conclusion is not trusted for the others in the same answer. The
  refusal is named and counted, and the next run tries again.
- **What the contract checks, and what it cannot.** The stated conclusion, every
  conclusion word in the text, every listed exception code and every
  code-shaped token in the text must be the workpaper's own; an e-mail address
  is refused. It cannot read prose for meaning; it can stop the prose carrying a
  conclusion or a code the record does not, which is what a reviewer would take
  on trust.
- **The answer is a JSON block and nothing else.** The capture reads the
  answer back from the decision log, which keeps 4000 characters of an agentic
  run's output. Six narratives of 400 characters fit; prose before the block
  could push it past the cut, and a cut block does not parse.
- **Write-once, and a re-narration is not a conflict.** An answer that narrates
  an already-narrated workpaper stores nothing for it and is counted
  `alreadyNarrated`; the stored narrative is never replaced. The `narrated` flag
  on the period read lets the skill skip those.
- **Encrypted, unlike the workpaper.** The workpaper's columns are codes,
  identifiers and counts, deliberately unencrypted so they can be compared. A
  narrative is prose about a record that lists exceptions about people's access,
  so it is encrypted and sanitised at its one writer.
- **Retained with its workpaper.** A Regulatory artefact the tenant purge keeps,
  its only foreign keys to the tenant tombstone and the retained workpaper; the
  run is a plain id.
- **The skill now names every exception code the library records.** Version 1
  named some attributes' codes and described the rest, and the model, told what
  R6 or A2 tests but not its code, wrote a label of its own: three task cases and
  one injection case missed their code. A unit test now fails when the library
  gains a code the skill does not name.
- **A code only for a raised exception.** Once the skill named every code, the
  model began citing codes for attributes that were met ("no
  `GRANT_OUTLIVED_WINDOW`"), which reads as a raised exception to anything that
  scans for codes. The skill says a met attribute is said to be met, without its
  code.
- **The scheduled run is part C.** This part makes a run possible on demand;
  the daily dispatch that starts one per tenant after a period's procedures have
  run is its own change.
