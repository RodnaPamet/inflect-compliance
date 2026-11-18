---
route: /t/[tenantSlug]/processes/agents/[agentId]/flow
---

# An agent's flow

The flow editor draws an agent's written behaviour as steps on the process canvas: what it reads, what it proposes, which other agent it hands work to, and where it writes its answer. Saving a flow writes a new draft version of the agent's behaviour, which a second person approves as on the agent's {{ui:admin.agentDetail.tabBehaviour}} tab.

## Where to find it

Open an agent on the canvas with **{{ui:agentCanvas.openOnCanvas}}**, then click **{{ui:agentCanvas.editFlow}}**. The page exists only where the workspace has the process canvas and agent profiles are switched on; elsewhere it reports that it was not found. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:agents.register.breadcrumb}}** › the agent's name › **{{ui:agentFlow.crumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the editor, save a flow and submit it | Owner, Admin, AI admin |

Everyone else sees **{{ui:agentFlow.forbiddenTitle}}**. {{ui:agentFlow.forbiddenMessage}} Approving a version stays on the agent's {{ui:admin.agentDetail.tabBehaviour}} tab, and nobody approves a version they wrote.

## What it is for

Use it when the order an agent works in is easier to draw than to write. The flow is guidance about order, and a limit on what each step reaches: {{ui:agentFlow.advisoryOrder}}

## What you see

**The bar at the top.** The version the editor opened and its status; **{{ui:agentFlow.save}}**; **{{ui:agentFlow.submit}}**, on a draft with no unsaved changes; and, when another version is in force, a button to compare the flow with it. A line below says whether the flow has unsaved changes.

**A row of buttons to add a step**, one for each of the four kinds of step: **{{ui:agentFlow.kind.read}}**, **{{ui:agentFlow.kind.propose}}**, **{{ui:agentFlow.kind.subagent}}** and **{{ui:agentFlow.kind.synthesis}}**.

**The canvas**, with the steps and the connections between them.

**The inspector**, for the selected step: **{{ui:agentFlow.field.label}}**; the **{{ui:agentFlow.field.tool}}** a read or propose step uses, chosen from the tools the agent is granted of that kind; the **{{ui:agentFlow.field.profile}}** a sub-agent step hands work to, chosen from other agents' approved versions; and **{{ui:agentFlow.field.next}}**. **{{ui:agentFlow.removeStep}}** takes the step away.

**Problems**, beside the step they are about or above the canvas, such as {{ui:agentFlow.diagnostic.FLOW_STEP_NEEDS_TOOL}} or {{ui:agentFlow.diagnostic.FLOW_CYCLE}} The flow cannot be saved while any remain.

**{{ui:agentFlow.compiled.title}}.** The message an engine is handed for the saved version, and which tools a run of it is offered. When the flow has unsaved changes, it says it shows the saved version. A version that carries a drawn flow is refused by every engine in this build, and the panel says so above the message.

## What you can do

### Draw and save a flow

1. Click a kind of step in the row of buttons to add it, and select it to fill in the inspector.
2. Connect the steps in order under **{{ui:agentFlow.field.next}}**.
3. Click **{{ui:agentFlow.save}}**. A new draft version is written, carrying the flow beside the instructions and settings of the version you opened. Moving a step only changes the layout and writes no version.
4. Click **{{ui:agentFlow.submit}}**, then ask another person to approve the version on the agent's {{ui:admin.agentDetail.tabBehaviour}} tab, where the drawn flow is shown and compared as text.

### Compare with the version in force

Click the compare button. The canvas shows what changed, step by step: **{{ui:agentFlow.change.added}}**, **{{ui:agentFlow.change.removed}}**, **{{ui:agentFlow.change.changed}}**, **{{ui:agentFlow.change.edgeAdded}}** or **{{ui:agentFlow.change.edgeRemoved}}**. **{{ui:agentFlow.backToEdit}}** returns to the editor.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| {{ui:agentFlow.noVersionBody}} | A flow is drawn on top of an existing version | Click **{{ui:agentFlow.openBehaviour}}** and write the first version |
| **{{ui:agentFlow.forbiddenTitle}}** | Your role cannot edit the agent register | Ask an Owner, Admin or AI admin |
| {{ui:agentFlow.diffSame}} | Nothing in the flow differs from the version in force | Nothing to do |
| **{{ui:agentFlow.saveFailed}}** or **{{ui:agentFlow.submitFailed}}** | The change did not go through; a reason from the server is shown when there is one | Correct it and try again |

## Related

- [An agent on the canvas](agent-canvas.md), the read-only drawing of the agent.
- [An agent](agent-detail.md), whose {{ui:admin.agentDetail.tabBehaviour}} tab holds every version and its approval.
