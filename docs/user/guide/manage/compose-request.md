---
route: /t/[tenantSlug]/agents/compose
---

# {{ui:agents.compose.title}}

The {{ui:agents.compose.title}} page lets a person ask for a change in an outside system, such as granting someone a role in a connected cloud account, without writing the request from scratch. You pick a template an administrator has approved, fill in only what it leaves open, and submit it for approval.

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.compose}}**. The breadcrumb reads **{{ui:agents.crumbDashboard}}** › **{{ui:agents.compose.crumbAgents}}** › **{{ui:agents.compose.title}}**, and the page's own **{{ui:common.ui.viewsMenu}}** sits at the top right.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |
| Submit a request | Owner, Admin, and custom roles that can make changes |
| Approve your own composed request | Nobody, unless an Owner allows it (see below) |

Everyone else sees **{{ui:agents.compose.accessTitle}}** instead of the page. A role that can open the page but not make changes sees **{{ui:agents.compose.readOnly}}**

Whether the person who composes a request may also approve it is an Owner's choice, on [{{ui:admin.aiFeatures.heading}}](../admin/ai-features.md) › {{ui:admin.agentOversight.heading}}. By default they may not, and the page says: {{ui:agents.compose.intro}} When an Owner allows it, the page says instead: {{ui:agents.compose.introSelfApproval}}

## What it is for

A template, called a parameter set, is a tool call to an outside system with its values already reviewed and approved. Some templates leave a field open, such as who the change is about, within limits the template sets. Composing fills those fields. It never changes the approved values, and the request still needs a person's approval before anything is sent.

Only templates that leave at least one field open are offered. A template with nothing to fill in is left out, and a line above the form says how many were left out and why.

## What you can do

### Compose a request

1. Under **{{ui:agents.compose.templateLabel}}**, choose a template. A line below it names the tool it will use and the connection it runs on.
2. Fill each open field. Each is labelled by its name, with what it accepts written under it:
   - **{{ui:agents.compose.subjectLabel}}**: choose who or what the change is about from the list. The list holds only what the template allows. When a template opens two subjects, each is labelled with its field name.
   - A field with a fixed list of values: choose one from the list.
   - A number: type a whole number within the range shown.
   - Text: type a value of the length shown, or in the format the template allows.
3. Read the note under the fields: {{ui:agents.compose.approvedNote}}
4. Click **{{ui:agents.compose.submit}}**.

The page then says one of:

- {{ui:agents.compose.queued}} A link, **{{ui:agents.compose.openProposals}}**, takes you to the [{{ui:agents.proposals.title}}](agent-proposals.md) queue, where it waits.
- {{ui:agents.compose.quarantined}} If you can read quarantined proposals, **{{ui:agents.compose.openQuarantine}}** takes you to the [{{ui:agents.quarantine.title}}](agent-quarantine.md) page.
- Nothing was sent, followed by the reason.

## What happens next

A person who can review agent proposals approves or rejects it in the [{{ui:agents.proposals.title}}](agent-proposals.md) queue. Once approved, it is sent to the outside system according to that connection's [{{ui:admin.externalWriteLadder.title}}](../admin/external-write-policy.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.compose.noTemplatesTitle}}**, with **{{ui:agents.compose.openParameterSets}}** | No template that leaves a field open has been saved, and you can save one | Click **{{ui:agents.compose.openParameterSets}}** |
| **{{ui:agents.compose.noTemplatesTitle}}**: {{ui:agents.compose.noTemplatesDesc}} | The same, and you cannot save one | Ask someone who manages the agent register |
| A warning in place of a field | The template's list of allowed subjects cannot be read right now, so the request cannot be completed | Try again later, or ask an administrator to check the template |
| That the template's fields could not be loaded, with a reason | The page could not read the template | {{ui:agents.compose.tryAgain}} |
| {{ui:agents.compose.networkFailed}} | The request did not reach the server | Check your connection, then submit again |
| **{{ui:agents.compose.accessTitle}}** | Your role cannot see agent governance | Ask an Owner or Admin |

## Related

- [{{ui:agents.proposals.title}}](agent-proposals.md), where composed requests are approved.
- [{{ui:agents.parameterSets.title}}](agent-parameter-sets.md), where templates are saved and approved.
- [{{ui:admin.aiFeatures.heading}}](../admin/ai-features.md), where an Owner decides whether a composer may approve their own request.
