---
route: /t/[tenantSlug]/audits/business-continuity
---

# {{ui:audits.crumb.businessContinuity}}

The {{ui:audits.crumb.businessContinuity}} page is the workspace's register of business impact analyses. Each analysis takes one business process or service, rates how critical it is, and sets how fast it must come back after a disruption. Together they give the order in which to recover your processes.

## Where to find it

Open **{{ui:nav.audits}}** under **{{ui:nav.comply}}** in the sidebar, then click **{{ui:audits.nav.businessContinuity}}** in the header. The breadcrumb reads **{{ui:audits.crumb.dashboard}}** › **{{ui:audits.crumb.internalAudit}}** › **{{ui:audits.crumb.businessContinuity}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the register and any analysis | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Create, edit, review or delete an analysis, and change its dependencies, impact profile and controls | Owner, Admin, Editor |

The **{{ui:audits.bia.addBia}}** button, and the change buttons on an analysis's own page, appear only for those roles. For anyone else an analysis's page is read-only: it shows everything, including the impact profile, with nothing to change.

If your workspace uses custom roles, changing analyses needs both an editing role and your custom role's permission to edit business continuity.

## What it is for

Use the register to plan for disruption: which processes matter most, how long each can be down, how much data each can lose, and what each depends on. It is the business impact analysis that ISO 22301 and NIS2 Article 21(2)(c) expect, and linking an analysis to a control makes it evidence for that control.

## What you see

**The header.** The title, and a line counting the processes analysed in the whole register, how many are critical and how many reviews are overdue. Owners, Admins and Editors also see **{{ui:audits.bia.addBia}}**, with a plus sign.

**The filter.** Filter by **{{ui:audits.bia.fieldCriticality}}**: {{ui:audits.bia.crit.CRITICAL}}, {{ui:audits.bia.crit.HIGH}}, {{ui:audits.bia.crit.MEDIUM}} or {{ui:audits.bia.crit.LOW}}.

**The register.** One row per analysis, in recovery order:

| Column | What it shows |
| --- | --- |
| # | Its place in the recovery order of the whole register, the same number its own page shows. 1 recovers first |
| {{ui:audits.bia.colProcess}} | The process or service, with the process-map step it is attached to, if any |
| {{ui:audits.bia.colCriticality}} | How critical it is: {{ui:audits.bia.crit.CRITICAL}}, {{ui:audits.bia.crit.HIGH}}, {{ui:audits.bia.crit.MEDIUM}} or {{ui:audits.bia.crit.LOW}} |
| {{ui:audits.bia.colRto}} | The recovery time objective: how many hours it may take to bring the process back |
| {{ui:audits.bia.colRpo}} | The recovery point objective: how many hours of data you can afford to lose |
| {{ui:audits.bia.colMtpd}} | The maximum tolerable period of disruption: how many hours before the outage becomes unacceptable |
| {{ui:audits.bia.colOwner}} | The person responsible for it |
| {{ui:audits.bia.colReviewed}} | When it was last reviewed, or **{{ui:audits.bia.reviewOverdue}}** when it has never been reviewed or the last review is more than a year old |

The recovery order puts the most critical processes first. Among equally critical ones, the shortest tolerable disruption comes first, then the shortest recovery time. An analysis with no tolerable disruption set sorts after those that have one.

The register shows up to 200 analyses, the first 200 in recovery order. When the workspace has more, a notice above the table says so, and the filter then applies only to the analyses shown.

Click a row to open the analysis.

## What you can do

### Create an analysis

Click **{{ui:audits.bia.addBia}}**. The **{{ui:audits.bia.createTitle}}** form asks for:

- **{{ui:audits.bia.fieldProcess}}**, required.
- **{{ui:audits.bia.fieldCriticality}}**, required.
- **{{ui:audits.bia.fieldRto}}**, **{{ui:audits.bia.fieldRpo}}** and **{{ui:audits.bia.fieldMtpd}}**, each in hours.
- **{{ui:audits.bia.fieldOwner}}**.
- **{{ui:audits.bia.fieldDependencies}}**: {{ui:audits.bia.hintDependencies}} Choose a type, {{ui:audits.bia.depTypeProcess}}, {{ui:audits.bia.depTypeAsset}}, {{ui:audits.bia.depTypeVendor}} or {{ui:audits.bia.depTypeRisk}}, then the record, and click **{{ui:audits.bia.depAdd}}**.
- **{{ui:audits.bia.fieldNotes}}**, for single points of failure and recovery gaps.

Click **{{ui:audits.bia.create}}**. The analysis's own page opens.

### Work on an analysis

An analysis's page shows its **{{ui:audits.biaDetail.secRecoveryObjectives}}**, its place in the **{{ui:audits.biaDetail.secRecoveryPriority}}** with the reasons for it, its **{{ui:audits.biaDetail.secImpact}}**, **{{ui:audits.biaDetail.secDependencies}}**, **{{ui:audits.biaDetail.secLinked}}**, the frameworks it covers and its **{{ui:audits.biaDetail.secNotes}}**. From there, Owners, Admins and Editors can:

- **{{ui:audits.biaDetail.markReviewed}}**, which records today as the review date. The message **{{ui:audits.biaDetail.reviewedToast}}** confirms it.
- **{{ui:audits.biaDetail.edit}}** the name, criticality, objectives, owner and notes, then **{{ui:audits.biaDetail.save}}**.
- Describe how the impact grows over time: **{{ui:audits.biaDetail.impactAddPoint}}** adds a point in time with a rating for **{{ui:audits.biaDetail.impactFinancial}}**, **{{ui:audits.biaDetail.impactOperational}}**, **{{ui:audits.biaDetail.impactReputational}}** and **{{ui:audits.biaDetail.impactLegal}}** impact, and **{{ui:audits.biaDetail.saveImpact}}** keeps them.
- Add or remove a dependency. Removing one gives you a few seconds to **{{ui:audits.biaDetail.undo}}** it.
- **{{ui:audits.biaDetail.linkControlAction}}**, to attach the analysis as evidence to a control. The frameworks section then shows the framework requirements that control covers.
- **{{ui:audits.biaDetail.delete}}** the analysis, which asks **{{ui:audits.biaDetail.deleteTitle}}** first. Deleting removes its dependencies too and cannot be undone.

## What happens next

- Creating, editing, reviewing and deleting an analysis are recorded in the workspace's audit log, naming who did it.
- A new or changed analysis moves the recovery order for all of them.
- An analysis linked to a control counts as that control's evidence, and its framework coverage comes from that control.
- An incident or a control can show the analyses of the processes they touch.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:audits.bia.emptyTitle}}** | The workspace has no analyses | Owners, Admins and Editors click **{{ui:audits.bia.addBia}}** |
| **{{ui:audits.bia.emptyMatchTitle}}** | No analysis matches the filter | {{ui:audits.bia.emptyMatchDesc}} |
| **{{ui:audits.bia.createFailed}}**, or the reason the server gave | The analysis was not created | Follow the reason given, then try again |
| **{{ui:audits.bia.depLoadFailed}}** | The records to pick a dependency from did not load | Choose the type again |
| **{{ui:audits.biaDetail.saveFailed}}**, or the reason the server gave | The change was not saved | Follow the reason given, then try again |
| **{{ui:audits.biaDetail.addDependencyFailed}}**, or the reason the server gave | The dependency was not added | Follow the reason given, then try again |
| **{{ui:audits.biaDetail.linkControlFailed}}**, or the reason the server gave | The control was not linked | Follow the reason given, then try again |
| **{{ui:audits.biaDetail.deleteFailed}}**, or the reason the server gave | The analysis was not deleted | Follow the reason given, then try again |
| **{{ui:audits.biaDetail.noControlsTitle}}** | The analysis is not evidence for any control yet | Owners, Admins and Editors click **{{ui:audits.biaDetail.linkControlAction}}** |
| A notice that only the first results are shown | The workspace has more than 200 analyses | Nothing to fix; the register shows the 200 that recover first |

## Related

- [{{ui:audits.title}}](audits.md), the page that links here.
- [{{ui:controls.title}}](../govern/controls.md), where linked analyses appear as evidence.
- [{{ui:incidents.title}}](../manage/incidents.md), which shows the analyses of affected processes.
