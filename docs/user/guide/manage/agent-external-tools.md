---
route: /t/[tenantSlug]/agents/external-tools
---

# {{ui:agents.externalTools.title}}

The {{ui:agents.externalTools.title}} page shows the tools an outside tool server offers to your agents, and lets you approve a tool's definition so that it can be granted to an agent. An approval records exactly what the tool said about itself at that moment. If the server later changes the definition, agents stop being able to call it until someone approves it again.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.externalTools}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page, read a server's tools and approve a definition | Owner, Admin, AI admin |
| Choose a write tool's prior-state read | Owner |

Everyone else sees **{{ui:agents.register.accessTitle}}** instead of the page.

## Before you start

The tool server must already be connected, switched on and tested under **Integrations**. Only connected tool servers that are switched on are listed here.

## What you see

**{{ui:agents.externalTools.connectionLabel}}** at the top picks the server. The page reads that server's list of tools as soon as you pick it. Beside it:

- **{{ui:agents.externalTools.refresh}}** reads the list again.
- **{{ui:agents.externalTools.writePolicyLink}}** opens how far agents may change things in this server. Only an Owner can open that page.
- **{{ui:agents.externalTools.parameterSetsLink}}** opens this server's saved parameters, the approved values a change can be made with.

Below them: {{ui:agents.externalTools.grantHint}}

Each tool shows:

- a label saying whether its definition is approved, has never been approved, or has changed since it was approved;
- its name, and the revision of its approved definition;
- the description the server gives for it. This is the server's own text, shown as plain text;
- **{{ui:agents.externalTools.schemaLabel}}**, folded away: the arguments the tool takes;
- the first characters of a fingerprint of the definition;
- **{{ui:agents.externalTools.blocked}}**, when the definition changed in a way that stops agents calling it;
- for a tool the server says changes things, **{{ui:agents.externalTools.priorStateLabel}}** (see below).

When the server offers tools whose names cannot be accepted, a line says how many were left out and why.

## What you can do

### Approve a tool's definition

1. Pick the server, and read the tool's description and arguments.
2. Click **{{ui:agents.externalTools.approve}}**. For a definition that was approved before, the button reads **{{ui:agents.externalTools.reapprove}}**.

The approval is for the definition shown on the page. If the server changed it after the page read it, the approval is refused; refresh and read it again. Once approved, the tool can be granted to an agent on that agent's **Tools** tab.

### Choose a prior-state read for a write tool

Owners only. A tool that changes something in the outside system can be used only if the workspace can first record how things stood before the change, so that it can be checked and reversed. Under **{{ui:agents.externalTools.priorStateLabel}}**, choose the server's read tool that captures that state. **{{ui:agents.externalTools.priorStateNone}}** leaves the write unusable, and the line **{{ui:agents.externalTools.priorStateMissing}}** says so.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.externalTools.noConnectionsTitle}}** | {{ui:agents.externalTools.noConnectionsDesc}} | Connect a tool server under Integrations |
| **{{ui:agents.externalTools.emptyTitle}}** | {{ui:agents.externalTools.emptyDesc}} | Check the server's own configuration |
| {{ui:agents.externalTools.loadFailed}} | The server could not be reached, or refused | Test the connection under Integrations, then click **{{ui:agents.externalTools.refresh}}** |
| {{ui:agents.externalTools.approveFailed}} | The approval did not go through | Refresh and try again |
| {{ui:agents.externalTools.pairingFailed}} | The prior-state read could not be changed | Make sure you are an Owner, then try again |

## Related

- [{{ui:admin.externalWriteLadder.title}}](../admin/external-write-policy.md), how far agents may change things in a server.
- [{{ui:agents.parameterSets.title}}](agent-parameter-sets.md), the approved values a change can be made with.
- [{{ui:agents.compose.title}}](compose-request.md), asking for a change by hand.
