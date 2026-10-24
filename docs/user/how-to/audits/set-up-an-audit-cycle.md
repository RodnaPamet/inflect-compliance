# Set up an audit cycle

An audit cycle is one audit against one framework, such as your ISO 27001 recertification for this year. The cycle holds the evidence packs you hand to the auditor and carries a readiness score. Set one up before you build a pack for an external audit.

## Before you start

- Owners and Admins can create a cycle. The {{ui:audits.cycles.cycle}} button appears for those roles only.
- Changing a cycle's status takes the Owner, Admin or Editor role.
- Every role can open the cycles and look at them.
- The framework must be installed in your workspace. The list of frameworks offers only the installed ones.
- Decide on the cycle's name and, if you know it, the period the audit covers. You cannot change either on the page after the cycle is created.

## Steps

1. In the sidebar, under {{ui:nav.comply}}, click **{{ui:nav.audits}}**. The {{ui:audits.title}} page opens.
2. In the {{ui:audits.hub.lifecycleTitle}} section, click **{{ui:audits.hub.cycles}}**. The {{ui:audits.cycles.title}} page opens.
3. Click **{{ui:audits.cycles.cycle}}** beside the page title. If the workspace has no cycles yet, click **{{ui:audits.cycles.addCycle}}** instead. The {{ui:audits.cycles.newCycleTitle}} form opens.
4. In **{{ui:audits.cycles.frameworkLabel}}**, choose the framework the audit is against.
5. In **{{ui:audits.cycles.cycleName}}**, type a name, up to 200 characters. For example, the framework and the year.
6. Optionally, in **{{ui:audits.cycles.auditPeriod}}**, pick the period the audit covers. Choose a preset, such as **Last quarter**, **Last year** or **Year to date**, or pick a start and end date on the calendar.
7. Click **{{ui:audits.cycles.createCycle}}**. It stays greyed out until the cycle has a name.

## What happens next

- The cycle's page opens. It shows the framework, its version and the status, which starts at {{ui:audits.cycleStatus.PLANNING}}.
- The cycle appears as a card on the {{ui:audits.cycles.title}} page. Click **{{ui:audits.cycles.openCycle}}** on the card to come back to it.
- Each card shows the cycle's readiness score out of 100, or {{ui:audits.cycles.noScore}}. 80 and above counts as ready, 50 to 79 as nearly there, and below 50 as at risk. Click **{{ui:audits.cycles.viewReadiness}}** for the breakdown, the top gaps and the exports.
- To move the cycle on, choose a status from the list at the top of its page: {{ui:audits.cycleStatus.PLANNING}}, {{ui:audits.cycleStatus.IN_PROGRESS}}, {{ui:audits.cycleStatus.READY}} or {{ui:audits.cycleStatus.COMPLETE}}. The status is a label for your team. It does not lock the cycle, and you can still build packs in it.
- Creating the cycle and changing its status are recorded in the workspace's audit log.
- Next, build the evidence pack for the auditor. See [Build an audit pack](build-an-audit-pack.md).

## Add a fieldwork audit to the cycle

A fieldwork audit tracks the checklist results and findings of an internal audit. Attach one to the cycle so that its open findings lower the cycle's readiness score until they are closed. A finding you create from an external auditor's feedback is also attached to the cycle's fieldwork audit, so the cycle needs one for that. Owners, Admins and Editors can create one.

1. On the cycle's page, under {{ui:audits.cycleDetail.fieldworkAudits}}, click **{{ui:audits.cycleDetail.viewInHub}}**. The {{ui:audits.title}} page opens, filtered to this cycle.
2. Click **{{ui:audits.newAudit}}** at the top of the page.
3. Type the **{{ui:audits.auditTitle}}**. Check that **{{ui:audits.newModal.cycle}}** names your cycle. Choose {{ui:audits.newModal.noCycle}} only for an audit that belongs to no cycle.
4. Click **{{ui:audits.createAudit}}**.

The audit then appears under {{ui:audits.cycleDetail.fieldworkAudits}} on the cycle's page.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| No {{ui:audits.cycles.cycle}} button on the {{ui:audits.cycles.title}} page | Your role cannot create cycles | Ask an Owner or Admin |
| {{ui:audits.cycles.createError}} | The cycle was not created. Your role may not create cycles, or the framework is not installed in this workspace | Choose a framework from the list again and retry. If it still fails, ask an Owner or Admin |
| {{ui:audits.cycles.loadErrorTitle}} | The list of cycles could not be loaded | Click **{{ui:audits.cycles.retry}}** |
| {{ui:audits.cycleDetail.statusError}} | The status did not change, and the list shows the old one again. Only Owners, Admins and Editors can change it | Ask someone with one of those roles |
| {{ui:audits.cycleDetail.loadError}} | The cycle's page could not be loaded, or the cycle no longer exists | Click **{{ui:audits.cycleDetail.retry}}**. If it keeps failing, go back to {{ui:audits.cycles.title}} and open the cycle from its card |
| **You do not have permission to modify records in this context.** when you create a fieldwork audit | Your role cannot create audits | Ask an Owner, Admin or Editor |
