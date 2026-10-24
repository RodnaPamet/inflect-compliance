# 2026-10-24 — Steps for every internal-control task

**Commit:** `<sha>` feat(catalog): checklist steps for the remaining 606 internal-control tasks

## Design

The internal controls library (`prisma/fixtures/internal-controls.json`, 151
`ICN-` controls) carried 865 authored tasks. 259 of them had checklist steps;
606 had none, spread across 147 partly-stepped controls and 4 with no steps
at all. Since #4050 an installed template task shows its steps as a tickable
checklist, so an installed internal control showed one on some tasks and not
on their siblings.

All 606 now carry steps: 3,197 in total, 4–6 per task. Each set breaks its
task's own description into the acts a practitioner ticks off, in order,
usually ending with the artefact the evidence hint names. They follow the
fixture's existing style: one full sentence per step, ending in a full stop,
with no hints.

Delivery needs no new code. Entrypoint step 1e
(`seed-control-template-tasks`) reconciles the new steps onto the global
templates at container start. The #4050 backfill then gives them to
already-installed open tasks that have no checklist.

## Files

| File | Role |
|---|---|
| `prisma/fixtures/internal-controls.json` | Steps on the 606 tasks that had none; nothing else changed |

## Decisions

- **The description is the only source.** Each control carries a customer-derived
  objective, success criteria and test methodology. Those were context only, so
  no step takes an obligation, tool, frequency, threshold or role from them that
  the task's own description does not carry. Where a description is internally
  ambiguous (for example, ICN-034#4 calls a hit both a documentation and a data
  failure, then asks the report to say which), the step follows the plainer
  reading. It does not resolve the ambiguity by inventing a rule.
- **Title and description mismatches were reported, not fixed.** A few titles
  promise more than their description: ICN-106#1 says "Enrol" but only records
  enrolment state, and ICN-128#1 names a stand-down procedure the description
  never mentions. A few others carry a phase that reads oddly (ICN-021#3,
  ICN-140#5). Steps follow the description, and the titles are left for a
  separate review.
- **Same checks as the framework catalogues.** The tasks were drafted in six
  parallel slices. Each slice passed one validator: 3–6 steps; 30–130
  characters; an imperative opener; a full stop; no hint; no restated
  description; no step copied from another task or from an existing step. The
  merged set has no verbatim duplicates across slices. A parse-level comparison
  confirms that the merge changed nothing but the new steps.
