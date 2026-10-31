---
route: /t/[tenantSlug]/tests/dashboard
---

# {{ui:controlTests.dashboard.title}}

The {{ui:controlTests.dashboard.title}} shows how control testing is going across the workspace: how many runs were completed and passed, which controls keep failing, how scheduled testing is keeping up, and how well each framework's controls are covered by tests.

## Where to find it

Open **{{ui:nav.tests}}** under **{{ui:nav.comply}}** in the sidebar and click the **{{ui:controlTests.nav.dashboard}}** button beside the filter. The breadcrumb reads **{{ui:controlTests.crumb.dashboard}}** › **{{ui:controlTests.crumb.tests}}** › **{{ui:controlTests.dashboard.crumb}}**.

## Who can use it

Every role can open the dashboard: Owner, Admin, Editor, Reader, Auditor and AI admin. It changes nothing.

## What it is for

Use it to judge whether testing is healthy, rather than to work through it. The {{ui:controlTests.list.title}} list and its due filters are where you act on individual plans.

## What you see

**The period.** Two buttons in the header choose whether the run figures cover the last 30 or the last 90 days. The framework coverage below always covers 90 days.

**The rate cards.**

| Card | What it measures |
| --- | --- |
| {{ui:controlTests.dashboard.kpi.completionRate}} | Completed runs out of all runs created in the period |
| {{ui:controlTests.dashboard.kpi.passRate}} | Passed runs out of completed runs |
| {{ui:controlTests.dashboard.kpi.failRate}} | Failed runs out of completed runs |
| {{ui:controlTests.dashboard.kpi.evidenceRate}} | Completed runs with at least one piece of evidence attached |

Each card is green, amber or red against fixed thresholds: 80% and 50% for the completion, pass and evidence rates, 10% and 30% for the fail rate. With no runs in the period every rate reads 0%.

**The overdue card.** The number of active plans that are overdue, counting both their frequency date and their schedule. Click it, or **{{ui:controlTests.dashboard.viewQueue}}**, to open the {{ui:controlTests.list.title}} list filtered to exactly those plans.

**The result distribution.** A gauge of the overall pass rate and a bar each for **{{ui:controlTests.dashboard.pass}}**, **{{ui:controlTests.dashboard.fail}}** and **{{ui:controlTests.dashboard.inconclusive}}**.

**{{ui:controlTests.dashboard.repeatedFailures}}.** Controls whose tests failed at least twice in the period, each with its number of failures. Click one to open the control.

**{{ui:panels.testDashG2.automation}}.** How many plans run on a schedule, how many are manual and how many are automated. **{{ui:panels.testDashG2.overdueScheduled}}** counts the scheduled plans whose next run has passed and lists the five most overdue, each linking to its plan. Beside it, a chart of the runs completed each day in the period.

**{{ui:controlTests.dashboard.fwCoverage}}.** For each framework with mapped controls:

| Measure | What it shows |
| --- | --- |
| {{ui:controlTests.dashboard.testPlanCoverage}} | How many of the framework's controls have an active test plan |
| {{ui:controlTests.dashboard.recentRunCoverage}} | How many of them were tested in the last 90 days |
| {{ui:controlTests.dashboard.kpi.passRate}} | How many of those recent runs passed |

This is test coverage only. **{{ui:controlTests.dashboard.coverageMapLink}}** opens the coverage map, which shows how risks, assets and controls protect each other.

## What you can do

- **Change the period** with the 30- and 90-day buttons.
- **Open the overdue plans** from the overdue card.
- **Open a failing control** from **{{ui:controlTests.dashboard.repeatedFailures}}**, or an overdue scheduled plan from **{{ui:panels.testDashG2.overdueScheduled}}**.

## What happens next

The dashboard is read-only. Completing runs, attaching evidence and scheduling plans change its figures the next time it loads.

## Empty and error states

| What you see | Why | What to do |
| --- | --- | --- |
| **{{ui:controlTests.dashboard.noCompleted}}** | No run was completed in the period | Switch to 90 days, or complete a run |
| **{{ui:controlTests.dashboard.noRepeatedFailures}}** | No control failed twice in the period | Nothing to do |
| **{{ui:panels.testDashG2.scheduledPlansEmpty}}** | No plan has a schedule | Set a schedule on a test plan's page |
| No **{{ui:controlTests.dashboard.fwCoverage}}** section | No framework has mapped controls, or the coverage could not be read | Install a framework; if you have one, reload the page |
| **{{ui:controlTests.dashboard.loadErrorTitle}}** with **{{ui:controlTests.dashboard.retry}}** | The testing figures could not be read | Click **{{ui:controlTests.dashboard.retry}}** |

## Related

- [{{ui:controlTests.list.title}}](tests.md), the list of every test plan.
- [A test plan](test-plan.md) and [a test run](test-run.md), where testing is done.
- [{{ui:controls.dashboard.title}}](../govern/controls-dashboard.md), for the control register's figures.
