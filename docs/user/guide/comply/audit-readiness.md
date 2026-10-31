---
route: /t/[tenantSlug]/audits/readiness
---

# {{ui:audits.overview.title}}

The {{ui:audits.overview.title}} page brings together three different measures of how ready you are for an audit. {{ui:audits.overview.description}}

## Where to find it

Open **{{ui:nav.audits}}** under **{{ui:nav.comply}}** and click **{{ui:audits.hub.readiness}}** under **{{ui:audits.hub.lifecycleTitle}}**. The breadcrumb reads **{{ui:audits.crumb.dashboard}}** › **{{ui:audits.title}}** › **{{ui:audits.overview.crumb}}**.

## Who can use it

Everyone who can see audits. The page only reads.

## What it is for

Avoid confusing three numbers that all sound like readiness. Each answers a different question:

| Measure | Answers |
| --- | --- |
| **{{ui:audits.overview.coverageTitle}}** | Are your controls mapped to the framework, implemented, and backed by evidence? |
| **{{ui:audits.overview.maturityTitle}}** | How mature did you say you are, in your answers to the NIS2 gap questionnaire? |
| **{{ui:audits.overview.testTitle}}** | Are your mapped controls tested, and do the tests pass? |

## What you see

**{{ui:audits.overview.coverageTitle}}.** {{ui:audits.overview.coverageHelp}} One row per audit cycle, with its name, its framework and its coverage score, and **{{ui:audits.overview.viewCoverage}}**.

**{{ui:audits.overview.maturityTitle}}.** Shown once a NIS2 gap assessment has been answered. {{ui:audits.overview.maturityHelp}} The score, labelled **{{ui:audits.overview.maturityLabel}}**, and **{{ui:audits.overview.openGapAssessment}}**.

**{{ui:audits.overview.testTitle}}.** {{ui:audits.overview.testHelp}} One card per framework, each with three figures: how many mapped controls have a test plan, how many have had a test run, and how many recent runs passed. **{{ui:audits.overview.openTestDashboard}}** is in the corner.

## What you can do

### See a cycle's score

Click a cycle's row. Its readiness page opens, with the score and what lowers it. See [Audit cycle readiness](audit-cycle-readiness.md).

### Continue the NIS2 gap assessment

Click **{{ui:audits.overview.openGapAssessment}}**.

### Look at testing

Click **{{ui:audits.overview.openTestDashboard}}** to see each control's test plans and runs.

## What happens next

- Each figure is worked out when the page opens, from your records as they are now.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:audits.overview.coverageEmpty}}** | The workspace has no audit cycle | Create one on the cycles page |
| No **{{ui:audits.overview.maturityTitle}}** card | No NIS2 gap assessment has been answered | Open the NIS2 gap assessment from the audits page |
| **{{ui:audits.overview.testEmpty}}** | No control is mapped to a framework yet | Map controls to a framework |
| **{{ui:audits.overview.loadFailed}}**, in one of the sections | That section's figures could not load; the others are unaffected | Click **{{ui:audits.overview.retry}}** in that section |

## Related

- [Audit cycle readiness](audit-cycle-readiness.md), one cycle's score in detail.
- [{{ui:audits.cycles.title}}](audit-cycles.md), each cycle with its score.
- [{{ui:audits.title}}](audits.md), the audits hub.
