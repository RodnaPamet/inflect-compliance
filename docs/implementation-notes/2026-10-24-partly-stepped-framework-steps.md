# 2026-10-24 — Steps for the partly-stepped frameworks

**Commit:** `<sha>` feat(catalog): checklist steps for the remaining tasks of seven partly-stepped frameworks

## Design

Since #4050 an installed template task carries its template's steps as a
tickable checklist, and #4065 gave steps to the three frameworks that had none.
Seven more fixtures were only partly stepped: some tasks under a template had
steps and their siblings had none, so a customer's checklist appeared on one task
and not the next under the same control.

| Fixture | Tasks without steps before |
|---|---|
| SOC 2 | 105 |
| DORA | 83 |
| NIST SSDF | 70 |
| CIS v8 IG1 | 68 |
| NIS2 | 57 |
| ISO/IEC 27701 | 34 |
| OWASP ASVS L1 | 17 |

Each step set breaks its task's own description into the acts a practitioner
ticks off, in order, usually ending with the artefact the evidence hint names.
No step adds an obligation, tool, frequency or figure the description does not
carry, and no step quotes a standard.

## Files

| File | Role |
|---|---|
| `prisma/fixtures/{soc2,dora,ssdf,cis-v8-ig1,nis2,iso27701,asvs-l1}-control-templates.json` | Steps on every task that had none; one sentence appended to each `_meta.grounding` |
| `prisma/fixtures/iso27701-control-templates.json` | PIMS-07.3 title reworded from "Wire…" to "Connect…" |
| `tests/guardrails/control-task-actionability.test.ts` | Five CIS title verbs admitted (Re-run, Delete, Re-export, Query, Copy) |

## Decisions

- **Match each fixture's existing style, not #4065's.** These fixtures already
  carried steps written as full sentences ending in a full stop, with no hints,
  four or five to a task. A second style beside the first, under one control,
  would read as two products. The validator for this batch therefore required
  the full stop and refused hints, where #4065's refused the full stop.
- **Skipping was allowed and not expected.** The plan was to step only tasks
  whose description held several separate acts and to skip a genuine single act
  with a written reason. Every description in these seven fixtures turned out to
  carry several acts — they were authored with the same richness as their
  stepped siblings — so all 434 tasks got steps (2,201 in all) and the skip list
  is empty.
- **One validator, then a cross-slice check.** The tasks were drafted in seven
  parallel slices. Each slice passed the same validator before merging: 3–6
  steps; 30–110 characters; an imperative opener; a full stop; no hint; no
  restated description; no step copied from another task or from an existing
  step. The merged set was then checked for verbatim duplicates across slices,
  and none were found. A parse-level comparison confirms that the merge changed
  nothing in the fixtures except the new steps and the grounding sentence.
- **Title and description mismatches were reported, not fixed.** Stepping a task
  means reading its title against its description, and a handful disagree. For
  example, SDLC-PW8#2's title promises every designed test on every build, while
  its description promises static and dynamic analysis. DORA-29#4 is titled
  "Reassess…" but reads as a first assessment. The NIS2-NS template is titled for
  network security, but its tasks cover acquisition and development. Steps
  follow the description wherever the two disagree, because the description is
  what the steps break down. The titles are left for a separate review.
- **Reword a colloquial title rather than admit its verb.** "Wire" is as
  colloquial as the refused Seat and Fit, and #4065 had already reworded NIST's
  "Wire" titles to "Connect". The template row updates in place at the next
  catalogue reconcile; an installed task keeps the title it was installed with.
- **Delivery needs no new code.** `seed-framework-catalogs` reconciles the new
  steps onto production templates at container start, and the #4050 backfill
  gives them to already-installed open tasks that have no checklist.
