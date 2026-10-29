---
route: /t/[tenantSlug]/findings
---

# {{ui:findings.title}}

The {{ui:findings.title}} lists every finding in the workspace: the nonconformities, observations and opportunities raised in audits and assessments. It shows each finding's severity, type, the control it concerns, where it came from, who owns it and how far it has got towards closure.

## Where to find it

The register has no entry in the sidebar. Open it from any of these:

- **{{ui:nav.audits}}** under **{{ui:nav.comply}}** in the sidebar opens the {{ui:audits.title}} page. In its header, beside **{{ui:audits.hub.related}}**, click **{{ui:audits.findingsTab}}**. On the same page, step 5 of **{{ui:audits.hub.startTitle}}**, **{{ui:audits.hub.step5Title}}**, opens it too.
- On the dashboard, the arrow in the top-right corner of the **{{ui:dashboard.openFindings}}** card.
- On a task raised by a finding, the finding's title under **{{ui:tasks.source.heading}}**.
- On {{ui:nav.calendar}}, a finding's due date.

The breadcrumb reads **{{ui:findings.list.crumbDashboard}}** › **{{ui:findings.title}}**. When you arrive from another page, a back link to it sits above the breadcrumb.

## Who can use it

| Action | Roles |
| --- | --- |
| View the register | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Create a finding | Owner, Admin, Editor |
| Move a finding to its next status | Owner, Admin, Editor |

The **{{ui:findings.newFinding}}** button and the status buttons are shown to every role. For a Reader, an Auditor or an AI admin, creating a finding fails with the message **[object Object]**, and a status change flips back without a message.

If your workspace uses custom roles, creating and changing findings follows the built-in role your custom role is based on, not the custom role's own permissions.

## What it is for

Use the register to follow every finding to closure, whichever audit raised it: see what is open, what is waiting for verification and who owns it, and record findings that came from outside a fieldwork audit.

## What you see

**The header.** The title, its description and the **{{ui:findings.newFinding}}** button with a plus sign.

**The table.** Newest findings first. **{{ui:common.table.toggleColumns}}** above the table chooses which columns are shown, and your browser remembers the choice. The table has no search, filters or sorting, and a long list loads more rows as you scroll.

| Column | What it shows |
| --- | --- |
| {{ui:findings.findingTitle}} | The finding's title |
| {{ui:findings.severity}} | {{ui:findings.low}}, {{ui:findings.medium}}, {{ui:findings.high}} or {{ui:findings.critical}} |
| {{ui:findings.type}} | {{ui:findings.nonconformity}}, {{ui:findings.observation}} or {{ui:findings.opportunity}} |
| {{ui:findings.colHeaders.control}} | The control the finding is raised against, by its code or name. Click it to open the control. A dash means none |
| {{ui:findings.colHeaders.source}} | Where the finding came from: the audit cycle, which opens the cycle; the audit, which opens it on the {{ui:audits.title}} page; or **{{ui:findings.adHoc}}** for a finding raised on this page with no audit |
| {{ui:findings.owner}} | The member it is assigned to. An older finding may show a name typed in by hand. A dash means nobody |
| {{ui:findings.status}} | {{ui:findings.open}}, {{ui:findings.inProgress}}, {{ui:findings.readyForVerification}} or {{ui:findings.closed}} |
| {{ui:common.actions}} | The button that moves the finding to its next status |

Clicking a row ticks it, but the register has no action for ticked rows. A finding has no page of its own, so its description, due date, compensating control, risks and analysis are not shown anywhere in the register.

## What you can do

### Create a finding

Click **{{ui:findings.newFinding}}**. The **{{ui:findings.create.title}}** dialog has three parts:

- **{{ui:findings.create.sectionDetails}}**: a **{{ui:findings.create.labelTitle}}** and a **{{ui:findings.create.labelDescription}}**, both required; a **{{ui:findings.create.labelType}}**, starting on {{ui:findings.typeOptions.OBSERVATION}}; a **{{ui:findings.create.labelSeverity}}**, starting on {{ui:findings.severityOptions.MEDIUM}}; an **{{ui:findings.create.labelAssignee}}**, chosen from the workspace's members and starting on {{ui:findings.create.placeholderUnassigned}}; a **{{ui:findings.create.labelDueDate}}**, today or later; and an **{{ui:findings.create.labelOriginatingAudit}}**, the audit the finding was raised during.
- **{{ui:findings.create.sectionControlsRisks}}**: a **{{ui:findings.create.labelLinkedControl}}**, the control the finding is raised against, and a **{{ui:findings.create.labelCompensatingControl}}**, one that mitigates it. Below them, tick the risks the finding implicates. The box above the list, **{{ui:findings.create.searchRisks}}**, narrows it by title or reference.
- **{{ui:findings.create.sectionAnalysis}}**: **{{ui:findings.create.labelAnalysis}}**, free text for investigation notes.

Click **{{ui:findings.create.submit}}**. It stays greyed out until the title and description are filled in. The finding is added at the top of the table as {{ui:findings.open}}.

### Move a finding towards closure

Each finding that is not closed has one button in the {{ui:common.actions}} column, naming the next status:

1. An {{ui:findings.open}} finding shows **{{ui:findings.inProgress}}**.
2. An {{ui:findings.inProgress}} finding shows **{{ui:findings.readyForVerification}}**.
3. A finding that is {{ui:findings.readyForVerification}} shows **{{ui:findings.closed}}**.

Click it, and the status changes at once. If the change is refused, the status flips back. The register cannot move a finding back a step or reopen a closed one.

## What happens next

- Creating a finding and every status change are recorded in the workspace's audit log, naming who made them. Closing a finding also records who closed it and when.
- A finding counts under **{{ui:dashboard.openFindings}}** on the dashboard until it is closed. Closed findings stay in the register.
- While open, a finding raised on a fieldwork audit that belongs to an audit cycle lowers that cycle's readiness score.
- A finding raised by a failed checklist item, or from an auditor's message on a shared audit pack, comes with a remediation task. Resolving or closing that task closes the finding. A finding created on this page comes with no task.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:findings.noFindings}}** | The workspace has no findings | Click **{{ui:findings.newFinding}}**, if your role can create findings |
| The dialog shows an error that does not say why | The finding was refused. The page cannot show the reason: your role may not create findings, or the assignee, a control or a risk is no longer valid | Check your role and your choices, then try again |
| **Failed to create finding** followed by a number in brackets | Inflect answered with an error and gave no reason | Try again |
| A status that flips back after you click | The change was refused, or did not go through | Reload the page and try again. If it keeps flipping back, ask an Owner, Admin or Editor |
| **{{ui:findings.create.risksToLinkEmpty}}** in the dialog | The workspace has no risks, or none matches the search | Clear the search, or create the finding without risks |
| A banner saying only the first 5,000 results are shown | The workspace has more than 5,000 findings | Only the newest 5,000 can be seen; the register has no filters to narrow it |

## Related

- [{{ui:audits.title}}](audits.md), where fieldwork audits raise findings from their checklists.
- [Share an audit pack](../../how-to/audits/share-an-audit-pack.md), which turns an external auditor's message into a finding.
- [{{ui:tasks.list.srTitle}}](tasks.md), where remediation tasks are worked.
- [{{ui:controls.list.pageTitle}}](../govern/controls.md) and [{{ui:risks.title}}](../govern/risks.md), for the controls and risks a finding names.
