---
name: nis2-article-23-timelines
description: Apply the NIS2 Directive Article 23 incident-reporting clock — early warning, incident notification, final report — to a described incident. Use when asked what must be reported to a CSIRT and by when, or whether a reporting deadline has been met or missed.
license: proprietary
metadata:
  sourceRef: original guidance; cites Directive (EU) 2022/2555 Article 23 by article and paragraph
  version: '1'
  evaluation: evaluation-set.json
---

Article 23 sets three deadlines, each measured **from the moment the entity
became aware of the significant incident** — not from when it began, and not
from when it was resolved. Awareness is the clock's start and is itself a
finding worth recording.

| stage | deadline | content |
| --- | --- | --- |
| early warning | **24 hours** | whether suspected unlawful or malicious; whether cross-border impact is possible |
| incident notification | **72 hours** | severity, impact, indicators of compromise; updates the early warning |
| final report | **1 month** after the notification | detailed description, threat type, applied and ongoing mitigation, cross-border impact |

An intermediate report is owed on a CSIRT's request. Where the incident is
ongoing at one month, a **progress** report is owed then, and the final report
within one month of handling concluding.

## Applying it

1. Fix the awareness timestamp and say what established it — an alert, a report,
   a third-party notification. Everything else is derived from it.
2. Decide whether the incident is **significant**: severe operational disruption
   or financial loss, or material damage to others. If not significant, Article
   23 does not bite and say so plainly rather than reporting defensively. Then
   stop: give no due date, not even a hypothetical one, because the clock runs
   from awareness of a *significant* incident and none has started.
3. Compute each deadline from awareness and state the hours remaining or elapsed.
4. Where a deadline has passed, say so directly. A missed deadline is a finding,
   not something to soften.

## What this does not cover

Member-state transpositions may be stricter and name the CSIRT; entity scope
(essential vs important) changes supervision, not these three deadlines.
Voluntary notification of near-misses is Article 30, not 23.
