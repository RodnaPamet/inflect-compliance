---
route: /t/[tenantSlug]/tasks/[taskId]
---

# A task

A task's page is where you work on one piece of remediation or compliance work: change its status, assign it, tick off its steps, attach the evidence that it is done, and discuss it.

## Where to find it

Open **{{ui:nav.tasks}}** under **{{ui:nav.comply}}** and click a task. Tasks also open from the **Tasks** tab of a control, risk, asset, incident or policy. Arrows beside the title step to the previous or next task in the list you came from.

## Who can use it

| Action | Roles |
| --- | --- |
| View the task, its evidence, links, comments and activity | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Change the status, edit the task, assign it, set a reviewer, tick steps | Owner, Admin, Editor |
| Attach evidence, add or remove links | Owner, Admin, Editor |
| Comment, and watch or unwatch the task | Owner, Admin, Editor |
| Delete the task | Owner, Admin |

If your workspace uses custom roles, the page offers only what your role's permissions allow.

## What it is for

Track a piece of work to the end and leave a record of it: who did it, what proves it, and why it was closed.

## What you see

**The header.** The task's title, its **{{ui:tasks.detail.keyLabel}}** (click to copy), **{{ui:tasks.detail.status}}**, **{{ui:tasks.detail.severity}}** and **{{ui:tasks.detail.type}}**, and **{{ui:tasks.detail.overdue}}** under **{{ui:tasks.detail.sla}}** when it is late. On the right, if you can edit, the status picker, and for Owners and Admins **{{ui:tasks.detail.deleteTask}}**.

Under the header, **{{ui:tasks.source.heading}}** explains where the task came from, for example a vulnerability on an asset, a finding or a control, and why. Then **{{ui:tasks.detail.assigneeLabel}}**, **{{ui:tasks.detail.reviewerLabel}}** and **{{ui:tasks.detail.watchersLabel}}**.

**The tabs.**

| Tab | What it holds |
| --- | --- |
| **{{ui:tasks.detail.tabOverview}}** | The description, the task's fields and its **{{ui:tasks.checklist.heading}}** |
| **{{ui:tasks.detail.tabEvidence}}** | The evidence attached to the task |
| **{{ui:tasks.detail.tabLinks}}** | The controls, risks, assets, requirements and evidence the task is linked to |
| **{{ui:tasks.detail.tabComments}}** | The discussion on the task |
| **{{ui:tasks.detail.tabActivity}}** | Everything that has happened to the task |

**The overview.** **{{ui:tasks.detail.description}}**, then **{{ui:tasks.detail.priority}}**, **{{ui:tasks.detail.dueDate}}**, **{{ui:tasks.detail.created}}**, **{{ui:tasks.detail.createdBy}}**, **{{ui:tasks.detail.control}}**, and, once closed, **{{ui:tasks.detail.completedAt}}** and **{{ui:tasks.detail.resolution}}**. A task raised from an audit also shows **{{ui:tasks.detail.auditDetails}}**: **{{ui:tasks.detail.findingSource}}** and **{{ui:tasks.detail.controlGapType}}**.

A task created from a control template carries its **{{ui:tasks.checklist.heading}}**, with **{{ui:tasks.checklist.guidanceHeading}}**: each step's **{{ui:tasks.checklist.phase}}**, **{{ui:tasks.checklist.suggestedRole}}** and **{{ui:tasks.checklist.evidenceHint}}**.

## What you can do

### Change the status

Choose a status from the picker in the header. Closing or cancelling a task asks for a short resolution note: {{ui:tasks.detail.terminalDesc}} A closed task cannot be moved to another status.

### Assign it, set a reviewer, watch it

Pick a member and click **{{ui:tasks.detail.assign}}**, or **{{ui:tasks.detail.setReviewer}}** to name who signs the task off. A reviewer must be an active member whose role can sign tasks off. **{{ui:tasks.detail.watch}}** sends you its updates; **{{ui:tasks.detail.unwatch}}** stops them.

### Edit the task

Click the pencil on the overview to change its title, description, type, severity, priority and due date.

### Tick off its steps

Tick each step under **{{ui:tasks.checklist.heading}}** as you complete it.

### Attach evidence

On **{{ui:tasks.detail.tabEvidence}}**, upload a file or give a link. Removing evidence takes it off the task, with a few seconds to click **{{ui:tasks.detail.undo}}**.

### Link it to other records

On **{{ui:tasks.detail.tabLinks}}**, click **{{ui:tasks.detail.addLink}}**, choose what to link and click **{{ui:tasks.detail.link}}**. Remove a link with **{{ui:tasks.detail.removeLink}}**, with a few seconds to undo.

### Comment

On **{{ui:tasks.detail.tabComments}}**, type in the box and click **{{ui:tasks.detail.comment}}**.

## What happens next

- Assigning a task tells the person assigned, by email and with a notification in the app, and tells the task's watchers in the app.
- A closed or cancelled task's resolution note is kept on the task and in the workspace's audit log.
- The task's status shows on the tasks list and on the **Tasks** tab of every record it is linked to.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:tasks.detail.notFoundEmpty}}** | The task does not exist, was deleted, or is in another workspace | Go back to the list |
| **{{ui:tasks.detail.descriptionEmpty}}** | The task has no description | Edit the task to add one |
| **{{ui:tasks.detail.commentsEmptyTitle}}** | Nobody has commented | Add a comment |
| **{{ui:tasks.detail.linksEmptyTitle}}** | The task is not linked to anything | Link it |
| **{{ui:tasks.detail.activityEmptyTitle}}** | Nothing has happened to the task yet | Nothing to do |
| **{{ui:tasks.detail.reviewerCannotSignOff}}** | The member you chose cannot sign tasks off | Choose another reviewer |
| **{{ui:tasks.detail.failedStatus}}**, **{{ui:tasks.detail.assignFailed}}**, **{{ui:tasks.detail.addLinkFailed}}** or **{{ui:tasks.detail.addCommentFailed}}**, or the reason it was refused | The change was not saved | Follow the reason given, then try again |
| **{{ui:tasks.detail.evidenceLoadErrorTitle}}** | The evidence could not load | Reload the page |

On **{{ui:tasks.detail.tabLinks}}**, the type and relation of each link are shown as stored, not translated.

## Related

- [{{ui:tasks.list.srTitle}}](tasks.md), every task in the workspace.
- [Evidence](evidence.md), the workspace's evidence library.
