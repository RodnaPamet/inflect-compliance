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
| Edit an audit, or raise a finding on it, while it is {{ui:audits.planned}} or {{ui:audits.inProgress}} | Owner, Admin, Editor |
| Move an audit forward or back a step, or cancel it | Owner, Admin, Editor |
| Record a checklist result, while the audit is {{ui:audits.planned}} or {{ui:audits.inProgress}} | Owner, Admin, Editor |
| Open the pages the header and **{{ui:audits.hub.lifecycleTitle}}** link to | Every role. Each page has its own rules for what you can change there |

The **{{ui:audits.newAudit}}** button, the status buttons, **{{ui:audits.detail.cancelAudit}}**, **{{ui:audits.editModal.trigger}}**, **{{ui:audits.findingModal.trigger}}** and the checklist result lists appear only for Owners, Admins and Editors. Readers, Auditors and AI admins see each audit read-only, with each checklist item's result shown as a badge. A {{ui:audits.completed}} or {{ui:audits.cancelled}} audit is read-only for everyone; see [Move an audit on](#move-an-audit-on).

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
| {{ui:audits.newAudit}} | The new-audit form, from the button with a plus sign. Shown only to Owners, Admins and Editors |

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

- Its title and, for Owners, Admins and Editors, the buttons that change its status and **{{ui:audits.editModal.trigger}}**.
- Its scope, when one was written.
- Its **{{ui:audits.auditors}}**, when any were entered.
- **{{ui:audits.checklist}}**, with the number of items. Each item shows its text and a badge with its result, {{ui:audits.notTested}}, {{ui:audits.pass}} or {{ui:audits.fail}}. Owners, Admins and Editors also get a result list beside each item. An item's note, when it has one, is shown under its text.
- **{{ui:audits.findingsTab}}**, with the number of findings and, for Owners, Admins and Editors, the **{{ui:audits.findingModal.trigger}}** button. Each finding shows its title and its severity, such as **{{ui:audits.findingModal.severityOptions.HIGH}}**.

The panel does not show the audit's framework, cycle, date, departments or criteria. The **{{ui:audits.editModal.trigger}}** form shows all of them.

## What you can do

### Create an audit

Click the **{{ui:audits.newAudit}}** button. The form asks for an **{{ui:audits.auditTitle}}**, which is required, and optionally a **{{ui:audits.newModal.framework}}**, the **{{ui:audits.auditors}}**, an **{{ui:audits.newModal.cycle}}** and the **{{ui:audits.scope}}**. The framework list offers every framework Inflect carries, whether or not the workspace uses it, and starts on **{{ui:audits.newModal.noFramework}}**. The cycle list starts on **{{ui:audits.newModal.noCycle}}**, or on the cycle you filtered the list to, and names each cycle's framework. Click **{{ui:audits.createAudit}}**.

The audit starts as {{ui:audits.planned}} and opens beside the list, with its checklist already written:

- With a framework, one item per requirement of the framework, up to 100, each asking you to verify that requirement's implementation and evidence.
- Without one, or for a framework with no requirements, one item for each of up to 15 of the workspace's controls.

The page cannot add, reword or remove checklist items. If you close the form after typing, it asks **{{ui:audits.newModal.discardTitle}}** Click **{{ui:audits.newModal.discardConfirmLabel}}** to close it, or **{{ui:audits.newModal.discardCancelLabel}}** to go back to what you typed.

### Record checklist results

Choose a result in the list beside each item, and the message **{{ui:audits.detail.checklistSaved}}** confirms it. Changing the result keeps the item's note.

When an item moves to {{ui:audits.fail}} from any other result, Inflect also raises a finding on the audit, a {{ui:findings.nonconformity}} of {{ui:findings.medium}} severity titled with the item's text, and a remediation task for it. Setting the item back and failing it again does not raise a second one.

### Move an audit on

The buttons beside the audit's title depend on its status:

| Status | Buttons |
| --- | --- |
| {{ui:audits.planned}} | **{{ui:audits.inProgress}}** and **{{ui:audits.detail.cancelAudit}}** |
| {{ui:audits.inProgress}} | **{{ui:audits.completed}}**, **{{ui:audits.detail.backToPlanned}}** and **{{ui:audits.detail.cancelAudit}}** |
| {{ui:audits.completed}} | **{{ui:audits.detail.backToInProgress}}** |
| {{ui:audits.cancelled}} | None |

Click one, and a message confirms the new status. Use a back button to correct an audit that was moved on by mistake.

**{{ui:audits.detail.cancelAudit}}** first asks **{{ui:audits.detail.cancelConfirm.title}}** Click **{{ui:audits.detail.cancelConfirm.confirm}}** to mark the audit {{ui:audits.cancelled}}, or **{{ui:audits.detail.cancelConfirm.keep}}** to leave it as it is. Its checklist results and findings are kept. The page cannot reopen a cancelled audit. If the change is refused, the question stays open and a message says why.

A {{ui:audits.completed}} or {{ui:audits.cancelled}} audit is read-only. It offers no **{{ui:audits.editModal.trigger}}**, no result lists and no **{{ui:audits.findingModal.trigger}}**, and a notice says why. To change a completed audit, click **{{ui:audits.detail.backToInProgress}}** first. A cancelled audit cannot be changed at all.

### Edit an audit

Click **{{ui:audits.editModal.trigger}}**. The **{{ui:audits.editModal.title}}** form holds the {{ui:audits.editModal.labelTitle}}, {{ui:audits.newModal.framework}}, {{ui:audits.editModal.labelSchedule}}, {{ui:audits.newModal.cycle}}, {{ui:audits.auditors}}, {{ui:audits.editModal.labelDepartments}}, {{ui:audits.editModal.labelScope}} and {{ui:audits.editModal.labelCriteria}}. Click **{{ui:audits.editModal.save}}**. Emptying {{ui:audits.auditors}} removes the auditors. A new framework does not change the checklist.

### Raise a finding

Click **{{ui:audits.findingModal.trigger}}** in the audit's findings. The **{{ui:audits.findingModal.title}}** form asks for a {{ui:audits.findingModal.labelTitle}} and a {{ui:audits.findingModal.labelDescription}}, both required, a {{ui:audits.findingModal.labelType}}, starting on {{ui:audits.findingModal.typeOptions.NONCONFORMITY}}, and a {{ui:audits.findingModal.labelSeverity}}, starting on {{ui:audits.findingModal.severityOptions.MEDIUM}}. Click **{{ui:audits.findingModal.submit}}**. The finding joins the audit's list.

## What happens next

- Creating and editing an audit, its status changes and checklist results are recorded in the workspace's audit log, naming who made them.
- A finding raised here, by hand or by a failed item, appears in the {{ui:findings.title}} with this audit as its source, or the audit's cycle when it has one. It counts under **{{ui:dashboard.openFindings}}** on the dashboard until it is closed.
- While open, the findings of a fieldwork audit attached to a cycle lower that cycle's readiness score.
- A failed item's remediation task appears in {{ui:nav.tasks}}. Resolving or closing that task closes the finding.
- Cancelling an audit does not close its findings or their remediation tasks. They go on counting as above until they are closed.
- The page cannot delete an audit.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:audits.hub.emptyTitle}}** | The workspace has no audits, or none in the chosen cycle. For Readers, Auditors and AI admins the message adds **{{ui:audits.hub.emptyDescReadOnly}}** | Owners, Admins and Editors click **{{ui:audits.newAudit}}** in the message. Others ask one of them |
| **{{ui:audits.detail.loadError}}** | The audit did not open | Click it in the list again |
| **Audit cycle not found or belongs to a different tenant** | The chosen cycle no longer exists | Choose another cycle, or {{ui:audits.newModal.noCycle}} |
| **{{ui:audits.newModal.createFailed}}** | The audit was not created | Try again |
| **{{ui:audits.detail.statusError}}**, or the reason the server gave | The status did not change, and the old one is shown again | Follow the reason given, then try again |
| **{{ui:audits.detail.checklistError}}**, or the reason the server gave | The result was not saved | Follow the reason given, or reload the page and try again |
| **{{ui:audits.editModal.saveFailed}}**, or the reason the server gave | The changes were not saved, and the form stays open | Follow the reason given, then try again |
| **{{ui:audits.findingModal.createFailed}}**, or the reason the server gave | The finding was not created | Follow the reason given, then try again |
| **{{ui:audits.detail.readOnlyCompleted}}** | The audit is completed, so it is read-only. As a message after a change, somebody completed it while you had it open | Click **{{ui:audits.detail.backToInProgress}}**, then make the change |
| **{{ui:audits.detail.readOnlyCancelled}}** | The audit is cancelled, so it is read-only. As a message after a change, somebody cancelled it while you had it open | Nothing; a cancelled audit cannot be changed |
| A banner saying only the first 5,000 results are shown | The workspace has more than 5,000 audits. While the workspace has cycles and none is chosen, the banner adds **{{ui:audits.hub.truncatedHint}}** | Choose a cycle to narrow the list |

## Related

- [Set up an audit cycle](../../how-to/audits/set-up-an-audit-cycle.md), which also adds a fieldwork audit to a cycle.
- [Build an audit pack](../../how-to/audits/build-an-audit-pack.md) and [Share an audit pack](../../how-to/audits/share-an-audit-pack.md).
- [{{ui:findings.title}}](findings.md), the register of every finding.
- [{{ui:frameworks.list.heading}}](../govern/frameworks.md), the standards an audit is run against.
- [{{ui:tasks.list.srTitle}}](tasks.md), where remediation tasks are worked.
