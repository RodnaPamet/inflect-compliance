---
route: /t/[tenantSlug]/tests/plans/[planId]
---

# A test plan

A test plan's page shows one plan: the control it tests, its procedure, its schedule and the history of its runs. From here you edit the plan and start a run.

## Where to find it

There are two ways in, and both show the same page:

- From **{{ui:nav.tests}}** under **{{ui:nav.comply}}**: click a plan in the list. The breadcrumb reads **{{ui:controls.detailPage.breadcrumbDashboard}}** › **{{ui:controls.detailPage.breadcrumbTests}}** › the plan's name.
- From a control's page: open its test plans and click one. The breadcrumb then runs through **{{ui:controls.detailPage.breadcrumbControls}}** and the control's name.

The arrows beside the plan's name step to the previous or next plan in the list you came from.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the plan, its schedule and its runs | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Edit the plan and change its schedule | Owner, Admin, Editor |
| Start or continue a run | Owner, Admin, Editor |

**{{ui:controls.testPlan.edit}}**, **{{ui:controls.testPlan.runTestNow}}** and **{{ui:controls.testPlan.newRun}}** appear only for Owners, Admins and Editors. For other roles the schedule's picker is disabled, with the note **{{ui:panels.schedule.permissionDenied}}**

Some plans run an audit procedure for the workspace's auditor agent. Only the person who owns that agent can pause, archive or reschedule such a plan; anyone else's change is refused.

If your workspace uses custom roles, the server checks your custom role's own permissions for test plans. The buttons the page shows still follow the built-in role your custom role is based on.

## What it is for

Use the page to keep one control's testing on track: read what the test involves, run it when it is due, and see whether the control has been passing.

## What you see

**The header.** The plan's name, its status (**{{ui:controlTests.planStatus.ACTIVE}}**, **{{ui:controlTests.planStatus.PAUSED}}** or **{{ui:controlTests.planStatus.ARCHIVED}}**), its frequency, whether it is **{{ui:controlTests.method.MANUAL}}** or **{{ui:controlTests.method.AUTOMATED}}**, and when it is next due, in red when that date has passed. The due date is the earlier of the plan's frequency date and its next scheduled run.

**{{ui:panels.schedule.title}}.** The cadence on which runs are created, and the date of the next one. {{ui:panels.schedule.instantiationNote}} The times are in your browser's time zone.

**The cards.** **{{ui:controls.testPlan.totalRuns}}**, **{{ui:controls.testPlan.passed}}**, **{{ui:controls.testPlan.failed}}** and **{{ui:controls.testPlan.steps}}**.

**{{ui:controls.testPlan.description}}** and **{{ui:controls.testPlan.testProcedure}}.** The plan's description, and its numbered steps, each with its expected result where one was given. Both are hidden when empty.

**{{ui:controls.testPlan.runHistory}}.** The plan's most recent runs, newest first, each with its status, its result, when it was run, who ran it and how much evidence it holds. When the plan has more runs than are listed, a note says how many are shown. Click a run to open it.

**The footer.** When the plan was created, by whom, and its owner.

## What you can do

### Start a run

Click **{{ui:controls.testPlan.runTestNow}}** in the header, or **{{ui:controls.testPlan.newRun}}** above the run history. A new run is created and opens on its own page, where you work through the procedure and record the result.

A plan has at most one open run at a time. While one is planned or in progress, both buttons read **{{ui:controls.testPlan.continueRun}}** and take you back to it.

Only an {{ui:controlTests.planStatus.ACTIVE}} plan takes runs. A paused or archived plan shows no run buttons.

### Edit the plan

Click **{{ui:controls.testPlan.edit}}**. The form holds:

- **{{ui:controls.testPlan.name}}** and **{{ui:controls.testPlan.description}}**.
- **{{ui:controls.testPlan.frequency}}**, from **{{ui:controls.freq.adHoc}}** to **{{ui:controls.freq.annually}}**.
- **{{ui:controls.testPlan.status}}**: **{{ui:controls.planStatus.active}}**, **{{ui:controls.planStatus.paused}}** or **{{ui:controls.planStatus.archived}}**. Archive a plan to retire it and keep its history.
- **{{ui:controls.testPlan.testProcedure}}**: the steps, each with an instruction and an optional expected result. A step with an expected result but no instruction stops the save until you fix it.

Click **{{ui:controls.testPlan.saveChanges}}**, or **{{ui:controls.testPlan.cancel}}** to discard your edits. Whether a plan is manual or automated is not set here.

### Set the schedule

In **{{ui:panels.schedule.title}}**, choose a cadence: **{{ui:panels.schedule.cadOffLabel}}**, **{{ui:panels.schedule.cadDailyLabel}}**, **{{ui:panels.schedule.cadWeeklyLabel}}**, **{{ui:panels.schedule.cadMonthlyLabel}}** or **{{ui:panels.schedule.cadQuarterlyLabel}}**. Then click **{{ui:panels.schedule.save}}**. If the plan was given a custom schedule elsewhere, a warning says that choosing a cadence will replace it.

Saving a cadence here makes the plan a manual plan, even if it was automated before.

## What happens next

A scheduled run appears in the run history at its time, planned and waiting for someone to complete it. Completing a run updates the cards, the plan's last result on the {{ui:nav.tests}} list and the control's health.

## Empty and error states

| What you see | Why | What to do |
| --- | --- | --- |
| **{{ui:controls.testPlan.runsEmpty}}** | The plan has never been run | Start a run |
| **{{ui:controls.testPlan.planForbidden}}** | Your role cannot see test plans | Ask an admin for access |
| **{{ui:controls.testPlan.planNotFound}}** | The plan was deleted, or the link is wrong | Go back to {{ui:nav.tests}} |
| **{{ui:controls.testPlan.planLoadFailed}}** | The plan could not be read | Reload the page |
| **{{ui:controls.testPlan.saveFailed}}** | The change was refused or failed | Check your role and the plan's fields, then try again |
| **{{ui:controls.testPlan.runFailed}}** | The run could not be created | Check that the plan is active, then try again |
| A red message under the schedule | The schedule could not be saved. The message gives the reason | Fix what it names and save again |

## Related

- [{{ui:controlTests.list.title}}](tests.md), the list of every test plan.
- [A test run](test-run.md), where a run is worked through and its result recorded.
- [{{ui:controlTests.dashboard.title}}](tests-dashboard.md), for testing rates across the workspace.
- [A control](../govern/control-detail.md), the page of the control the plan tests.
