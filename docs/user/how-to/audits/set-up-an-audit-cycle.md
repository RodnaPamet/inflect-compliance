# Set up an audit cycle

An audit cycle is one audit against one framework, such as your ISO 27001 recertification for this year. The cycle holds the evidence packs you hand to the auditor and carries a readiness score. Set one up before you build a pack for an external audit.

## Before you start

- Owners, Admins and Editors can create a cycle. The {{ui:audits.cycles.cycle}} button, and {{ui:audits.cycles.addCycle}} when the workspace has no cycles yet, appear for those roles only.
- Owners, Admins and Editors can change a cycle's status. The status list appears for those roles only.
- Every role can open the cycles and look at them.
- The framework must be in use in your workspace: at least one of your controls is mapped to one of its requirements. That is when the {{ui:nav.frameworks}} page marks it {{ui:frameworks.list.installed}}. The list of frameworks in the form offers only those. See [Add a framework](../get-started/add-a-framework.md).
- Decide on the cycle's name and, if you know it, the period the audit covers. You cannot change either on the page after the cycle is created.

## Steps

1. In the sidebar, under {{ui:nav.comply}}, click **{{ui:nav.audits}}**. The {{ui:audits.title}} page opens.
2. In the {{ui:audits.hub.lifecycleTitle}} section, click **{{ui:audits.hub.cycles}}**. The {{ui:audits.cycles.title}} page opens.
3. Click **{{ui:audits.cycles.cycle}}** beside the page title. If the workspace has no cycles yet, click **{{ui:audits.cycles.addCycle}}** instead. The {{ui:audits.cycles.newCycleTitle}} form opens.
4. In **{{ui:audits.cycles.frameworkLabel}}**, choose the framework the audit is against. The first framework in the list is chosen until you pick another.
5. In **{{ui:audits.cycles.cycleName}}**, type a name, up to 200 characters. For example, the framework and the year.
6. Optionally, in **{{ui:audits.cycles.auditPeriod}}**, pick the period the audit covers. Choose a preset, such as **Last quarter**, **Last year** or **Year to date**, or pick a start and end date on the calendar.
7. Click **{{ui:audits.cycles.createCycle}}**. It stays greyed out until the cycle has a name.

## What happens next

- The cycle's page opens. It shows the framework, its version and the status, which starts at {{ui:audits.cycleStatus.PLANNING}}.
- The cycle appears as a card on the {{ui:audits.cycles.title}} page. Click **{{ui:audits.cycles.openCycle}}** on the card to come back to it.
- Each card shows the cycle's readiness score out of 100, or {{ui:audits.cycles.noScore}}. 80 and above counts as ready, 50 to 79 as nearly there, and below 50 as at risk. Click **{{ui:audits.cycles.viewReadiness}}** for the breakdown, the top gaps and the exports.
- To move the cycle on, choose a status from the list at the top of its page. The list is there for Owners, Admins and Editors: {{ui:audits.cycleStatus.PLANNING}}, {{ui:audits.cycleStatus.IN_PROGRESS}}, {{ui:audits.cycleStatus.READY}} or {{ui:audits.cycleStatus.COMPLETE}}. The status is a label for your team. It does not lock the cycle, and you can still build packs in it.
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
| No {{ui:audits.cycles.cycle}} button on the {{ui:audits.cycles.title}} page | Your role cannot create cycles | Ask an Owner, Admin or Editor |
| {{ui:audits.cycles.noFrameworkInUseHint}} in the form | No framework is in use in your workspace yet, so there is nothing to choose | Install a framework, or map a control to one of its requirements, then open the form again. See [Add a framework](../get-started/add-a-framework.md) |
| {{ui:audits.cycles.frameworksLoadError}} | The list of frameworks in use could not be loaded | Close the form and open it again |
| **This framework is not in use in this workspace** | The framework stopped being in use after the form loaded, for example because its last mapped control was deleted | Map a control to the framework again, or choose another framework |
| {{ui:audits.cycles.createError}} | The cycle was not created, and the server gave no reason | Try again. If it still fails, ask an Owner or Admin |
| {{ui:audits.cycles.loadErrorTitle}} | The list of cycles could not be loaded | Click **{{ui:audits.cycles.retry}}** |
| {{ui:audits.cycleDetail.statusError}}, or the reason the server gave | The status did not change, and the list shows the old one again | Try again. If the message names your role, ask an Owner, Admin or Editor |
| {{ui:audits.cycleDetail.loadError}} | The cycle's page could not be loaded | Click **{{ui:audits.cycleDetail.retry}}**. If it keeps failing, go back to {{ui:audits.cycles.title}} and open the cycle from its card |
| {{ui:audits.cycleDetail.notFound}} | The cycle does not exist in this workspace, or the link is wrong | Go back to {{ui:audits.cycles.title}} and open the cycle from its card |
| No **{{ui:audits.newAudit}}** button on the {{ui:audits.title}} page | Your role cannot create audits | Ask an Owner, Admin or Editor |
