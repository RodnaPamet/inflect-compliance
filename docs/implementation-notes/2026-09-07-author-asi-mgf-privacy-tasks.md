# 2026-09-07 — Authoring the OWASP ASI, IMDA MGF and NIST Privacy task sets

**Commit:** `(this commit)` feat(catalog): author the ASI, MGF and Privacy task sets

## Design

Three frameworks were delivered to production on 2026-09-07 carrying 32
control templates and **zero tasks between them**. Delivery and authoring are
separate steps, and these three had only had the first: they were reachable
from the production seeder, so a tenant installing them received controls with
nothing to do under any of them.

`DELIVERED_WITHOUT_AUTHORED_TASKS` in
`tests/guardrails/authored-tasks-are-delivered.test.ts` existed to keep exactly
that state visible rather than silent. This change authors all three and
removes their entries, taking the list from nine to six — the six being the
frameworks #2371 delivered, three of them frozen for content and three queued.

173 tasks across 32 templates:

| framework | templates | tasks |
|---|---|---|
| OWASP Agentic AI Top 10 | 10 | 50 |
| IMDA Model AI Governance Framework | 4 | 24 |
| NIST Privacy Framework | 18 | 99 |

## Decisions

- **The 12 review corrections were applied to the source content, not to the
  fixtures.** A review pass over the draft found 12 tasks that named a
  deliverable the control could not support, or split one owner's work across
  two roles. Correcting the draft and re-projecting means the fixtures and the
  reviewed content cannot disagree — patching the fixtures afterwards would
  have left the draft as a second, wrong copy.

- **A conformance pre-check ran before anything was written.** The merge
  refuses to write if any control falls outside 3–6 tasks, any `OPERATE` task
  lacks an `evidenceHint`, any step set falls outside 3–8, or any step is under
  25 characters. It reported zero problems, but the ordering is the point: the
  alternative is discovering a violation from a red guardrail after 173 tasks
  are already in three files.

- **The gap was found by a dry run, not by reading.** The 12 corrections were
  believed to be edits to shipped tasks. They matched nothing, because the
  tasks did not exist — the fixtures carried `tasks: []`. A dry run that
  reports `applied: 0 of 12` is what distinguished "the fixtures are fine" from
  "the fixtures are empty", and the two look identical from the fix list alone.

## Files

| file | role |
|---|---|
| `prisma/fixtures/owasp-asi-control-templates.json` | 10 templates, 50 tasks |
| `prisma/fixtures/imda-mgf-control-templates.json` | 4 templates, 24 tasks |
| `prisma/fixtures/nist-privacy-control-templates.json` | 18 templates, 99 tasks |
| `tests/guardrails/authored-tasks-are-delivered.test.ts` | the three authored entries removed; count assertion 9 → 6 |
