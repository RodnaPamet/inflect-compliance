---
name: evidence-sufficiency
description: Judge whether a piece of evidence actually supports the control or requirement it is attached to, and say what is missing. Use when asked if evidence is adequate, what an auditor would reject, or what to collect instead.
license: proprietary
metadata:
  sourceRef: original guidance
  version: '1'
  evaluation: evaluation-set.json
---

Evidence is sufficient when a reader who distrusts the claim could verify it
from the artefact alone. Most rejected evidence fails on one of five axes, and
naming the axis is more useful than a verdict.

## The five tests

1. **Does it show the control operating, or only that it exists?** A policy
   proves a policy exists. A review record proves the review happened. Design
   and operating effectiveness are different claims and auditors test both.
2. **Is it in the period?** Evidence from before the audit period says nothing
   about it. A screenshot with no date is undated, not recent.
3. **Is the population right?** A sample of five from a population of five
   thousand supports a conclusion about five, unless the selection method is
   stated. An export filtered to the passing rows is not a population.
4. **Is it attributable?** Who performed it, under which account, approved by
   whom. An artefact nobody owns cannot show segregation of duties.
5. **Is it tamper-evident enough for its weight?** A pasted table is weaker than
   a system export; an export is weaker than one with a system-generated
   timestamp and identifier.

## Saying what is missing

Never answer only "insufficient". Name the axis and the smallest artefact that
would fix it: "shows the policy, not the practice — attach the last quarterly
review record with the reviewer and date".

## Two traps

A **screenshot of a dashboard** shows the state when it was taken, not the state
across the period, and not that anyone looked. Prefer the record of the action.

**Absence of exceptions is not evidence of operation.** A report with no findings
is consistent with the control working and with it never having run. Ask for the
artefact that shows it ran.
