---
route: /t/[tenantSlug]/controls/[controlId]/tests/[planId]
---

# A control's test plan

This is a test plan's page, opened from the control it tests. It is the same page as [a test plan](../comply/test-plan.md) opened from **{{ui:nav.tests}}**, with the same procedure, schedule, runs and buttons. Only the way back and the arrows between plans differ.

## Where to find it

On a [control's page](control-detail.md), open the **{{ui:controls.detailPage.tabTests}}** tab and click a plan. The breadcrumb reads **{{ui:controls.detailPage.breadcrumbDashboard}}** › **{{ui:controls.detailPage.breadcrumbControls}}** › the control's name › the plan's name, so you can go back to the control in one click.

## Who can use it

The same as [a test plan](../comply/test-plan.md#who-can-use-it): every role can read the plan and its runs; Owners, Admins and Editors can edit it, change its schedule and run it.

## How it differs from the Tests entry

| | Opened from the control | Opened from {{ui:nav.tests}} |
| --- | --- | --- |
| The breadcrumb | Runs through **{{ui:controls.detailPage.breadcrumbControls}}** and the control's name | Runs through **{{ui:nav.tests}}** |
| The arrows beside the plan's name | Step through this control's plans only | Step through the plans in the list you came from |

A run of the plan opens on its own page under **{{ui:nav.tests}}**; its breadcrumb still leads back to the control.

## What you see and what you can do

See [a test plan](../comply/test-plan.md): the plan's status, frequency and due date, its schedule, its procedure, and the history of its runs, with **{{ui:controls.testPlan.edit}}**, **{{ui:controls.testPlan.runTestNow}}** and **{{ui:controls.testPlan.newRun}}** for the roles that may use them.

## Related

- [A test plan](../comply/test-plan.md), the full guide to this page.
- [A control](control-detail.md), where its test plans are listed.
- [A test run](../comply/test-run.md), what opens when you run the plan.
