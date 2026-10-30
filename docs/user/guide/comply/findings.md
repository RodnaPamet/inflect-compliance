---
route: /t/[tenantSlug]/findings
---

# {{ui:findings.title}}

The {{ui:findings.title}} lists every finding in the workspace: the nonconformities, observations and opportunities raised in audits and assessments. It shows each finding's severity, type, the control it concerns, where it came from, who owns it and how far it has got towards closure.

## Where to find it

The register has no entry in the sidebar. Open it from any of these:

- **{{ui:nav.audits}}** under **{{ui:nav.comply}}** in the sidebar opens the {{ui:audits.title}} page. In its header, beside **{{ui:audits.hub.related}}**, click **{{ui:audits.findingsTab}}**. On the same page, step 5 of **{{ui:audits.hub.startTitle}}**, **{{ui:audits.hub.step5Title}}**, opens it too.
- On the dashboard, the arrow in the top-right corner of the **{{ui:dashboard.openFindings}}** card. The register opens filtered to findings that are not closed.
- On a task raised by a finding, the finding's title under **{{ui:tasks.source.heading}}**.
- On {{ui:nav.calendar}}, a finding's due date. The register opens with that finding's panel open.

The breadcrumb reads **{{ui:findings.list.crumbDashboard}}** › **{{ui:findings.title}}**. When you arrive from another page, a back link to it sits above the breadcrumb.

## Who can use it

| Action | Roles |
| --- | --- |
| View the register | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Open a finding's panel and read every field | Every role |
| Create a finding | Owner, Admin, Editor |
| Edit a finding | Owner, Admin, Editor |
| Move a finding to its next status | Owner, Admin, Editor |

Readers, Auditors and AI admins see no **{{ui:findings.newFinding}}** button, no {{ui:common.actions}} column and no **{{ui:findings.detail.edit}}** button.

If your workspace uses custom roles, the role's own **{{ui:admin.resourceLabels.findings}}** permissions decide: **{{ui:admin.roles.actions.view}}** to open the register, **{{ui:admin.roles.actions.create}}** to create a finding, and **{{ui:admin.roles.actions.edit}}** to edit one or move its status. Creating and changing also need a base role that can make changes: Owner, Admin or Editor. A role without view sees **{{ui:findings.accessTitle}}** instead of the register.

## What it is for

Use the register to follow every finding to closure, whichever audit raised it: see what is open, what is waiting for verification and who owns it, and record findings that came from outside a fieldwork audit.

## What you see

**The header.** The title, its description and the **{{ui:findings.newFinding}}** button with a plus sign.

**The filter.** **{{ui:common.ui.filter}}** above the table filters the register by {{ui:findings.status}}; you can pick more than one. The filter is kept in the page's address, so a link to a filtered register opens filtered.

**The table.** Newest findings first. **{{ui:common.table.toggleColumns}}** above the table chooses which columns are shown, and your browser remembers the choice. The table has no search or sorting, and a long list loads more rows as you scroll.

| Column | What it shows |
| --- | --- |
| {{ui:findings.findingTitle}} | The finding's title |
| {{ui:findings.severity}} | {{ui:findings.low}}, {{ui:findings.medium}}, {{ui:findings.high}} or {{ui:findings.critical}} |
| {{ui:findings.type}} | {{ui:findings.nonconformity}}, {{ui:findings.observation}} or {{ui:findings.opportunity}} |
| {{ui:findings.colHeaders.control}} | The control the finding is raised against, by its code or name. Click it to open the control. A dash means none |
| {{ui:findings.colHeaders.source}} | Where the finding came from: the audit cycle, which opens the cycle; the audit, which opens it on the {{ui:audits.title}} page; or **{{ui:findings.adHoc}}** for a finding raised on this page with no audit |
| {{ui:findings.owner}} | The member it is assigned to. An older finding may show a name typed in by hand. A dash means nobody |
| {{ui:findings.status}} | {{ui:findings.open}}, {{ui:findings.inProgress}}, {{ui:findings.readyForVerification}} or {{ui:findings.closed}} |
| {{ui:common.actions}} | The button that moves the finding to its next status. Shown only to roles that can change findings |

**The finding's panel.** Click a row to open the finding in a panel at the side, over the register. The page's address then names the finding, so you can share a link to it. The panel shows the finding's severity and status, then its {{ui:findings.create.labelType}}, {{ui:findings.create.labelAssignee}}, {{ui:findings.create.labelDueDate}}, {{ui:findings.create.labelOriginatingAudit}}, {{ui:findings.create.labelDescription}}, {{ui:findings.create.labelLinkedControl}}, {{ui:findings.create.labelCompensatingControl}}, {{ui:findings.detail.labelRisks}} and {{ui:findings.create.labelAnalysis}}. Close the panel to return to the register as you left it.

## What you can do

### Create a finding

Click **{{ui:findings.newFinding}}**. The **{{ui:findings.create.title}}** dialog has three parts:

- **{{ui:findings.create.sectionDetails}}**: a **{{ui:findings.create.labelTitle}}** and a **{{ui:findings.create.labelDescription}}**, both required; a **{{ui:findings.create.labelType}}**, starting on {{ui:findings.typeOptions.OBSERVATION}}; a **{{ui:findings.create.labelSeverity}}**, starting on {{ui:findings.severityOptions.MEDIUM}}; an **{{ui:findings.create.labelAssignee}}**, chosen from the workspace's members and starting on {{ui:findings.create.placeholderUnassigned}}; a **{{ui:findings.create.labelDueDate}}**, today or later; and an **{{ui:findings.create.labelOriginatingAudit}}**, the audit the finding was raised during.
- **{{ui:findings.create.sectionControlsRisks}}**: a **{{ui:findings.create.labelLinkedControl}}**, the control the finding is raised against, and a **{{ui:findings.create.labelCompensatingControl}}**, one that mitigates it. Below them, tick the risks the finding implicates. The box above the list, **{{ui:findings.create.searchRisks}}**, narrows it by title or reference.
- **{{ui:findings.create.sectionAnalysis}}**: **{{ui:findings.create.labelAnalysis}}**, free text for investigation notes.

Click **{{ui:findings.create.submit}}**. It stays greyed out until the title and description are filled in. The finding is added at the top of the table as {{ui:findings.open}}.

### Edit a finding

Open the finding's panel and click **{{ui:findings.detail.edit}}**. The **{{ui:findings.detail.editTitle}}** form has the same fields as the create dialog, apart from the originating audit, which is shown but cannot be changed. You can clear the due date and the analysis. Click **{{ui:findings.detail.save}}**; **{{ui:findings.detail.saved}}** confirms it and the panel shows the finding as saved. Only the fields you changed are sent. The status is changed from the register, not here, and a finding cannot be deleted.

### Move a finding towards closure

Each finding that is not closed has one button in the {{ui:common.actions}} column, naming the next status:

1. An {{ui:findings.open}} finding shows **{{ui:findings.inProgress}}**.
2. An {{ui:findings.inProgress}} finding shows **{{ui:findings.readyForVerification}}**.
3. A finding that is {{ui:findings.readyForVerification}} shows **{{ui:findings.closed}}**.

Click it, and the status changes at once. If the change is refused, the status flips back and a message gives the reason. The register cannot move a finding back a step or reopen a closed one.

## What happens next

- Creating a finding, every edit and every status change are recorded in the workspace's audit log, naming who made them. Closing a finding also records who closed it and when.
- A finding counts under **{{ui:dashboard.openFindings}}** on the dashboard until it is closed. Closed findings stay in the register.
- While open, a finding raised on a fieldwork audit that belongs to an audit cycle lowers that cycle's readiness score.
- A finding raised by a failed checklist item, or from an auditor's message on a shared audit pack, comes with a remediation task. Resolving or closing that task closes the finding. A finding created on this page comes with no task.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:findings.noFindings}}** | The workspace has no findings | Click **{{ui:findings.newFinding}}**, if your role can create findings |
| **{{ui:findings.list.emptyMatchTitle}}** | No finding has the status you filtered on | Pick another status, or click **{{ui:findings.list.clearFilters}}** |
| An error in the create dialog or the edit form | The finding was refused, for example because the assignee, a control or a risk is no longer valid. The message gives the reason | Correct your choice and try again |
| **Failed to create finding** or **Failed to save finding** followed by a number in brackets | Inflect answered with an error and gave no reason | Try again |
| A status that flips back after you click, with a message | The change was refused or did not go through; the message gives the reason, or reads **{{ui:findings.statusUpdateFailed}}** | Try again, or act on the reason |
| **{{ui:findings.detail.errorTitle}}** in the panel | The finding could not be loaded, for example because it no longer exists or the link is wrong | Close the panel and open the finding from the register |
| **{{ui:findings.create.risksToLinkEmpty}}** in the dialog | The workspace has no risks, or none matches the search | Clear the search, or create the finding without risks |
| A banner saying only the first 5,000 results are shown | More than 5,000 findings match | Filter by status to narrow the list |

## Related

- [{{ui:audits.title}}](audits.md), where fieldwork audits raise findings from their checklists.
- [Share an audit pack](../../how-to/audits/share-an-audit-pack.md), which turns an external auditor's message into a finding.
- [{{ui:tasks.list.srTitle}}](tasks.md), where remediation tasks are worked.
- [{{ui:controls.list.pageTitle}}](../govern/controls.md) and [{{ui:risks.title}}](../govern/risks.md), for the controls and risks a finding names.
