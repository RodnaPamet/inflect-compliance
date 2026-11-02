---
route: /t/[tenantSlug]/audits/business-continuity/[id]
---

# A business impact analysis

A business impact analysis's own page shows one process or service: how critical it is, how fast it must come back after a disruption, how its impact grows the longer it is down, what it depends on, and which controls it is evidence for.

## Where to find it

On the [{{ui:audits.crumb.businessContinuity}}](business-continuity.md) register, click an analysis. The breadcrumb reads **{{ui:audits.crumb.dashboard}}** › **{{ui:audits.crumb.internalAudit}}** › **{{ui:audits.crumb.businessContinuity}}** › the analysis's name. The arrows beside the name step to the previous or next analysis in the register.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the analysis | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Mark it reviewed, edit it, delete it, and change its impact profile, dependencies and controls | Owner, Admin, Editor |

For other roles the page is read-only. With custom roles, changes also need your custom role's permission to edit business continuity.

## What you see

**The header.** The name, and:

| Fact | What it shows |
| --- | --- |
| {{ui:audits.biaDetail.metaCriticality}} | {{ui:audits.bia.crit.CRITICAL}}, {{ui:audits.bia.crit.HIGH}}, {{ui:audits.bia.crit.MEDIUM}} or {{ui:audits.bia.crit.LOW}} |
| {{ui:audits.biaDetail.metaRecovery}} | Its place in the register's recovery order, such as Priority 2; priority 1 recovers first |
| {{ui:audits.biaDetail.metaOwner}} | The person responsible, when one is set |
| {{ui:audits.biaDetail.metaReviewed}} | When it was last reviewed and by whom, or **{{ui:audits.biaDetail.neverReviewed}}**. A review recorded before reviewers were kept says the reviewer was not recorded |

**{{ui:audits.biaDetail.secRecoveryObjectives}}.** Three figures, in hours:

| Figure | What it means |
| --- | --- |
| {{ui:audits.biaDetail.kpiRto}} | How soon the process must be running again |
| {{ui:audits.biaDetail.kpiRpo}} | How much data, measured back in time, you can afford to lose |
| {{ui:audits.biaDetail.kpiMtpd}} | The longest disruption the organization can survive |

**{{ui:audits.biaDetail.secRecoveryPriority}}.** Where it falls in the recovery order, and why.

**{{ui:audits.biaDetail.secImpact}}.** How bad a disruption gets over time: one row per point in time (**{{ui:audits.biaDetail.impactAtHours}}** the disruption starts), each rating the **{{ui:audits.biaDetail.impactFinancial}}**, **{{ui:audits.biaDetail.impactOperational}}**, **{{ui:audits.biaDetail.impactReputational}}** and **{{ui:audits.biaDetail.impactLegal}}** impact.

**{{ui:audits.biaDetail.secDependencies}}.** What the process needs in order to run: other processes, assets, vendors or risks, each linked to its page. One that has been deleted since reads **{{ui:audits.biaDetail.depMissing}}**.

**{{ui:audits.biaDetail.secLinked}}.** The step on a process map the analysis is attached to, linked to the map, or **{{ui:audits.biaDetail.notAttached}}**

**{{ui:audits.biaDetail.secFramework}}.** {{ui:audits.biaDetail.secFrameworkDesc}} Each linked control, with the framework requirements it maps to.

**{{ui:audits.biaDetail.secNotes}}**, when there are any.

## What you can do

Owners, Admins and Editors:

### Mark it reviewed

Click **{{ui:audits.biaDetail.markReviewed}}**. The review is recorded as today's, under your name, and the message **{{ui:audits.biaDetail.reviewedToast}}** confirms it. The date cannot be typed in: a review is recorded when it is made.

### Edit it

Click **{{ui:audits.biaDetail.edit}}**. In **{{ui:audits.biaDetail.editTitle}}**, change **{{ui:audits.bia.fieldProcess}}**, **{{ui:audits.bia.fieldCriticality}}**, **{{ui:audits.bia.fieldRto}}**, **{{ui:audits.bia.fieldRpo}}**, **{{ui:audits.bia.fieldMtpd}}**, **{{ui:audits.bia.fieldOwner}}** and **{{ui:audits.bia.fieldNotes}}**, then click **{{ui:audits.biaDetail.save}}**.

### Describe the impact over time

Under **{{ui:audits.biaDetail.secImpact}}**, click **{{ui:audits.biaDetail.impactAddPoint}}** for each point in time, enter the hours and a figure for each kind of impact, and click **{{ui:audits.biaDetail.saveImpact}}**. Use the same scale in every analysis, for example 0 for no impact to 5 for severe, so they can be compared. A value that is not a number is highlighted and nothing is saved until it is corrected.

### Add or remove a dependency

Under **{{ui:audits.biaDetail.secDependencies}}**, choose the kind (process, asset, vendor or risk) and the item, and add it. Click **{{ui:audits.biaDetail.depRemove}}** beside one to take it off; the message **{{ui:audits.biaDetail.dependencyRemoved}}** offers **{{ui:audits.biaDetail.undo}}** for a few seconds.

### Link a control

Click **{{ui:audits.biaDetail.linkControlAction}}**, choose the control in **{{ui:audits.biaDetail.linkControlTitle}}**, and confirm. The analysis becomes evidence for that control, and the framework requirements the control maps to are listed.

### Delete it

Click **{{ui:audits.biaDetail.delete}}** and confirm **{{ui:audits.biaDetail.deleteTitle}}** The analysis and its dependencies are deleted, and you return to the register. This cannot be undone.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:audits.biaDetail.impactEmpty}} | No impact profile yet | Add points, if you can edit |
| {{ui:audits.biaDetail.dependenciesEmpty}} | Nothing is recorded as a dependency | Add the process's dependencies |
| **{{ui:audits.biaDetail.noControlsTitle}}** | The analysis is evidence for no control yet | Click **{{ui:audits.biaDetail.linkControlAction}}** |
| {{ui:audits.biaDetail.controlNoMappings}} | A linked control is not mapped to any framework requirement | Map the control on its page |
| {{ui:audits.biaDetail.saveFailed}}, {{ui:audits.biaDetail.addDependencyFailed}} or {{ui:audits.biaDetail.deleteFailed}} | The change was not saved; the reason may be shown | Try again |
| The page-not-found screen | The analysis does not exist in this workspace | Open it from the register |

## Related

- [{{ui:audits.crumb.businessContinuity}}](business-continuity.md), the register of analyses.
- [Processes](../manage/processes.md), the process maps an analysis attaches to.
- [A control](../govern/control-detail.md), the controls an analysis is evidence for.
