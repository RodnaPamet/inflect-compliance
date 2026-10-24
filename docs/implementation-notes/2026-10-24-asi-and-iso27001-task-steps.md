# 2026-10-24 — Checklist steps for OWASP ASI, ISO 27001 Annex A and NIST Privacy

**Commit:** `<sha>` feat(catalog): author checklist steps for all 493 ISO 27001 Annex A tasks

## Design

This follows `2026-10-24-task-checklists-reach-the-page.md`, which made
template steps reach installed tasks and show on the task page. Four
frameworks still had no steps on any task. This change covers three of them:

| Framework | Tasks | Steps | Grounding |
|---|---|---|---|
| OWASP Agentic AI Top 10 | 50 | 3–5 each | the Inflect governance summaries in `src/data/libraries/owasp-agentic-top10.yaml` |
| ISO/IEC 27001:2022 Annex A | 493 | 4–6 each, 2,336 total | each task's own description and evidence hint, plus the control's title and intent paraphrase |
| NIST Privacy Framework 1.0 | 306 | 3–6 each, 1,414 total | each task's own description, read against the subcategory statements in `src/data/libraries/nist-privacy-framework-1.0.yaml` (NIST public information) |

After this, every framework has steps on at least part of its tasks. The tasks
still without steps belong to frameworks whose authors stepped some tasks and
deliberately left the single-action ones (the authoring rule).

ISO steps were drafted in five parallel slices by Annex A theme: 5.1–5.18,
5.19–5.37, 6–7, 8.1–8.17 and 8.18–8.34. NIST Privacy steps were drafted in
three slices of about 100 tasks each. Every slice was checked by one
validator before merging, which applied these rules:

- 3–6 steps per task;
- 25–170 characters per step, with no trailing full stop and no quotation
  marks;
- each step opens with an imperative verb;
- no step restates the description;
- no step is duplicated within its task or reused verbatim across controls.

The merge then wrote the catalogue's `{ text: { en }, hint?: { en } }`
shape and refused any task that already had steps.

## Decisions

- **Steps break the description down; they add nothing to it.** Annex A
  grounding here is thin, a title and a 25–60 character paraphrase, and no
  ISO text may be quoted or reconstructed. So the only safe source for a step
  is the task's own description. Each step set splits it into separate acts
  and ends with the artefact the evidence hint names. No step brings in a
  tool, frequency or figure the description lacks.
- **The actionability verb list grew by 75**: 7 for ASI, 30 for ISO and 38
  for NIST, each read in its title. These titles predate this change and
  entered the ratchet only once they had steps, which is the "absent verb is a loud false
  positive" case the file describes. The refused verbs (Fit, Fix, Seat, Stand)
  stay refused.
- **Sixteen NIST titles were reworded rather than admitted.** Six used verbs
  the ratchet already refuses and says stay refused: Fix (×4) became Define or
  Set, Fit became Design, and Stand up became Establish, the COSO batch's own
  redraft. Ten used verbs as colloquial as the refused Seat and Fit:
  - Pin (×3) became Link, Record or Match;
  - Wire, Mine, Pull and Drive became Connect, Search, Extract and Operate;
  - Push, Step up and Tie became Bring, Raise and Link.

  The rewording changes each title's content hash, so `reconcileTemplateTasks`
  updates those template rows in place. Tasks already installed keep the title
  they were installed with.
- **The title check ignores trailing punctuation on the first word.** "Add,
  amend and retire…", "Record, for each change…" and "Write, in the words
  staff use…" open with verbs that were already listed and failed only on the
  comma. Fixing how the check reads the word is a smaller and truer change
  than rewording shipped titles. Rewording would also change each title's
  content hash for no gain in meaning.
- **Installed tasks receive the new steps through the existing backfill.**
  `prisma/task-checklist-backfill.ts` runs on container start, so an open
  task installed from ASI or ISO 27001 gets these steps on the deploy that
  ships them, unless it already has a checklist.
