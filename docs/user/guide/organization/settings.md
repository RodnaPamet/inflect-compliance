---
route: /org/[orgSlug]/settings
---

# {{ui:org.settings.heading}}

The organization's {{ui:org.settings.heading}} page holds settings that apply to every workspace in the organization. Today it has one section: **{{ui:org.settings.agentSwitches.title}}**, two switches for agent features.

## Where to find it

Open the organization. In the sidebar, under {{ui:org.nav.manage}}, click **{{ui:org.nav.settings}}**. The item appears for Owners and Admins; any member can open the page's address and read it.

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

Click a switch to turn it on or off. The change is saved at once, applies to every workspace in the organization, and is recorded in the organization's [{{ui:org.nav.auditLog}}](audit-log.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:org.settings.agentSwitches.saveFailed}}**, or the reason the server gave | The switch did not change | Try again |
| **{{ui:org.settings.agentSwitches.readOnly}}** | You are a Reader | Ask an Owner or Admin |

## Related

- [{{ui:admin.nav.aiFeatures}}](../admin/ai-features.md), where a workspace owner chooses the agent engine.
