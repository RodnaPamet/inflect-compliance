---
route: /t/[tenantSlug]/tests
---

# {{ui:controlTests.list.title}}

The {{ui:controlTests.list.title}} page lists every test plan in the workspace: the checks a person runs against a control, on a schedule or on demand, with each plan's last result. A second view lists the automated checks the platform runs against your connected systems.

## Where to find it

Open **{{ui:nav.tests}}** under **{{ui:nav.comply}}** in the sidebar. The breadcrumb reads **{{ui:controlTests.crumb.dashboard}}** › **{{ui:controlTests.crumb.tests}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page, the list of test plans and the automated checks | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Create a test plan | Owner, Admin, Editor |
| Change the status or owner of several plans at once | Owner, Admin, Editor |
| Delete several plans at once | Owner, Admin |
| Start a run with **{{ui:controlTests.due.runNow}}** or **{{ui:controlTests.due.runPlanning}}** | Owner, Admin, Editor |

**{{ui:controlTests.due.runNow}}** and **{{ui:controlTests.due.runPlanning}}** appear only for Owners, Admins and Editors. The **{{ui:controlTests.unified.testPlanNoun}}** button and the row tick boxes appear for every role, but only the roles above can use them: for anyone else the change is refused with a general error message. Bulk delete is likewise offered to Editors, and refused after the five-second undo window.

Some plans run an audit procedure for the workspace's auditor agent. Only the person who owns that agent can pause, archive or delete such a plan.

If your workspace uses custom roles, the server checks your custom role's own permissions for test plans. The buttons the page shows still follow the built-in role your custom role is based on.

## What it is for

Use the page to keep control testing on schedule: see which plans are overdue or due this week, start their runs, and spot the controls whose last test failed.

## What you see

**The header.** A sentence explaining the difference between tests and checks, and two buttons that switch the view: **{{ui:controlTests.unified.tabPlans}}** and **{{ui:controlTests.unified.tabChecks}}**. In the plans view, the **{{ui:controlTests.unified.testPlanNoun}}** button with a plus sign opens the new-plan form.

**The cards.** Four cards count the plans: **{{ui:controlTests.kpi.total}}**, **{{ui:controlTests.kpi.active}}**, **{{ui:controlTests.kpi.paused}}** and **{{ui:controlTests.kpi.archived}}**. Click a status card to list only plans with that status; click it again to clear it. The status cards count the plans that match your other filters, so each card's number is the number of rows its click gives you. **{{ui:controlTests.kpi.total}}** always counts every plan. A card can carry a small trend line once the workspace has a few days of history. The gear beside the filter chooses which cards are shown.

**The filter and toolbar.** **{{ui:controlTests.list.searchPlaceholder}}** searches plan names as you type. The filter offers:

| Filter | Options |
| --- | --- |
| {{ui:controlTests.filters.status}} | {{ui:controlTests.planStatus.ACTIVE}}, {{ui:controlTests.planStatus.PAUSED}}, {{ui:controlTests.planStatus.ARCHIVED}} |
| {{ui:controlTests.filters.result}} | {{ui:controlTests.result.PASS}}, {{ui:controlTests.result.FAIL}}, {{ui:controlTests.result.INCONCLUSIVE}}, {{ui:controlTests.list.noRuns}}, {{ui:controlTests.list.inProgress}} |
| {{ui:controlTests.filters.frequency}} | {{ui:controlTests.freq.adHoc}}, {{ui:controlTests.freq.daily}}, {{ui:controlTests.freq.weekly}}, {{ui:controlTests.freq.monthly}}, {{ui:controlTests.freq.quarterly}}, {{ui:controlTests.freq.annually}} |
| {{ui:controlTests.filters.due}} | {{ui:controlTests.filterEnums.due.overdue}}, {{ui:controlTests.filterEnums.due.next7d}} |

Only {{ui:controlTests.planStatus.ACTIVE}} plans count as overdue or due. **{{ui:controlTests.filterEnums.due.next7d}}** includes the plans that are already overdue, so it is everything that needs running this week.

Beside the filter, three buttons: one opens the tests **{{ui:controlTests.nav.dashboard}}**, one runs due planning (Owners, Admins and Editors only; see below), and one opens **{{ui:controlTests.nav.accessReviews}}**.

**The list of test plans.**

| Column | What it shows |
| --- | --- |
| {{ui:controlTests.colHeaders.name}} | The plan's name, linking to the plan |
| {{ui:controlTests.colHeaders.status}} | {{ui:controlTests.planStatus.ACTIVE}}, {{ui:controlTests.planStatus.PAUSED}} or {{ui:controlTests.planStatus.ARCHIVED}}. An archived plan is a retired test, kept for its history; it takes no new runs |
| {{ui:controlTests.colHeaders.control}} | The control the plan tests, linking to it |
| {{ui:controlTests.colHeaders.method}} | {{ui:controlTests.method.MANUAL}} or {{ui:controlTests.method.AUTOMATED}} |
| {{ui:controlTests.colHeaders.frequency}} | How often the plan is due |
| {{ui:controlTests.colHeaders.nextDue}} | When the plan is next due, in red when it is overdue |
| {{ui:controlTests.colHeaders.lastResult}} | The result of the latest run, **{{ui:controlTests.list.inProgress}}** while that run has no result yet, or **{{ui:controlTests.list.noRuns}}** |
| {{ui:controlTests.colHeaders.runs}} | How many runs the plan has had |

Click a column heading to sort by it. The gear above the table chooses which columns are shown. Click a row to open the plan. For Owners, Admins and Editors, a plan that is due within seven days, or overdue, and has no run in progress shows **{{ui:controlTests.due.runNow}}** at the end of its row.

**The automated checks.** **{{ui:controlTests.unified.tabChecks}}** lists the latest result of each automated check: the **{{ui:controlTests.checksList.colCheck}}** and the **{{ui:controlTests.checksList.colProvider}}**, both as the integration names them, the **{{ui:controlTests.colHeaders.control}}** it evidences, its **{{ui:controlTests.colHeaders.status}}**, such as **{{ui:controlTests.checkStatus.PASSED}}**, **{{ui:controlTests.checkStatus.FAILED}}** or **{{ui:controlTests.checkStatus.NOT_APPLICABLE}}**, and when it **{{ui:controlTests.checksList.colExecuted}}**. Click a row to open its control. Switching to this view clears the plan filters.

## What you can do

### Create a test plan

Click **{{ui:controlTests.unified.testPlanNoun}}**. The **{{ui:controlTests.unified.createTitle}}** form asks for:

- **{{ui:controlTests.unified.createControl}}**, the control to test. Required.
- **{{ui:controlTests.unified.createName}}**. Required.
- **{{ui:controlTests.colHeaders.frequency}}**, starting on **{{ui:controlTests.freq.adHoc}}**. {{ui:controlTests.unified.frequencyHint}}
- **{{ui:controlTests.steps.label}}**, optional: the steps a tester follows during a run, each with an instruction and, optionally, its expected result. Use **{{ui:controlTests.steps.add}}** to add one and the arrows to reorder them.

Click **{{ui:controlTests.unified.createConfirm}}**. The message **{{ui:controlTests.unified.createSuccess}}** confirms it, and the plan joins the list as {{ui:controlTests.planStatus.ACTIVE}}.

### Start a run

Click **{{ui:controlTests.due.runNow}}** on a plan's row. A run is created and its page opens, where you work through the steps and record the result.

To open runs for everything that is due at once, click the due-planning button in the toolbar. It creates a run for every {{ui:controlTests.planStatus.ACTIVE}} plan that is due now and has no run waiting already, then refreshes the list. The message **{{ui:controlTests.due.planningDone}}** confirms it. Plans on a fixed schedule get their runs from the schedule instead.

### Change several plans at once

Tick the plans, then choose an action in the bar that appears:

- **{{ui:controlTests.bulk.setStatus}}**, then a status: Active, Paused or Archived.
- **{{ui:controlTests.bulk.assignOwner}}**, then a person. Leave it blank to remove the owner.
- **{{ui:controlTests.bulk.delete}}**, which asks you to confirm. The plans leave the list at once, and a message with **{{ui:controlTests.list.bulkDeleteUndo}}** gives you five seconds to bring them back before they are deleted.

The message **{{ui:controlTests.list.bulkApplied}}** confirms a status or owner change.

## What happens next

- A plan's runs, and their results, appear on the plan and on its control. A failed run's result shows in **{{ui:controlTests.colHeaders.lastResult}}**.
- Pausing a plan stops it counting as overdue; it is not expected to run until it is active again.
- Creating a plan, changing it in bulk, deleting it and running due planning are recorded in the workspace's audit log, naming who did it.
- A deleted plan is kept for a time and can be restored, though not from this page.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:controlTests.list.loading}}** | The page is loading | Wait a moment |
| **{{ui:controlTests.list.emptyNone}}** | The workspace has no test plans | Owners, Admins and Editors click **{{ui:controlTests.unified.testPlanNoun}}** |
| **{{ui:controlTests.list.emptyFiltered}}** | No plan matches the filter or search | Clear the filter |
| **{{ui:controlTests.list.loadErrorTitle}}** | The list did not load | Click **{{ui:controlTests.list.retry}}** |
| **{{ui:controlTests.modal.controlsLoadError}}** | The form could not load the controls to choose from | Close the form and try again |
| **{{ui:controlTests.unified.createFailed}}** | The plan was not created. Your role may not create plans | Check that you are an Owner, Admin or Editor, then try again |
| **{{ui:controlTests.list.bulkFailed}}** | The change was not made, and the list shows the plans as they are. Your role may not make it, or a plan runs an audit procedure only its agent's owner may change | Check your role, or leave procedure plans to their owner |
| **{{ui:controlTests.due.runFailed}}** | The run was not started | Try again from the plan's own page |
| **{{ui:controlTests.due.planningFailed}}** | Due planning did not run | Try again |
| A message under **{{ui:controlTests.unified.tabChecks}}** that no automated checks have run | No control is collecting evidence from a connected system yet | Connect a system on the integrations page and set a control's evidence to come from it |

## Related

- [{{ui:controls.title}}](../govern/controls.md), where each plan's control lives.
- [{{ui:audits.title}}](audits.md), whose readiness counts test results.
- [{{ui:findings.title}}](findings.md), where a failed test's finding is tracked.
