---
route: /org/[orgSlug]/settings
---

# {{ui:org.settings.heading}}

The organization's {{ui:org.settings.heading}} page holds settings that apply to every workspace in the organization. Its first line names the organization and its address. Today it has one section: **{{ui:org.settings.agentSwitches.title}}**, two switches for agent features.

## Where to find it

Open the organization. In the sidebar, under {{ui:org.nav.manage}}, click **{{ui:org.nav.settings}}**. Every member of the organization sees the item.

## Who can use it

| Action | Roles |
| --- | --- |
| Read the settings | Owner, Admin, Reader |
| Turn a switch on or off | Owner, Admin |

A Reader sees the switches greyed out, with the note **{{ui:org.settings.agentSwitches.readOnly}}**

## What you see

**{{ui:org.settings.agentSwitches.title}}.** Two switches:

| Switch | What it does |
| --- | --- |
| {{ui:org.settings.agentSwitches.agentProfiles.label}} | {{ui:org.settings.agentSwitches.agentProfiles.help}} |
| {{ui:org.settings.agentSwitches.toolRunner.label}} | {{ui:org.settings.agentSwitches.toolRunner.help}} |

The deployment Inflect runs on can settle a switch for everyone. When it does, the switch carries a badge, **{{ui:org.settings.agentSwitches.deploymentOnBadge}}** or **{{ui:org.settings.agentSwitches.deploymentOffBadge}}**, and a line explains that your choice changes nothing for now. You can still set it, and it takes effect if the deployment later leaves the choice to organizations.

A workspace that does not belong to any organization has both features off.

## What you can do

Click a switch to turn it on or off. Turning one off first asks you to confirm, naming the organization and how many workspaces it reaches, and what stops working; click **{{ui:org.settings.agentSwitches.confirmOff.confirm}}**. Turning one on is saved at once, and so is turning one off when it changes nothing today: a switch the deployment settles, or an organization with no workspace yet.

Each change applies to every workspace in the organization and is recorded in the organization's [{{ui:org.nav.auditLog}}](audit-log.md). Turning agent profiles off keeps every saved profile; they come back if you turn it on again.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:org.settings.agentSwitches.saveFailed}}**, or the reason the server gave | The switch did not change | Try again |
| **{{ui:org.settings.agentSwitches.readOnly}}** | You are a Reader | Ask an Owner or Admin |

## Related

- [{{ui:admin.nav.aiFeatures}}](../admin/ai-features.md), where a workspace owner chooses the agent engine.
