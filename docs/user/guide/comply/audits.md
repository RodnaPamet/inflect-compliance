---
route: /t/[tenantSlug]/audits
---

# {{ui:audits.title}}

The {{ui:audits.title}} page is where audits start. It lists the workspace's fieldwork audits, each with its checklist and the findings raised against it, and it links to every page of the audit lifecycle: cycles, packs, readiness, auditors and the related registers.

## Where to find it

Open **{{ui:nav.audits}}** under **{{ui:nav.comply}}** in the sidebar. The breadcrumb reads **{{ui:audits.crumb.dashboard}}** › **{{ui:audits.title}}**. A cycle's page opens it filtered to that cycle from **{{ui:audits.cycleDetail.viewInHub}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page, the list of audits, and an audit's checklist and findings | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Create an audit | Owner, Admin, Editor |
| Edit an audit, or raise a finding on it | Owner, Admin, Editor |
| Move an audit to its next status, or record a checklist result | Owner, Admin, Editor |
| Open the pages the header and **{{ui:audits.hub.lifecycleTitle}}** link to | Every role. Each page has its own rules for what you can change there |

**{{ui:audits.editModal.trigger}}** and **{{ui:audits.findingModal.trigger}}** appear only for Owners, Admins and Editors. The **{{ui:audits.newAudit}}** button, the status button and the checklist result lists are shown to every role, but for a Reader, an Auditor or an AI admin saving fails: the new-audit form says **You do not have permission to modify records in this context.**, and a status or checklist change shows an error message.

If your workspace uses custom roles, these changes follow the built-in role your custom role is based on, not the custom role's own permissions.

## What it is for

Use the page to run internal audits: plan one against a framework, work through its checklist marking each item passed or failed, and record what you find. A failed checklist item becomes a finding with a remediation task. From here you also reach the cycles and packs you prepare for an external auditor.

## What you see

**The header.** The page title and its description, then a row of buttons:

| Button | Opens |
| --- | --- |
| {{ui:audits.nav.nis2Gap}} | The NIS2 gap self-assessment. Shown only while NIS2 is in use: a NIS2 gap assessment has been run, or a control is mapped to a NIS2 requirement |
| {{ui:audits.nav.businessContinuity}} | The business impact analyses |
| {{ui:audits.nav.frameworks}} | The [{{ui:frameworks.list.heading}}](../govern/frameworks.md) page |
| {{ui:audits.nav.scans}} | The {{ui:nav.securityTesting}} page |
| {{ui:audits.findingsTab}} | The [{{ui:findings.title}}](findings.md) |
| {{ui:audits.nav.incidents}} | The incidents register |
| {{ui:audits.newAudit}} | The new-audit form, from the button with a plus sign |

The four after **{{ui:audits.hub.related}}** are separate pages, linked here because their records feed the audit.

**{{ui:audits.hub.lifecycleTitle}}.** A panel with four buttons:

| Button | Opens |
| --- | --- |
| {{ui:audits.hub.cycles}} | The audit cycles: one per external audit against a framework, each with its evidence packs and a readiness score. See [Set up an audit cycle](../../how-to/audits/set-up-an-audit-cycle.md) and [Build an audit pack](../../how-to/audits/build-an-audit-pack.md) |
| {{ui:audits.hub.readiness}} | The readiness overview: control coverage for each cycle, NIS2 self-assessment maturity and test readiness, side by side |
| {{ui:audits.hub.auditorManagement}} | The list of named external auditors and the packs each is meant to see. Only Owners and Admins see the list. See [Share an audit pack](../../how-to/audits/share-an-audit-pack.md) |
| {{ui:audits.hub.workpaperReviews}} | The auditor agent's workpapers drawn for internal audit to review. It lists the reviews assigned to you; internal audit sees them all |

Below them, **{{ui:audits.hub.startTitle}}** sets out six numbered steps. Steps 1 to 4, **{{ui:audits.hub.step1Title}}**, **{{ui:audits.hub.step2Title}}**, **{{ui:audits.hub.step3Title}}** and **{{ui:audits.hub.step4Title}}**, open the cycles. Step 5, **{{ui:audits.hub.step5Title}}**, opens the {{ui:findings.title}}, and step 6, **{{ui:audits.hub.step6Title}}**, opens {{ui:nav.tasks}}.

**The cycle filter.** Once the workspace has an audit cycle, **{{ui:audits.hub.cyclePickerLabel}}** appears above the list. It starts on **{{ui:audits.hub.cyclePickerAll}}**; choose a cycle to list only the fieldwork audits attached to it. A banner then names the cycle, with **{{ui:audits.hub.clearCycleFilter}}** to go back to every audit.

**The list of audits.** Newest first. Each entry shows the audit's title, its status, {{ui:audits.planned}}, {{ui:audits.inProgress}}, {{ui:audits.completed}} or {{ui:audits.cancelled}}, and how many checklist items and findings it has. Click an entry to open it beside the list.

**The audit.** Until you pick one, the panel reads **{{ui:audits.selectAudit}}**. An open audit shows:

- Its title, the button that moves it to its next status, and **{{ui:audits.editModal.trigger}}**.
- Its scope, when one was written.
- **{{ui:audits.checklist}}**, with the number of items. Each item has a result list, {{ui:audits.notTested}}, {{ui:audits.pass}} or {{ui:audits.fail}}, the item's text, and a badge repeating the result. An item's note, when it has one, is shown under its text.
- **{{ui:audits.findingsTab}}**, with the number of findings and the **{{ui:audits.findingModal.trigger}}** button. Each finding shows its title and its severity in capitals, such as **HIGH**.

The panel does not show the audit's framework, cycle, date, departments, criteria or auditors. The **{{ui:audits.editModal.trigger}}** form shows all of them but the auditors.

## What you can do

### Create an audit

Click the **{{ui:audits.newAudit}}** button. The form asks for an **{{ui:audits.auditTitle}}**, which is required, and optionally a **{{ui:audits.newModal.framework}}**, the **{{ui:audits.auditors}}**, an **{{ui:audits.newModal.cycle}}** and the **{{ui:audits.scope}}**. The framework list offers every framework Inflect carries, whether or not the workspace uses it, and starts on **{{ui:audits.newModal.noFramework}}**. The cycle list starts on **{{ui:audits.newModal.noCycle}}**, or on the cycle you filtered the list to. Click **{{ui:audits.createAudit}}**.

The audit starts as {{ui:audits.planned}} and opens beside the list, with its checklist already written:

- With a framework, one item per requirement of the framework, up to 100, each asking you to verify that requirement's implementation and evidence.
- Without one, or for a framework with no requirements, one item for each of up to 15 of the workspace's controls.

The page cannot add, reword or remove checklist items. If you close the form after typing, it asks **{{ui:audits.newModal.discardConfirm}}**

### Record checklist results

Choose a result in the list beside each item, and the message **{{ui:audits.detail.checklistSaved}}** confirms it. Changing the result clears the item's note.

When an item moves to {{ui:audits.fail}} from any other result, Inflect also raises a finding on the audit, a {{ui:findings.nonconformity}} of {{ui:findings.medium}} severity titled with the item's text, and a remediation task for it. Setting the item back and failing it again does not raise a second one.

### Move an audit on

A {{ui:audits.planned}} audit shows the **{{ui:audits.inProgress}}** button, and an {{ui:audits.inProgress}} audit the **{{ui:audits.completed}}** button. Click it, and a message confirms the new status. The page has no way to move an audit back or to cancel it. A completed audit can still be edited and its checklist changed.

### Edit an audit

Click **{{ui:audits.editModal.trigger}}**. The **{{ui:audits.editModal.title}}** form holds the {{ui:audits.editModal.labelTitle}}, {{ui:audits.newModal.framework}}, {{ui:audits.editModal.labelSchedule}}, {{ui:audits.newModal.cycle}}, {{ui:audits.editModal.labelDepartments}}, {{ui:audits.editModal.labelScope}} and {{ui:audits.editModal.labelCriteria}}. Click **{{ui:audits.editModal.save}}**. A new framework does not change the checklist.

### Raise a finding

Click **{{ui:audits.findingModal.trigger}}** in the audit's findings. The **{{ui:audits.findingModal.title}}** form asks for a {{ui:audits.findingModal.labelTitle}} and a {{ui:audits.findingModal.labelDescription}}, both required, a {{ui:audits.findingModal.labelType}}, starting on {{ui:audits.findingModal.typeOptions.NONCONFORMITY}}, and a {{ui:audits.findingModal.labelSeverity}}, starting on {{ui:audits.findingModal.severityOptions.MEDIUM}}. Click **{{ui:audits.findingModal.submit}}**. The finding joins the audit's list.

## What happens next

- Creating and editing an audit, its status changes and checklist results are recorded in the workspace's audit log, naming who made them.
- A finding raised here, by hand or by a failed item, appears in the {{ui:findings.title}} with this audit as its source, or the audit's cycle when it has one. It counts under **{{ui:dashboard.openFindings}}** on the dashboard until it is closed.
- While open, the findings of a fieldwork audit attached to a cycle lower that cycle's readiness score.
- A failed item's remediation task appears in {{ui:nav.tasks}}. Resolving or closing that task closes the finding.
- The page cannot delete an audit.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:audits.hub.emptyTitle}}** | The workspace has no audits, or none in the chosen cycle | Click **{{ui:audits.newAudit}}** in the message, if your role can create audits |
| **{{ui:audits.detail.loadError}}** | The audit did not open | Click it in the list again |
| **You do not have permission to modify records in this context.** in the new-audit form | Your role cannot create audits | Ask an Owner, Admin or Editor |
| **Audit cycle not found or belongs to a different tenant** | The chosen cycle no longer exists | Choose another cycle, or {{ui:audits.newModal.noCycle}} |
| **{{ui:audits.newModal.createFailed}}** | The audit was not created | Try again |
| **{{ui:audits.detail.statusError}}** | The status did not change, and the old one is shown again. It is also what a role that cannot change audits sees | Try again, or ask an Owner, Admin or Editor |
| **{{ui:audits.detail.checklistError}}** | The result was not saved. It is also what a role that cannot change audits sees | Reload the page and try again, or ask an Owner, Admin or Editor |
| **{{ui:audits.editModal.saveFailed}}** | The changes were not saved | Try again |
| **{{ui:audits.findingModal.createFailed}}**, or the reason the server gave | The finding was not created | Follow the reason given, then try again |
| A banner saying only the first 5,000 results are shown | The workspace has more than 5,000 audits | Choose a cycle to narrow the list |

## Related

- [Set up an audit cycle](../../how-to/audits/set-up-an-audit-cycle.md), which also adds a fieldwork audit to a cycle.
- [Build an audit pack](../../how-to/audits/build-an-audit-pack.md) and [Share an audit pack](../../how-to/audits/share-an-audit-pack.md).
- [{{ui:findings.title}}](findings.md), the register of every finding.
- [{{ui:frameworks.list.heading}}](../govern/frameworks.md), the standards an audit is run against.
- [{{ui:tasks.list.srTitle}}](tasks.md), where remediation tasks are worked.
