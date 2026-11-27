---
route: /org/[orgSlug]/settings
---

# {{ui:org.settings.heading}}

The organization's {{ui:org.settings.heading}} page holds settings that apply to every workspace in the organization. Its first line names the organization and its address. It has two sections: **{{ui:org.settings.agentSwitches.title}}**, two switches for agent features and the organization's **{{ui:org.settings.agentSwitches.turnCaps.title}}**; and **{{ui:org.settings.evaluations.title}}**, the platform's three nightly AI evaluations and whether each is on, which only an Owner or Admin sees.

## Where to find it

Open the organization. In the sidebar, under {{ui:org.nav.manage}}, click **{{ui:org.nav.settings}}**. Every member of the organization sees the item.

## Who can use it

| Action | Roles |
| --- | --- |
| Read the agent switches and per-turn limits | Owner, Admin, Reader |
| Turn a switch on or off, or change a per-turn limit | Owner, Admin |
| See the {{ui:org.settings.evaluations.title}} section | Owner, Admin |
| Switch an evaluation on or off | Owner of the organization that runs Inflect |

A Reader sees the switches and the limits greyed out, with the note **{{ui:org.settings.agentSwitches.readOnly}}**, and no {{ui:org.settings.agentSwitches.turnCaps.save}} buttons.

The operator who runs Inflect can hide the {{ui:org.settings.evaluations.title}} section for an organization that opted out of it. It is shown everywhere else. The evaluations belong to the platform, not to your organization, so only an Owner of the operator's own organization sees their switches; everyone else sees whether each is on, the line **{{ui:org.settings.evaluations.switchHeldByOperator}}**, and the note **{{ui:org.settings.evaluations.readOnly}}**

## What you see

**{{ui:org.settings.agentSwitches.title}}.** Two switches:

| Switch | What it does |
| --- | --- |
| {{ui:org.settings.agentSwitches.agentProfiles.label}} | {{ui:org.settings.agentSwitches.agentProfiles.help}} |
| {{ui:org.settings.agentSwitches.toolRunner.label}} | {{ui:org.settings.agentSwitches.toolRunner.help}} |

The deployment Inflect runs on can settle a switch for everyone. When it does, the switch carries a badge, **{{ui:org.settings.agentSwitches.deploymentOnBadge}}** or **{{ui:org.settings.agentSwitches.deploymentOffBadge}}**, and a line explains that your choice changes nothing for now. You can still set it, and it takes effect if the deployment later leaves the choice to organizations.

A workspace that does not belong to any organization has both features off.

**{{ui:org.settings.agentSwitches.turnCaps.title}}.** Below the switches, two numbers set the most one agent turn may start, for every workspace in the organization. A workspace can set a lower limit for itself, never a higher one.

| Limit | What it does |
| --- | --- |
| {{ui:org.settings.agentSwitches.turnCaps.delegationsPerTurn.label}} | {{ui:org.settings.agentSwitches.turnCaps.delegationsPerTurn.help}} |
| {{ui:org.settings.agentSwitches.turnCaps.toolCallsPerTurn.label}} | {{ui:org.settings.agentSwitches.turnCaps.toolCallsPerTurn.help}} |

**{{ui:org.settings.evaluations.title}}.** {{ui:org.settings.evaluations.description}} It lists the three evaluations, Ragas, garak and Inspect. Each shows **{{ui:org.settings.evaluations.badge.on}}** or **{{ui:org.settings.evaluations.badge.off}}** and when it last changed (**{{ui:org.settings.evaluations.state.neverSwitched}}** if nobody has switched it on yet), with what it tests, when it runs, its spending cap, the API key it uses, and a link to its runs on GitHub.

## What you can do

Click a switch to turn it on or off. Turning one off first asks you to confirm, naming the organization and how many workspaces it reaches, and what stops working; click **{{ui:org.settings.agentSwitches.confirmOff.confirm}}**. Turning one on is saved at once, and so is turning one off when it changes nothing today: a switch the deployment settles, or an organization with no workspace yet.

Each change applies to every workspace in the organization and is recorded in the organization's [{{ui:org.nav.auditLog}}](audit-log.md). Turning agent profiles off keeps every saved profile; they come back if you turn it on again.

To change a per-turn limit, use **{{ui:org.settings.agentSwitches.turnCaps.decrease}}** or **{{ui:org.settings.agentSwitches.turnCaps.increase}}** beside it, then click its **{{ui:org.settings.agentSwitches.turnCaps.save}}**. Each limit saves on its own. Raising a limit is saved at once. Lowering one first asks you to confirm, naming the old and new limit, the organization and how many workspaces it reaches; click **{{ui:org.settings.agentSwitches.turnCaps.confirmLower.confirm}}**. An organization with no workspace yet skips the question. When it is saved you see **{{ui:org.settings.agentSwitches.turnCaps.saved}}** A workspace that set a higher limit keeps its setting, and it applies again if you raise the organization's limit.

An Owner of the operator's organization can click an evaluation's switch to turn it on or off; the switch names what the evaluation may spend while it is on. The change is saved at once, recorded in the organization's [{{ui:org.nav.auditLog}}](audit-log.md), and takes effect at the evaluation's next scheduled run. An evaluation that is off still runs once when someone starts it by hand from GitHub.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:org.settings.agentSwitches.saveFailed}}**, or the reason the server gave | The switch or limit did not change | Try again |
| **{{ui:org.settings.agentSwitches.readOnly}}** | You are a Reader | Ask an Owner or Admin |
| **{{ui:org.settings.evaluations.saveFailed}}** | The evaluation's switch did not change | Try again |
| **{{ui:org.settings.evaluations.readOnly}}** | The evaluations are switched by the platform operator | Ask the operator who runs Inflect |

## Related

- [{{ui:admin.nav.aiFeatures}}](../admin/ai-features.md), where a workspace owner chooses the agent engine.
- [{{ui:admin.security.title}}](../admin/security.md), where a workspace sets a lower limit for itself under **{{ui:admin.security.agentTurnCaps.title}}**.
