---
route: /t/[tenantSlug]/controls
---

# {{ui:controls.list.pageTitle}}

The {{ui:controls.list.pageTitle}} page lists every control in the workspace: the measures your organisation takes to meet its frameworks and treat its risks. It shows each control's status, whether it applies, how healthy it is, who owns it and how much work and evidence sit behind it.

## Where to find it

Open **{{ui:nav.controls}}** under **{{ui:nav.govern}}** in the sidebar. The breadcrumb reads **{{ui:controls.list.breadcrumbDashboard}}** › **{{ui:controls.list.breadcrumbControls}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| View the list, the cards, the **{{ui:controls.list.browse}}** panel and a control's quick view | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Open **{{ui:controls.list.sankeyFlow}}** and the **{{ui:controls.list.controlsDashboard}}** | Every role |
| Create a control, or install controls from templates | Owner, Admin, Editor |
| Edit a control in its quick view, and upload evidence there | Owner, Admin, Editor |
| Set status or assign an owner in bulk | Owner, Admin, Editor |
| Delete in bulk | Owner, Admin |
| Open **{{ui:controls.deleted.toggle}}**, restore and purge | Owner, Admin |

Readers, Auditors and AI admins see the quick view with its fields greyed out. Every role can tick rows, but the selection bar offers only the bulk actions your role can apply, and a role that can apply none of them sees no actions there. The **{{ui:controls.list.aiAssist}}** panel is shown only to roles that can edit controls.

If your workspace uses custom roles, what you can do depends on the permissions your role was given. The page decides some buttons from your role's base role, so a custom role can be offered an action that it is then refused. If a change fails that way, ask an Owner or Admin.

## What it is for

Use the page to see where implementation stands across every framework at once: which controls are done, which are in progress or not started, which have been scoped out, and which are failing their tests or lack evidence. From here you open a control to work on it, or change many controls in one go.

## What you see

**Summary cards.** Four cards sit above the table, each with a trend line drawn from the workspace's daily snapshots:

| Card | What it counts | Clicking it |
| --- | --- | --- |
| {{ui:controls.kpi.total}} | Every control in the workspace, whatever the filters | Clears every filter and the search |
| {{ui:controls.kpi.implemented}} | Controls that are {{ui:controls.filterEnums.status.IMPLEMENTED}} | Filters to that status |
| {{ui:controls.kpi.inProgress}} | Controls that are {{ui:controls.filterEnums.status.IN_PROGRESS}} or {{ui:controls.filterEnums.status.IMPLEMENTING}} | Filters to those two statuses |
| {{ui:controls.kpi.notStarted}} | Controls that are {{ui:controls.filterEnums.status.NOT_STARTED}}. The card turns red when there are any | Filters to that status |

The three status cards count within your search and your other filters, except {{ui:controls.filters.category}}. Click a selected card again to remove its filter.

**The toolbar.** From left to right:

- **{{ui:controls.addControl}}**, the button with a plus sign, opens the **{{ui:controls.new.title}}** dialog. Only roles that can create controls see it.
- **{{ui:common.ui.filter}}** holds the search and the filters. Its search box, **{{ui:controls.searchPlaceholder}}**, filters the table as you type and matches a control's name, code and objective. The filters are {{ui:controls.filters.status}}, {{ui:controls.filters.applicability}}, {{ui:controls.filters.owner}}, {{ui:controls.filters.category}} and {{ui:controls.filters.health}}. The owner and category lists offer only values that appear in the controls already listed. Each active filter shows as a pill; remove a pill to drop that filter.
- **{{ui:common.ui.viewsMenu}}** holds **{{ui:controls.list.sankeyFlow}}**, a diagram of how assets expose risks and controls mitigate them; **{{ui:controls.list.installTemplates}}**, for roles that can create controls; and **{{ui:controls.deleted.toggle}}**, for Owners and Admins.
- The dashboard button opens the **{{ui:controls.dashboard.title}}**.
- Two settings buttons close the row: **{{ui:common.table.toggleColumns}}** chooses the table's columns, and **{{ui:common.table.editKpiCards}}** chooses which summary cards are shown and in what order. Both choices are remembered in your browser.

Filters and the search are kept in the page address, so a filtered view can be bookmarked or shared with a colleague who has access to the workspace.

**The table.** Each row is one control. Click a row to tick it, and double-click it to open the control's own page. Click a column heading to sort by {{ui:controls.colHeaders.code}}, {{ui:controls.colHeaders.title}}, {{ui:controls.colHeaders.category}}, {{ui:controls.colHeaders.status}}, {{ui:controls.colHeaders.owner}} or {{ui:controls.colHeaders.frequency}}. A long list loads more rows as you scroll.

| Column | What it shows |
| --- | --- |
| {{ui:controls.colHeaders.code}} | The control's code, or its Annex reference. Hidden until you turn it on |
| {{ui:controls.colHeaders.title}} | The control's name. Click it to open the quick view |
| {{ui:controls.colHeaders.framework}} | Every framework the control is mapped to through its requirements. A control mapped to none shows a label worked out from its code, or a dash |
| {{ui:controls.colHeaders.category}} | For an ISO 27001 control, its Annex A domain. For any other control, the category saved on it; a control of another known framework with no category shows that framework's name. A dash means neither |
| {{ui:controls.colHeaders.status}} | {{ui:controls.filterEnums.status.NOT_STARTED}}, {{ui:controls.filterEnums.status.PLANNED}}, {{ui:controls.filterEnums.status.IN_PROGRESS}}, {{ui:controls.filterEnums.status.IMPLEMENTING}}, {{ui:controls.filterEnums.status.IMPLEMENTED}}, {{ui:controls.filterEnums.status.NEEDS_REVIEW}} or {{ui:controls.filterEnums.status.NOT_APPLICABLE}} |
| {{ui:controls.colHeaders.applicability}} | **{{ui:controls.list.yes}}** when someone decided the control applies, **{{ui:controls.list.na}}** when it was scoped out, and **{{ui:controls.list.notAssessed}}** when nobody has decided |
| {{ui:controls.list.healthColumn}} | The control's health verdict, described below. A dash while it loads |
| {{ui:controls.colHeaders.owner}} | The person accountable for the control |
| {{ui:controls.colHeaders.frequency}} | How often the control is reviewed or tested. Hidden until you turn it on |
| {{ui:controls.colHeaders.tasks}} | Linked tasks that are resolved or closed, out of all linked tasks. Green when every one is done |
| {{ui:controls.colHeaders.evidence}} | How many pieces of evidence are linked to the control |

The health verdict looks at the control's status, its applicability, its next test date and its test runs over the last 90 days. The first rule that fits decides:

1. **{{ui:controls.health.verdict.NOT_APPLICABLE}}**: the control is scoped out.
2. **{{ui:controls.health.verdict.UNKNOWN}}**: it has no test run in the last 90 days and is not {{ui:controls.filterEnums.status.IMPLEMENTED}}.
3. **{{ui:controls.health.verdict.AT_RISK}}**: fewer than 70% of its tests passed, or it is {{ui:controls.filterEnums.status.NOT_STARTED}}.
4. **{{ui:controls.health.verdict.DEGRADED}}**: its next test is overdue, or fewer than 90% of its tests passed.
5. **{{ui:controls.health.verdict.HEALTHY}}**: none of the above.

An {{ui:controls.filterEnums.status.IMPLEMENTED}} control that has never been tested and is not overdue therefore reads {{ui:controls.health.verdict.HEALTHY}}, although the hint beside the column name says it reads {{ui:controls.health.verdict.UNKNOWN}}.

**A control's tasks.** A control with linked tasks has an arrow in its first column. Click the arrow, or the control's name, to list its tasks under the row with their status, assignee and evidence count. Click a task to open it in the **{{ui:controls.list.task}}** panel.

**The quick view.** Clicking a control's name opens the **{{ui:controls.list.control}}** panel beside the table, in place of the other panels. On a narrow screen it opens over the page. Its **{{ui:controls.detail.tabs.details}}** tab holds the control's {{ui:controls.detail.fields.name}}, {{ui:controls.detail.fields.category}}, {{ui:controls.detail.fields.frequency}} and {{ui:controls.detail.fields.owner}}, and its evidence. Roles that can edit controls also get a box there to upload files or **{{ui:panels.evidenceUpload.linkUrl}}**. Its **{{ui:controls.detail.tabs.activity}}** tab lists what has happened to the control. Press Escape or close the panel to go back.

**The side panels.** **{{ui:controls.list.browse}}** starts collapsed. Open it to see the listed controls grouped by category, each group tagged with its framework. **{{ui:controls.list.expandAll}}** opens every group. Click a control in it to open its page. **{{ui:controls.list.aiAssist}}** opens the AI-assisted risk assessment, the same one the risk register offers.

## What you can do

### Create a control

Click **{{ui:controls.addControl}}**. The **{{ui:controls.new.title}}** dialog asks for a **{{ui:controls.new.nameLabel}}**, which is required. Its other fields are optional: **{{ui:controls.new.codeLabel}}**, **{{ui:controls.new.categoryLabel}}** ({{ui:controls.categoryLabels.ORGANIZATIONAL}}, {{ui:controls.categoryLabels.PEOPLE}}, {{ui:controls.categoryLabels.PHYSICAL}} or {{ui:controls.categoryLabels.TECHNOLOGICAL}}), **{{ui:controls.new.frequencyLabel}}**, **{{ui:controls.new.automationLabel}}**, **{{ui:controls.new.mitigationLabel}}** and **{{ui:controls.new.ownerLabel}}**. Under **{{ui:controls.new.applicability}}**, choose **{{ui:controls.new.applicable}}** or **{{ui:controls.new.notApplicable}}**; the second needs a justification. Click **{{ui:controls.new.submit}}**. The new control's page opens.

To add controls from a framework rather than one by one, see [Add a framework](../../how-to/get-started/add-a-framework.md), or choose **{{ui:common.ui.viewsMenu}}** › **{{ui:controls.list.installTemplates}}** to pick from the template library.

### Edit a control from the list

Click its name to open the quick view and change any of its fields. Each change saves on its own: the line under the fields reads **{{ui:controls.detail.autosave.saving}}**, then **{{ui:controls.detail.autosave.saved}}**. A name needs at least three characters. Status and applicability are changed on the control's own page.

### Change many controls at once

Tick the rows you want, up to 100 at a time. In the selection bar, open **{{ui:common.table.chooseAction}}**, pick an action and click **{{ui:common.table.apply}}**:

- **{{ui:controls.bulk.setStatus}}** moves every selected control to the status you choose. {{ui:controls.filterEnums.status.NOT_APPLICABLE}} is not offered, because scoping a control out needs a justification; do that on the control's own page.
- **{{ui:controls.bulk.assignOwner}}** gives them all one owner, who must be an active member. Leave the owner empty to unassign them.
- **{{ui:controls.bulk.delete}}** removes them from the list. For five seconds a message offers **{{ui:controls.deleted.undo}}**. Nothing is deleted until that time runs out.

A status or owner change shows **{{ui:controls.bulk.applied}}** and clears the selection. A failed one leaves the rows selected, so you can try again. A failed deletion puts the rows back in the table.

### Restore or purge a deleted control

Choose **{{ui:common.ui.viewsMenu}}** › **{{ui:controls.deleted.toggle}}**. The table gains a **{{ui:controls.deleted.actions}}** column, and the summary cards are hidden. It lists only deleted controls, each marked **{{ui:controls.deleted.badge}}**, with when and by whom it was deleted. The search and the {{ui:controls.filters.status}}, {{ui:controls.filters.applicability}}, {{ui:controls.filters.owner}} and {{ui:controls.filters.category}} filters narrow it as they narrow the normal list.

- **{{ui:controls.deleted.restore}}** brings the control back into the list. A message reads **{{ui:controls.deleted.restoredToast}}**.
- **{{ui:controls.deleted.purge}}** deletes it permanently. The **{{ui:controls.deleted.purgeTitle}}** dialog asks you to type the control's code, or its name if it has none, then click **{{ui:controls.deleted.purge}}**. This cannot be undone.

Choose **{{ui:controls.deleted.toggle}}** again to return to the normal list.

## What happens next

- A control you create starts as {{ui:controls.filterEnums.status.NOT_STARTED}}. If you left {{ui:controls.new.codeLabel}} empty, it gets the workspace's next code of the form CTL-12.
- Every creation, status change, owner change, deletion, restore and purge writes an entry to the workspace's audit log, one per control, naming who made it.
- A deleted control leaves the list at once. An Owner or Admin can restore it from **{{ui:controls.deleted.toggle}}** for 90 days, after which it is removed for good.
- The workspace dashboard and the {{ui:controls.dashboard.title}} update to match.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:controls.empty.noRecordsTitle}}** | The workspace has no controls | Click **{{ui:controls.empty.installFramework}}** or **{{ui:controls.empty.installTemplates}}**. Only roles that can add controls can install anything on the pages they open |
| **{{ui:controls.empty.filterTitle}}** | Controls exist, but none match the search and filters | Click **{{ui:controls.empty.clearFilters}}** |
| A banner saying how many flagged controls are shown | You came from the consistency check on the {{ui:controls.dashboard.title}}, and the list shows only the controls it flagged | Click **{{ui:controls.list.flaggedClear}}** in the banner |
| Fewer controls than expected, with no filter pill | You came from the {{ui:controls.dashboard.controlsDueSoon}} or {{ui:controls.dashboard.missingEvidence}} card, and the list shows only those controls. {{ui:controls.empty.clearFilters}} does not undo this | Click **{{ui:nav.controls}}** in the sidebar |
| **{{ui:controls.deleted.emptyTitle}}** | No control is deleted | Nothing to restore |
| **{{ui:controls.list.loadError}}** | The list did not load | Reload the page |
| **{{ui:controls.health.loadError}}** above the table | The health verdicts did not load, so the {{ui:controls.list.healthColumn}} column shows dashes | Reload the page |
| **{{ui:controls.detail.taskRows.error}}** under a row | The control's tasks did not load | Collapse the row and open it again |
| **{{ui:controls.bulk.actionFailed}}** | A bulk action did not go through, for example because more than 100 rows were selected | Select fewer rows and try again |
| **{{ui:controls.new.createFailed}}**, or a reason from the server, in the dialog | The control was not created. On a plan that limits controls, the reason names the limit | Fix what the reason says, or ask an Owner about the plan |
| **{{ui:controls.new.applicabilityFailed}}** | The control exists, but marking it not applicable failed | Click **{{ui:controls.new.submit}}** again; it retries only that step |
| **{{ui:controls.detail.errors.saveFailed}}** or **{{ui:controls.detail.errors.ownerUpdateFailed}}** in the quick view | The change was not saved | Try again, or make the change on the control's own page |
| **{{ui:controls.deleted.restoreFailed}}** or **{{ui:controls.deleted.purgeFailed}}** | The restore or purge did not go through | Reload the page and try again |
| A banner saying the list shows the first 5,000 results | The workspace holds more controls than the page loads at once | Narrow the list with a filter or the search |
| **{{ui:common.error.title}}** in place of the page | The page could not load, for example because your role cannot view controls | Ask an Owner or Admin |

## Related

- [Add a framework](../../how-to/get-started/add-a-framework.md), which installs a framework's controls, tasks and requirement mappings.
- [Attach evidence to a control](../../how-to/get-started/attach-evidence-to-a-control.md), on the control's own page.
- [{{ui:risks.title}}](risks.md), whose risks the controls treat.
- [{{ui:evidence.title}}](../comply/evidence.md) and [{{ui:tasks.list.srTitle}}](../comply/tasks.md), the evidence and work behind each control.
