---
route: /t/[tenantSlug]/audits/cycles/[cycleId]/readiness
---

# Audit cycle readiness

A cycle's readiness page scores how ready you are for that audit, from 0 to 100, explains what makes up the score, and lists the gaps that lower it.

## Where to find it

On an audit cycle's page, click **{{ui:audits.cycles.viewReadiness}}**. The same button is on each card of the cycles list. The breadcrumb reads **{{ui:audits.crumb.dashboard}}** › **{{ui:audits.crumb.audits}}** › **{{ui:audits.crumb.cycles}}** › the cycle's name › **{{ui:audits.readiness.readinessReportCrumb}}**.

## Who can use it

Everyone who can see audits. The page changes nothing, and the exports download what it shows.

## What it is for

Find out, before the auditor arrives, which requirements are not covered, which controls lack evidence and which tasks are overdue, and fix the largest gaps first.

## What you see

**The score.** A ring with the score, coloured by band:

- {{ui:audits.readinessLegend.green}}
- {{ui:audits.readinessLegend.amber}}
- {{ui:audits.readinessLegend.red}}

For NIS2 the ring is labelled **{{ui:audits.readiness.nis2ControlCoverage}}**: {{ui:audits.readiness.nis2CoverageVsMaturity}}

**The breakdown.** One bar per part of the score, with its share of the score in brackets and the figure behind it:

| Part | Counts | ISO 27001 | NIS2 | Other frameworks |
| --- | --- | --- | --- | --- |
| **{{ui:audits.readiness.reqCoverage}}** | The framework's requirements mapped to a control | 35% | 40% | 50% |
| **{{ui:audits.readiness.controlsImplemented}}** | The mapped controls that are implemented | 25% | — | — |
| **{{ui:audits.readiness.evidenceCompleteness}}** | The mapped controls with current evidence, not archived or expired | 25% | 30% | 35% |
| **{{ui:audits.readiness.keyPolicies}}** | The mapped controls with a linked policy | — | 15% | — |
| **{{ui:audits.readiness.taskCompletion}}** | Overdue tasks lower it | 10% | — | — |
| **{{ui:audits.readiness.openIssues}}** | Open issues and open findings on the cycle's audits lower it | 5% | 15% | 15% |

Your workspace may use different shares: they can be set per framework for a workspace.

**{{ui:audits.readiness.trendTitle}}.** The score over time, once there are at least two scores to draw. A new point is recorded when the score moves.

**{{ui:audits.readiness.recommendedActions}}.** What to do next, worked out from the score's parts.

**Top gaps.** Up to ten unmapped requirements, ten controls without evidence (and for NIS2, ten without a policy), five overdue tasks and five open issues, each with its severity.

**{{ui:audits.readiness.exports}}.** **{{ui:audits.readiness.exportJson}}**, **{{ui:audits.readiness.exportUnmappedCsv}}** and **{{ui:audits.readiness.exportControlGapsCsv}}**.

## What you can do

### Find what to fix

Read the gaps, starting with the high-severity ones. Each names the requirement, control, task or issue to work on. Map a requirement to a control on the framework's page, attach evidence on the control's page, and close the task or issue on its own page. Come back to see the new score.

### Export the report

Click an export to download it. The JSON report holds the score, its parts, the recommendations and the gaps. **{{ui:audits.readiness.exportUnmappedCsv}}** lists the unmapped requirements among the gaps, and **{{ui:audits.readiness.exportControlGapsCsv}}** the controls without evidence, the overdue tasks and the open issues. Both hold the same gaps as the page, so at most ten unmapped requirements and ten controls.

## What happens next

- The score is worked out again each time the page opens, from your controls, evidence, policies and tasks as they are now.
- The cycles list and the readiness overview show the same score.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:audits.readiness.couldNotCompute}}** | The score could not be worked out, or the cycle does not exist in this workspace | Reload the page, or go back to the cycles list |
| No **{{ui:audits.readiness.trendTitle}}** card | Only one score has been recorded so far | Come back after your controls or evidence change |
| No top gaps | Nothing is lowering the score | Nothing to do |

## Related

- [An audit cycle](audit-cycle-detail.md), the cycle this score belongs to.
- [Audit readiness](audit-readiness.md), every cycle's score on one page.
- [{{ui:audits.cycles.title}}](audit-cycles.md).
