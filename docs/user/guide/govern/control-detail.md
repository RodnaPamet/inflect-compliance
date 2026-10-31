---
route: /t/[tenantSlug]/controls/[controlId]
---

# A control

A control's page is where you work on one control: set its status and whether it applies, edit what it is, and keep its tasks, evidence, requirements, links, tests and exceptions together.

## Where to find it

Open **{{ui:nav.controls}}** under **{{ui:nav.govern}}** and click a control's name. The breadcrumb reads **{{ui:controls.detailPage.breadcrumbDashboard}}** › **{{ui:controls.detailPage.breadcrumbControls}}** › the control's name. Arrows beside the title step to the previous or next control in the list you came from.

## Who can use it

| Action | Roles |
| --- | --- |
| View the control and every tab | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Change the status or applicability, edit the control, add or remove contributors | Owner, Admin, Editor |
| Attach or unlink evidence, map requirements, link risks and assets | Owner, Admin, Editor |
| Create tasks from the **{{ui:controls.detailPage.tabTasks}}** tab | Owner, Admin, Editor |
| Request or renew an exception | Owner, Admin, Editor |
| Approve or reject an exception | Owner, Admin |

If your workspace uses custom roles, the page offers only what your role's permissions allow.

## What it is for

Answer, in one place, whether a control is in place and working: what it is meant to achieve, who owns it, what has been done, what proves it, which requirements it meets and when it was last tested.

## What you see

**The header.** The control's name, its **{{ui:controls.detailPage.metaCode}}** (click it to copy), **{{ui:controls.status}}** and **{{ui:controls.detailPage.metaApplicability}}**. When the control is fed by an integration, a badge shows whether the last sync worked: **{{ui:controls.detailPage.synced}}**, **{{ui:controls.detailPage.syncFailedBadge}}** or **{{ui:controls.detailPage.syncConflictBadge}}**. A badge also shows an exception in force.

On the right: **{{ui:controls.detailPage.whereUsed}}**, and, if you can edit, the status picker and **{{ui:controls.detailPage.applicabilityButton}}**. **{{ui:controls.detailPage.aiSuggestions}}** opens a side panel of suggestions.

**The tabs.**

| Tab | What it holds |
| --- | --- |
| **{{ui:controls.detailPage.tabOverview}}** | A health summary, the control's fields, linked policies and exceptions |
| **{{ui:controls.detailPage.tabTasks}}** | The tasks linked to the control, with their progress |
| **{{ui:controls.detailPage.tabEvidence}}** | Files, links and evidence records that prove the control works |
| **{{ui:controls.detailPage.tabRequirements}}** | The framework requirements the control meets |
| **{{ui:controls.detailPage.tabTraceability}}** | The risks and assets the control covers, and the vendors linked to it |
| **{{ui:controls.detailPage.tabActivity}}** | Everything that has happened to the control, newest first |
| **{{ui:controls.detailPage.tabTests}}** | Test plans a person runs on a schedule |
| **{{ui:controls.detailPage.tabChecks}}** | Automated checks an integration runs |

The number on a tab counts what it holds.

**The overview.** A health card brings together status, applicability, the latest test and check, and how well the control covers its requirements. Below it, the control's fields: **{{ui:controls.detailPage.eyebrowObjective}}**, **{{ui:controls.detailPage.eyebrowSuccessCriteria}}** when set, **{{ui:controls.editModal.categoryLabel}}**, **{{ui:controls.detailPage.eyebrowFrequency}}**, **{{ui:controls.detailPage.eyebrowAutomationType}}**, **{{ui:controls.detailPage.eyebrowMitigationType}}**, **{{ui:controls.detailPage.eyebrowOwner}}**, **{{ui:controls.detailPage.eyebrowTasksProgress}}**, **{{ui:controls.detailPage.eyebrowContributors}}**, **{{ui:controls.detailPage.eyebrowLastTested}}** and **{{ui:controls.detailPage.eyebrowNextDue}}**. A control marked not applicable also shows its **{{ui:controls.detailPage.eyebrowNaJustification}}**. Then **{{ui:controls.detailPage.policiesTitle}}**, the policies linked to the control, and **{{ui:panels.exceptions.title}}**.

A control installed from a framework often has no objective of its own: it is described by its requirements and tasks instead, and the field says so.

## What you can do

### Change the status

Choose a status from the picker in the header: {{ui:controls.filterEnums.status.NOT_STARTED}}, {{ui:controls.filterEnums.status.PLANNED}}, {{ui:controls.filterEnums.status.IN_PROGRESS}}, {{ui:controls.filterEnums.status.IMPLEMENTING}}, {{ui:controls.filterEnums.status.IMPLEMENTED}} or {{ui:controls.filterEnums.status.NEEDS_REVIEW}}. The badge changes at once.

### Mark the control as not applicable

1. Click **{{ui:controls.detailPage.applicabilityButton}}**. The **{{ui:controls.setApplicability}}** panel opens.
2. Choose **{{ui:controls.notApplicable}}** and say why. The justification is required: it is what an auditor reads in your Statement of Applicability.
3. Click **{{ui:controls.detailPage.save}}**.

Choose **{{ui:controls.applicable}}** the same way to bring it back into scope.

### Edit the control

Click the pencil at the top of the overview. You can change the name, objective, success criteria, testing methodology, category, frequency, owner, automation and mitigation type. The name needs at least three characters. **{{ui:controls.detailPage.controlUpdated}}** confirms the save.

### Add or remove contributors

Under **{{ui:controls.detailPage.eyebrowContributors}}**, pick a member and click **{{ui:controls.detailPage.addContributor}}**. Click the cross on a contributor to remove them. You have a few seconds to click **{{ui:controls.detailPage.undo}}**.

### Attach evidence

On **{{ui:controls.detailPage.tabEvidence}}**, upload a file or give a link with a title. The evidence is added to the workspace's evidence library and linked to this control. Unlinking takes it off the control and leaves it in the library, with a few seconds to undo.

### Map requirements, risks and assets

On **{{ui:controls.detailPage.tabRequirements}}**, pick a framework requirement the control meets. On **{{ui:controls.detailPage.tabTraceability}}**, link the risks the control reduces and the assets it protects.

### Request an exception

When the control cannot be put in place as designed, click **{{ui:panels.exceptions.request}}** under **{{ui:panels.exceptions.title}}**. Give a **{{ui:panels.exceptions.justification}}** and choose who it is **{{ui:panels.exceptions.riskAcceptedBy}}**. Optionally add a **{{ui:panels.exceptions.compensatingControl}}** and a **{{ui:panels.exceptions.proposedExpiry}}**. An Owner or Admin then approves it, with an expiry date, or rejects it with a reason. **{{ui:panels.exceptions.renew}}** starts a new request from an approved or expired exception.

### See where the control is used

**{{ui:controls.detailPage.whereUsed}}** lists the requirements the control satisfies, the risks it mitigates, the assets it protects and the process maps that use it.

## What happens next

- A status change shows on the controls list, the dashboard's coverage figures and every framework the control is mapped to.
- Marking a control not applicable takes it out of coverage and puts it in your Statement of Applicability with its justification.
- Evidence you attach counts towards every requirement the control is mapped to.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:controls.detailPage.objectiveEmpty}}** | The control has no objective, requirements or tasks | Edit the control and add an objective |
| **{{ui:controls.detailPage.policiesEmptyTitle}}** | No policy is linked to the control | Link the control from a policy's page |
| **{{ui:panels.exceptions.emptyExceptions}}** | No exception has been requested | Nothing to do |
| The status picker goes back to the old status | The change was refused, and the page does not say why | Reload the page, check you can still edit controls, and try again |
| **{{ui:controls.detailPage.errors.applicabilityFailed}}** | The applicability was not saved | Try again |
| **{{ui:controls.detailPage.errors.titleMinLength}}** | The name is shorter than three characters | Give it a longer name |
| **{{ui:controls.detailPage.errors.updateFailed}}**, or the reason it was refused | The edit was not saved | Follow the reason given, then try again |
| **{{ui:controls.detailPage.errors.addContributorFailed}}** or **{{ui:controls.detailPage.errors.removeContributorFailed}}** | The contributor was not added or removed | Try again |
| **{{ui:controls.detailPage.couldntLoadEvidence}}** or **{{ui:controls.detailPage.couldntLoadActivity}}** | That tab could not load | Reload the page |
| **{{ui:controls.detailPage.syncFailedBadge}}** or **{{ui:controls.detailPage.syncConflictBadge}}** | The integration that feeds the control could not sync it, or found changes on both sides | Hover over the badge for the reason, then check the integration |

## Related

- [{{ui:controls.list.pageTitle}}](controls.md), the list of every control.
- [Evidence](../comply/evidence.md), the workspace's evidence library.
- [Tests](../comply/tests.md), where test plans are run.
- [Attach evidence to a control](../../how-to/get-started/attach-evidence-to-a-control.md).
