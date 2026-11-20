---
route: /t/[tenantSlug]/processes/agents/[agentId]
---

# An agent on the canvas

This page draws one registered agent on the process canvas: the agent at the centre, and around it what starts it, the tools and skills it may use, the steps of its written behaviour and what it produces. It is a picture to read. **{{ui:agentCanvas.readOnly}}**: nothing on it can be changed.

## Where to find it

Open an agent from [{{ui:nav.agents}}](agents.md) and click **{{ui:agentCanvas.openOnCanvas}}** beside the header's buttons. On the agent's **{{ui:admin.agentDetail.tabBehaviour}}** tab, **{{ui:agents.behaviour.canvas.open}}** opens the version in force, or the version open for review, and a reviewer of a submitted version is offered **{{ui:agents.behaviour.canvas.compare}}**. On a [process map](processes.md), double-click an Agent step, or select it and click **{{ui:automation.autoInspector.openAgentOnCanvas}}**. These links are shown only where the workspace has the process canvas; without it this page reports that it was not found. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:agents.register.breadcrumb}}** › the agent's name › **{{ui:agentCanvas.tabCanvas}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin, AI admin, Auditor |
| See the agent's written behaviour drawn on it | Owner, Admin, AI admin |
| **{{ui:agentCanvas.editFlow}}** | Owner, Admin, AI admin, where agent profiles are switched on |

Everyone else sees **{{ui:agentCanvas.forbiddenTitle}}**. {{ui:agentCanvas.forbiddenMessage}}

## What it is for

Use it to see at a glance what an agent is: how much authority it holds, which tools a run of it is really offered and which it is not, and why. It answers the same questions as the agent's own page, in one picture.

## What you see

**The header.** The agent's name with **{{ui:agentCanvas.readOnly}}**, and **{{ui:agentCanvas.editFlow}}** for roles that can edit the agent's behaviour.

**A note** when the agent's written behaviour is not drawn, saying why: {{ui:agentCanvas.profileAbsent.OFF}} Or: {{ui:agentCanvas.profileAbsent.NOT_PERMITTED}} Or: {{ui:agentCanvas.profileAbsent.NONE}} When the version drawn is not the approved version in force, a warning names it.

**The legend.** {{ui:agentCanvas.legend}}

**Two tabs over the same picture:**

- **{{ui:agentCanvas.tabCanvas}}**, the drawing. Each box is one element: **{{ui:agentCanvas.kind.hub}}**, **{{ui:agentCanvas.kind.trigger}}**, **{{ui:agentCanvas.kind.tool}}**, **{{ui:agentCanvas.kind.skill}}**, **{{ui:agentCanvas.kind.step}}**, **{{ui:agentCanvas.kind.map}}** or **{{ui:agentCanvas.kind.output}}**.
- **{{ui:agentCanvas.tabElements}}**, the same elements as a list, with a count. Each line gives the element's kind and name, its badges, and, where it has one, the reason it is held back. Use this tab with a keyboard or a screen reader.

The badges say what each element is. The agent's box carries its status, its autonomy, its policy card version, its circuit breaker state, any stop in force, and, when it is unscored, **{{ui:agentCanvas.badge.unscored}}**. A tool reads **{{ui:agentCanvas.badge.read}}** or **{{ui:agentCanvas.badge.propose}}**, and **{{ui:agentCanvas.badge.offered}}**, **{{ui:agentCanvas.badge.narrowed}}**, **{{ui:agentCanvas.badge.notInProfile}}** or **{{ui:agentCanvas.badge.notProbed}}**. A tool that is narrowed away says why, for example: {{ui:agentCanvas.reason.AUTONOMY}}

### Comparing two versions

Opened with **{{ui:agents.behaviour.canvas.compare}}**, the page draws the version under review against the version in force. A heading names both versions, and the changes are listed in words above the drawing, for example *Tool added*, *Trigger removed* or *Model tier changed*: each tool, skill and trigger the version adds or removes, and its model tier, effort, turn limit and output when they change. On the drawing and in **{{ui:agentCanvas.tabElements}}**, each changed element is marked **{{ui:agentCanvas.diff.mark.added}}**, **{{ui:agentCanvas.diff.mark.removed}}** or **{{ui:agentCanvas.diff.mark.changed}}**. What the version removes is still drawn, so you see it go. {{ui:agentCanvas.diff.none}} appears when the version changes none of these; read the instructions on the **{{ui:admin.agentDetail.tabBehaviour}}** tab, where the text changes are shown.

**{{ui:agentCanvas.instructions}}**, folded away below, holds every word of the drawn version's instructions, when the behaviour is shown.

## What you can do

Read it. To change the agent, go back to its page. To change its written behaviour as a drawing, click **{{ui:agentCanvas.editFlow}}**, which opens the [flow editor](agent-flow.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agentCanvas.forbiddenTitle}}** | Your role cannot open the agent register | Ask an Owner or Admin |
| The page was not found | The workspace does not have the process canvas, or the agent does not exist | Open the agent from the register |
| {{ui:agentCanvas.profileAbsent.NONE}} | Only the register entry can be drawn | Write the agent's first version on its {{ui:admin.agentDetail.tabBehaviour}} tab |
| {{ui:agentCanvas.diff.unavailable}} | You cannot read the agent's written behaviour, or the link names a version this agent does not have | Ask an Owner, Admin or AI admin, or open the comparison again from the {{ui:admin.agentDetail.tabBehaviour}} tab |

## Related

- [An agent](agent-detail.md), where the agent is changed.
- [The agent's flow](agent-flow.md), where its behaviour is drawn as steps.
- [{{ui:automation.documentBar.processes}}](processes.md), the process canvas.
