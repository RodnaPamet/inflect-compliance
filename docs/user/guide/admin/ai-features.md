---
route: /t/[tenantSlug]/admin/ai-features
---

# {{ui:admin.aiFeatures.heading}}

The {{ui:admin.aiFeatures.heading}} page decides which AI features this workspace uses, whether its data may go to an external model provider, and which engine runs its agents. A feature that is off here is off for everyone in the workspace, whatever their role.

## Where to find it

Click **{{ui:nav.admin}}** at the bottom of the sidebar. Under {{ui:admin.section.organization}}, click **{{ui:admin.nav.aiFeatures}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.crumb.admin}}** › **{{ui:admin.aiFeatures.breadcrumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |
| Turn AI features on or off | Owner |
| Change {{ui:admin.aiResidency.title}} | Owner, Admin |
| Read {{ui:admin.agentEngines.title}} | Owner, Admin |
| Change the engine, and see what a run still needs | Owner |

An Admin sees the sentence **{{ui:admin.aiFeatures.forbidden}}** in place of the switches, and **{{ui:admin.agentEngines.ownerOnly}}** in place of the engine choice. Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}**.

## What you see

The page has three parts, one under the other.

### The AI switches

Four switches, each with a status badge and a **{{ui:admin.aiFeatures.turnOff}}** or **{{ui:admin.aiFeatures.turnOn}}** button:

| Switch | What it covers |
| --- | --- |
| {{ui:admin.aiFeatures.ai.name}} | {{ui:admin.aiFeatures.ai.description}} |
| {{ui:admin.aiFeatures.assistant.name}} | {{ui:admin.aiFeatures.assistant.description}} |
| {{ui:admin.aiFeatures.risk.name}} | {{ui:admin.aiFeatures.risk.description}} |
| {{ui:admin.aiFeatures.questionnaire.name}} | {{ui:admin.aiFeatures.questionnaire.description}} |

Every switch is on until somebody turns it off. The badge says what is actually running:

| Badge | Meaning |
| --- | --- |
| {{ui:admin.aiFeatures.status.on}} | The feature runs |
| {{ui:admin.aiFeatures.status.off-by-tenant}} | Turned off for this workspace |
| {{ui:admin.aiFeatures.status.off-by-master}} | The feature's own switch is on, but **{{ui:admin.aiFeatures.ai.name}}** is off, so it does not run |
| {{ui:admin.aiFeatures.status.off-by-platform}} | Turned off for the whole platform. It has no button, because nothing on this page can change it |

### {{ui:admin.aiResidency.title}}

{{ui:admin.aiResidency.description}} A badge shows the saved choice, **{{ui:admin.aiResidency.externalBadge}}** or **{{ui:admin.aiResidency.localBadge}}**, and two options sit below it:

| Option | Meaning |
| --- | --- |
| {{ui:admin.aiResidency.externalLabel}} | {{ui:admin.aiResidency.externalDesc}} |
| {{ui:admin.aiResidency.localLabel}} | {{ui:admin.aiResidency.localDesc}} |

When **{{ui:admin.aiResidency.localLabel}}** is selected, a note explains what that means on this deployment: whether it has a local model gateway, and which features stop rather than send data out.

### {{ui:admin.agentEngines.title}}

{{ui:admin.agentEngines.description}}

A badge names the engine that runs agents now, and a sentence below it says why: for example, that the workspace has not chosen a reasoning engine, or that the deployment has not turned one on. Three engines can be chosen:

| Engine | What it does |
| --- | --- |
| {{ui:admin.agentEngines.engine.STATIC.name}} | {{ui:admin.agentEngines.engine.STATIC.description}} |
| {{ui:admin.agentEngines.engine.FLUE.name}} | {{ui:admin.agentEngines.engine.FLUE.description}} |
| {{ui:admin.agentEngines.engine.TOOL_RUNNER.name}} | {{ui:admin.agentEngines.engine.TOOL_RUNNER.description}} |

The Flue and Tool Runner engines can be chosen only once the deployment's operator has turned them on; until then they are greyed out. The built-in engine can always be chosen. For the Tool Runner engine, your organization may also have to turn it on, in the organization's settings.

For an Owner, a checklist follows: **{{ui:admin.agentEngines.wiringHeading}}**, or **{{ui:admin.agentEngines.wiringHeadingToolRunner}}**. Each line is met or not, and some carry a **{{ui:admin.agentEngines.fix}}** link to the page that sets them up. Lines marked **{{ui:admin.agentEngines.operatorTerm}}** or **{{ui:admin.agentEngines.organizationTerm}}** are not yours to change from here.

## What you can do

### Turn an AI feature on or off

Click **{{ui:admin.aiFeatures.turnOff}}** or **{{ui:admin.aiFeatures.turnOn}}** beside it. The change is saved at once, for everyone in the workspace, and recorded in the workspace's audit log. Each button changes only its own switch, so two Owners changing different switches at the same time do not undo each other.

Turning off **{{ui:admin.aiFeatures.ai.name}}** stops every AI feature below it without changing their own switches. Turn it back on and each feature returns to the state its own switch shows.

If the change fails, **{{ui:admin.aiFeatures.saveFailedHeading}}** appears with the reason the server gave, and the switch stays as it was.

### Choose where AI runs

Select **{{ui:admin.aiResidency.externalLabel}}** or **{{ui:admin.aiResidency.localLabel}}**, then click **{{ui:admin.aiResidency.save}}**. **{{ui:admin.aiResidency.saved}}** confirms it. The button stays greyed out until the selection differs from what is saved.

### Change the engine

Select an engine. A dialog asks you to confirm, and explains what changes: runs already in progress stay on the engine they started on, and new runs use the new one. Click **{{ui:admin.agentEngines.confirmLabel}}**. You can switch back at any time.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:admin.aiFeatures.loadFailed}}** | The switches did not load | Click **{{ui:common.error.tryAgain}}** |
| **{{ui:admin.aiFeatures.saveFailedHeading}}**, with the reason the server gave | A switch did not change | Fix what it names, or try again |
| **{{ui:admin.aiResidency.loadFailed}}** | The setting did not load | Click **{{ui:common.error.tryAgain}}** |
| **{{ui:admin.aiResidency.saveFailed}}**, or the reason the server gave | The choice was not saved | Try again |
| **{{ui:admin.agentEngines.loadFailed}}** | The engine setting did not load | Click **{{ui:common.error.tryAgain}}** |
| **{{ui:admin.agentEngines.wiringLoadFailed}}** | The checklist did not load | Reload the page |

## Related

- [{{ui:admin.nav.modules}}](modules.md), the other switch for what the workspace has.
- [{{ui:admin.security.title}}](security.md), for the workspace's other security settings.
- [{{ui:admin.auditLog}}](audit-log.md), where every change on this page is recorded.
