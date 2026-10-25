---
route: /t/[tenantSlug]/tasks
---

# {{ui:tasks.list.srTitle}}

The {{ui:tasks.list.srTitle}} page lists the workspace's compliance work: remediation tasks, audit findings, control gaps, incidents and improvements. It shows each task's status, severity, assignee and due date, and it is where you create tasks and change many at once.

## Where to find it

Open **{{ui:nav.tasks}}** under **{{ui:nav.comply}}** in the sidebar. The breadcrumb reads **{{ui:tasks.crumb.dashboard}}** › **{{ui:tasks.crumb.tasks}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| View the list, the summary cards and a task's quick view | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Create a task | Owner, Admin, Editor |
| Edit a task in the quick view, change its status or attach evidence | Owner, Admin, Editor |
| Assign tasks, or set their status or due date, in bulk | Owner, Admin, Editor |
| Delete in bulk | Owner, Admin |
| See deleted tasks and restore them | Owner, Admin |
| Close a task that has a reviewer | Only that reviewer, and only if their role can edit tasks |

Every role can tick rows, but only roles that can edit tasks get actions in the selection bar. For the other roles the quick view is read-only. If your workspace uses custom roles, what you can do depends on the permissions your role was given.

Any active member can be named a task's reviewer. A Reader, Auditor or AI admin cannot change a task's status, though, so a task whose reviewer has one of those roles can only be canceled, or given another reviewer on the task's own page.

## What it is for

Use the page to move compliance work to closure: see what is open, overdue or due soon, find the work assigned to you or waiting for your sign-off, and hand work to the right people. A task can be tied to the control, risk, asset or other record it remediates.

## What you see

**Summary cards.** Four cards sit above the table, each with a trend line. They count every task in the workspace whatever filters are set, and leave out deleted tasks. Click a selected card again to drop its filter. "Unfinished" below means any status except {{ui:tasks.statusLabels.RESOLVED}}, {{ui:tasks.statusLabels.CLOSED}} and {{ui:tasks.statusLabels.CANCELED}}.

| Card | What it counts | Clicking it |
| --- | --- | --- |
| {{ui:tasks.kpi.total}} | Every task, in any status | Clears every filter |
| {{ui:tasks.kpi.open}} | Tasks whose status is {{ui:tasks.statusLabels.OPEN}} | Filters to that status |
| {{ui:tasks.kpi.overdue}} | Unfinished tasks whose due date has passed | Filters to those tasks |
| {{ui:tasks.kpi.dueWeek}} | Unfinished tasks due in the next seven days | Filters to those tasks |

**The toolbar.** From left to right:

- **{{ui:tasks.list.addBtn}}** opens the new-task dialog. Only roles that can create tasks see it.
- The **{{ui:common.ui.filter}}** button holds the search and the filters. Its search box, **{{ui:tasks.list.searchPlaceholder}}**, matches a task's title or its reference, such as TSK-12, as you type. The filters are {{ui:tasks.filters.status}}, {{ui:tasks.filters.type}}, {{ui:tasks.filters.severity}}, {{ui:tasks.filters.source}}, {{ui:tasks.filters.due}}, {{ui:tasks.filters.awaitingReview}}, {{ui:tasks.filters.assignee}} and {{ui:tasks.filters.linkedControl}}. Each active filter shows as a pill beside the button; remove a pill to drop that filter. Filters are kept in the page address, so a filtered view can be bookmarked or shared with a colleague who has access to the workspace.
- **{{ui:tasks.list.assignedToMe}}** and **{{ui:tasks.list.awaitingMyReview}}** filter to your own work. See below.
- **{{ui:common.ui.viewsMenu}}** holds **{{ui:tasks.list.showDeleted}}**, for Owners and Admins.
- Two settings buttons close the row. The first chooses which table columns are shown, the second which summary cards.

Some filters work differently from the others:

- {{ui:tasks.filters.due}} offers {{ui:tasks.filterEnums.due.overdue}} or {{ui:tasks.filterEnums.due.next7d}}, one at a time. Unless you also pick a status, it leaves out finished tasks.
- {{ui:tasks.filters.assignee}} and {{ui:tasks.filters.linkedControl}} offer the people and controls that have appeared on the tasks listed since you opened the page, so picking one leaves the others on offer, and {{ui:tasks.filters.awaitingReview}} offers only {{ui:tasks.list.awaitingMyReviewOption}}.
- {{ui:tasks.filters.linkedControl}} matches the control set in a task's Control field. A control added to the task under Links does not count.

**The table.** Each row is one task. The list opens with the highest priority first, then the newest. Click a column heading to sort by it. The first 50 rows show at once, and more load as you scroll.

| Column | What it shows |
| --- | --- |
| {{ui:tasks.colHeaders.title}} | The task's name. Click it to open the quick view |
| {{ui:tasks.colHeaders.type}} | {{ui:tasks.typeLabels.TASK}}, {{ui:tasks.typeLabels.AUDIT_FINDING}}, {{ui:tasks.typeLabels.CONTROL_GAP}}, {{ui:tasks.typeLabels.INCIDENT}} or {{ui:tasks.typeLabels.IMPROVEMENT}} |
| {{ui:tasks.colHeaders.severity}} | {{ui:tasks.severityLabels.INFO}}, {{ui:tasks.severityLabels.LOW}}, {{ui:tasks.severityLabels.MEDIUM}}, {{ui:tasks.severityLabels.HIGH}} or {{ui:tasks.severityLabels.CRITICAL}} |
| {{ui:tasks.colHeaders.status}} | The task's status, described below |
| {{ui:tasks.colHeaders.source}} | Where the task came from. Tasks created on this page are {{ui:tasks.filterEnums.source.MANUAL}}; others name the check that raised them, such as {{ui:tasks.filterEnums.source.AUDIT}}, {{ui:tasks.filterEnums.source.POLICY_REVIEW}} or {{ui:tasks.filterEnums.source.EVIDENCE_EXPIRY}} |
| {{ui:tasks.colHeaders.assignee}} | The person doing the work. A dash means nobody, or an assignee whose account has no name |
| {{ui:tasks.colHeaders.dueAt}} | When the task is due, as relative time. Hover for the exact date. A dash means no due date |
| {{ui:tasks.colHeaders.updated}} | When the task last changed. Hidden until you turn it on |

Click elsewhere on a row to tick it, and double-click a row to open the task's own page. Roles that can edit tasks also get a pencil at the end of each row, which opens the quick view.

**Statuses.**

| Status | What it means |
| --- | --- |
| {{ui:tasks.statusLabels.OPEN}} | A task you create starts here. Once it leaves, it cannot come back |
| {{ui:tasks.statusLabels.TRIAGED}} | Assessed and ready to be worked on |
| {{ui:tasks.statusLabels.IN_PROGRESS}} | Being worked on |
| {{ui:tasks.statusLabels.IN_REVIEW}} | Handed to its reviewer for sign-off |
| {{ui:tasks.statusLabels.BLOCKED}} | Stuck on something outside the task |
| {{ui:tasks.statusLabels.RESOLVED}} | An older finished status that the status lists no longer offer. A task that still carries it can be closed or moved back to {{ui:tasks.statusLabels.IN_PROGRESS}} |
| {{ui:tasks.statusLabels.CLOSED}} | Done. Its status cannot change again |
| {{ui:tasks.statusLabels.CANCELED}} | Dropped without being done. Its status cannot change again |

A few rules hold on every way of changing a status:

- Moving a task to {{ui:tasks.statusLabels.CLOSED}} or {{ui:tasks.statusLabels.CANCELED}} needs a resolution note.
- A task in {{ui:tasks.statusLabels.IN_REVIEW}} cannot move straight to {{ui:tasks.statusLabels.BLOCKED}}.
- A task with a reviewer can be closed only from {{ui:tasks.statusLabels.IN_REVIEW}}, and only by the reviewer. Canceling it is not affected.
- An {{ui:tasks.typeLabels.AUDIT_FINDING}} or {{ui:tasks.typeLabels.CONTROL_GAP}} can be closed only when it has a control, or a link to a control or framework requirement. An {{ui:tasks.typeLabels.INCIDENT}} needs a control, or a link to a control or asset.

**The quick view.** Clicking a task's title opens it in a **{{ui:tasks.list.quickViewTitle}}** panel beside the table, so the list stays in view; click another title to switch. It shows the task's reference, status and title, with two tabs. **{{ui:sharedPanels.detail.tabs.details}}** holds the task's fields and the evidence attached to it. Changes save as you make them, and a line below the fields shows **{{ui:sharedPanels.detail.autosave.saving}}**, then **{{ui:sharedPanels.detail.autosave.saved}}**. **{{ui:sharedPanels.detail.tabs.activity}}** lists the task's recent history.

## What you can do

### Create a task

Click **{{ui:tasks.list.addBtn}}**. The **{{ui:tasks.new.modalTitle}}** dialog asks for a **{{ui:tasks.new.title}}** and a **{{ui:tasks.new.type}}**, which starts on {{ui:tasks.typeLabels.TASK}}. The other fields are optional: **{{ui:tasks.new.description}}**, **{{ui:tasks.new.severity}}** (starts on {{ui:tasks.severityLabels.MEDIUM}}), **{{ui:tasks.new.priority}}** (starts on {{ui:tasks.priorityLabels.P2}}), **{{ui:tasks.new.dueDate}}**, **{{ui:tasks.new.assignee}}**, **{{ui:tasks.new.reviewer}}** and **{{ui:tasks.new.control}}**. A due date cannot be in the past, and the reviewer must be someone other than the assignee. For an audit finding or control gap, an **{{ui:tasks.new.auditDetails}}** section adds **{{ui:tasks.new.findingSource}}**, and for a control gap **{{ui:tasks.new.controlGapType}}**.

To link records, go to **{{ui:tasks.new.links}}**, pick an **{{ui:tasks.new.entityType}}** ({{ui:tasks.linkEntity.CONTROL}}, {{ui:tasks.linkEntity.FRAMEWORK_REQUIREMENT}}, {{ui:tasks.linkEntity.ASSET}}, {{ui:tasks.linkEntity.RISK}} or {{ui:tasks.linkEntity.EVIDENCE}}) and an **{{ui:tasks.new.entity}}**, then click **{{ui:tasks.new.add}}**. Each added link is listed by its type's internal name and the record's ID rather than its name; the cross beside it removes it. An audit finding or control gap needs a control, or a control or framework requirement link, and an incident needs a control, or a control or asset link. Until it has one, a note says so and **{{ui:tasks.new.create}}** is greyed out.

Click **{{ui:tasks.new.create}}**. The dialog closes and the new task's page opens. If a link could not be attached, a warning lists it, and you can add it from that page. Closing the dialog after typing asks **{{ui:tasks.new.discardTitle}}**; choose **{{ui:tasks.new.discardConfirmLabel}}** or **{{ui:tasks.new.discardCancelLabel}}**.

### Find your own work

Click **{{ui:tasks.list.assignedToMe}}** to list only the tasks assigned to you. Click **{{ui:tasks.list.awaitingMyReview}}** to list the tasks in {{ui:tasks.statusLabels.IN_REVIEW}} that name you as reviewer: only you can sign those off. Click either again to turn it off.

### Update a task from the quick view

Click the task's title, or the pencil at the end of its row, and change any field. To close or cancel the task, choose {{ui:tasks.statusLabels.CLOSED}} or {{ui:tasks.statusLabels.CANCELED}} under **{{ui:sharedPanels.detail.fields.status}}**, write a **{{ui:sharedPanels.detail.fields.resolution}}** and click **{{ui:sharedPanels.detail.status.apply}}**. The status list also offers {{ui:tasks.statusLabels.OPEN}}, which is refused for any task that has left it. A refused change reads **{{ui:sharedPanels.detail.errors.saveFailed}}**, without the reason. The reviewer is set on the task's own page, not here.

### Change many tasks at once

Tick the rows you want, up to 100 at a time; the box in the header ticks every row loaded so far. Choose an action from **{{ui:common.table.chooseAction}}** in the selection bar, then click **{{ui:common.table.apply}}**:

- **{{ui:tasks.bulk.assign}}** gives them all one assignee. Leave the person empty to unassign them.
- **{{ui:tasks.bulk.changeStatus}}** offers {{ui:tasks.statusLabels.TRIAGED}}, {{ui:tasks.statusLabels.IN_PROGRESS}}, {{ui:tasks.statusLabels.IN_REVIEW}} and {{ui:tasks.statusLabels.BLOCKED}}. Closing and canceling need a resolution note, so they are done one task at a time.
- **{{ui:tasks.bulk.setDueDate}}** gives them all one due date. Leave the date empty to clear it.
- **{{ui:tasks.bulk.delete}}**, for Owners and Admins, removes them from the list. For five seconds a message offers **{{ui:tasks.bulk.undo}}**; nothing is deleted until that time runs out.

A status change goes through for every selected task or for none. Assigning is refused when the person is the reviewer of any selected task. Whenever a bulk action is refused, the message reads **{{ui:tasks.bulk.failed}}** without the reason, and the rows go back to how they were. If you assign or set a due date and some tasks were deleted in the meantime, a warning says how many were updated and how many skipped.

### Restore a deleted task

Owners and Admins: open **{{ui:common.ui.viewsMenu}}** › **{{ui:tasks.list.showDeleted}}**. The table lists the 200 most recently deleted tasks, newest first, with a **{{ui:tasks.list.colDeletedAt}}** column; the search and filters still apply. Click **{{ui:tasks.list.restore}}** on a row to return the task to the active list. A task whose control has been deleted cannot be restored until the control is. Choose **{{ui:tasks.list.showLive}}** from the same menu to go back. Clicking a deleted task opens its page or its quick view, and neither can load it.

## What happens next

- Every creation, status change, assignment, due-date change, deletion and restore is written to the workspace's audit log, naming who made it. A bulk action writes one entry per task.
- Someone assigned a task when it is created, or one task at a time in the quick view, is sent an email and an in-app notification. Assigning from the selection bar notifies nobody.
- Moving a task to {{ui:tasks.statusLabels.IN_REVIEW}} notifies its reviewer, unless the reviewer made the move. People watching a task are told when its status changes.
- Closing a task that was raised automatically, for example by a finding, a vulnerability or a failed control test, also updates the record that raised it. Canceling does not.
- A deleted task leaves the list at once and is removed for good after 90 days. Until then an Owner or Admin can restore it.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:tasks.list.emptyTitle}}** | The workspace has no tasks | Click **{{ui:tasks.list.addBtn}}**, if your role can create tasks |
| **{{ui:tasks.list.filterEmptyTitle}}** | Tasks exist, but none match the search and filters | Click **{{ui:tasks.list.clearFilters}}** |
| **{{ui:tasks.list.deletedEmptyTitle}}** | No deleted task matches the search and filters, or none was deleted in the last 90 days | Choose **{{ui:tasks.list.showLive}}** to go back |
| **{{ui:tasks.list.loadError}}** | The list did not load | Reload the page |
| **{{ui:tasks.bulk.failed}}** | A bulk action was refused: for example more than 100 rows were selected, one task cannot make the status move, or the assignee reviews one of the tasks | Check the selection and try again |
| **{{ui:tasks.bulk.restoreFailed}}** | The task was not restored, often because its control is deleted | Restore the control first, or ask an Owner or Admin |
| **{{ui:tasks.new.createFailed}}** in the dialog | The task was refused, for example because the assignee is also the reviewer | Change the fields and try again |
| **{{ui:sharedPanels.detail.errors.loadFailed}}** in the quick view | The task did not load. A deleted task never loads | Click **{{ui:sharedPanels.detail.status.retry}}** |
| A banner saying the list is truncated | The workspace has more than 5,000 tasks, more than the page loads at once | Narrow the list with a filter or the search |

## Related

- Double-click a task to open its own page, where you can set its reviewer, manage its links, comment and attach evidence.
- [{{ui:risks.title}}](../govern/risks.md): each risk's {{ui:risks.colHeaders.tasks}} column counts the tasks linked to it.
- [{{ui:controls.list.pageTitle}}](../govern/controls.md): each control's {{ui:controls.colHeaders.tasks}} column counts its done tasks out of all its tasks.
- A control's, asset's or risk's own page lists its tasks, and a task created there is linked to it.
