---
route: /t/[tenantSlug]/frameworks/[frameworkKey]/readiness
---

# {{ui:frameworks.readiness.heading}}

The {{ui:frameworks.readiness.heading}} page turns your answers to the NIS2 gap self-assessment into a maturity score, shows which areas are weakest, and lists the gaps in the order to fix them.

## Where to find it

On the NIS2 gap assessment page, click **{{ui:audits.nis2Gap.viewCoverage}}**. The page exists for NIS2 only: for any other framework it shows {{ui:frameworks.readiness.onlyNis2}}

## Who can use it

| Action | Roles |
| --- | --- |
| View the score, the domains and the gaps | Everyone who can see audits |
| Create findings and tasks from the gaps | Owner, Admin, Editor |

## What it is for

See how far you are from NIS2's security measures by your own account, and turn the serious gaps into work. {{ui:frameworks.readiness.disclaimer}}

The score is not the NIS2 control coverage shown on an audit cycle's readiness page. That one measures your controls; this one measures your answers.

## What you see

**Three figures.**

| Figure | Meaning |
| --- | --- |
| **{{ui:frameworks.readiness.scoreLabel}}** | Your answers' weighted maturity, from 0 to 100 |
| **{{ui:frameworks.readiness.fineExposureLabel}}** | Gaps on which NIS2 sets fines |
| **{{ui:frameworks.readiness.openGapsLabel}}** | Questions answered no or partly, with how many questions you have answered so far |

**{{ui:frameworks.readiness.overTime}}.** The score at each point it was recorded, once there are at least two.

**{{ui:frameworks.readiness.domainBreakdown}}.** Each of the assessment's domains with its **{{ui:frameworks.readiness.colScore}}** and how many of its questions are **{{ui:frameworks.readiness.colAnswered}}**, weakest first. Above the table, the domains to start with.

**{{ui:frameworks.readiness.prioritizedGaps}}.** One row per gap, most urgent first, with the **{{ui:frameworks.readiness.colGap}}**, its **{{ui:frameworks.readiness.colCriticality}}**, your **{{ui:frameworks.readiness.colAnswer}}**, its **{{ui:frameworks.readiness.colPriority}}**, the **{{ui:frameworks.readiness.colEffort}}** to fix it and its **{{ui:frameworks.readiness.colLegalBasis}}** in the directive. A gap's priority weighs how critical it is, what failing it costs, whether it carries a fine and how quickly it can be fixed.

## What you can do

### Turn the serious gaps into findings

1. Click **{{ui:frameworks.readiness.createFindings}}**.
2. Read **{{ui:frameworks.readiness.confirmTitle}}** and confirm. A finding is created for each high or critical gap, with a remediation task. You can close or delete them afterwards.

The page then says how many findings and tasks were created, reopened and closed.

### Change your answers

Go back to the NIS2 gap assessment and run it again. The score, the domains and the gaps follow your latest answers.

## What happens next

- Each finding names its gap and carries a remediation task. Work on them on the [findings](../comply/findings.md) and [tasks](../comply/tasks.md) pages.
- Running **{{ui:frameworks.readiness.createFindings}}** again creates no duplicates: it closes the findings for gaps you have resolved and reopens those that came back.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:frameworks.readiness.onlyNis2}} | The page was opened for another framework | Open it from the NIS2 gap assessment |
| **{{ui:frameworks.readiness.loadFailed}}** | The score could not load | Reload the page |
| **{{ui:frameworks.readiness.createFindings}}** unavailable | No gap is high or critical | Nothing to turn into findings |
| **{{ui:frameworks.readiness.createFailed}}** | No finding was created | Try again |

## Related

- [{{ui:audits.nav.nis2Gap}}](../comply/nis2-gap.md), where you answer the questions.
- [Audit cycle readiness](../comply/audit-cycle-readiness.md), the control coverage score.
- [{{ui:audits.overview.title}}](../comply/audit-readiness.md), both scores side by side.
