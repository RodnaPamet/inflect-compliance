---
route: /t/[tenantSlug]/agents/compose
---

# {{ui:agents.compose.title}}

The {{ui:agents.compose.title}} page lets a person ask for a change in an outside system, such as granting someone a role in a connected cloud account, without writing the request from scratch. You pick a template an administrator has approved, fill in only what it leaves open, and submit it. {{ui:agents.compose.intro}}

## Where to find it

Open **{{ui:nav.agents}}** under **{{ui:nav.manage}}** in the sidebar, then choose **{{ui:common.ui.viewsMenu}}** › **{{ui:agents.views.compose}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |
| Submit a request | Owner, Admin, and custom roles that can make changes |

Everyone else sees **{{ui:agents.compose.accessTitle}}** instead of the page. A role that can open the page but not make changes sees **{{ui:agents.compose.readOnly}}**

## What it is for

A template, called a parameter set, is a tool call to an outside system with its values already reviewed and approved. Some templates leave a field open, such as who the change is about, within limits the template sets. Composing fills those fields. It never changes the approved values, and the request still needs a person's approval before anything is sent.

## What you can do

### Compose a request

1. Under **{{ui:agents.compose.templateLabel}}**, choose a template. The page shows the tool it will call.
2. Fill each open field:
   - **{{ui:agents.compose.subjectLabel}}**: choose who or what the change is about from the list. The list holds only what the template allows.
   - Any other open field: type the value, within the limits shown under it.
3. Read the note under the fields: {{ui:agents.compose.approvedNote}}
4. Click **{{ui:agents.compose.submit}}**.

The page then says one of:

- **Queued.** The request is waiting for approval in the [{{ui:agents.proposals.title}}](agent-proposals.md) queue, and nothing has been sent. The message names the proposal.
- **Quarantined.** The output guard refused the request. It will not be reviewed, and nothing was sent. See it on the [{{ui:agents.quarantine.title}}](agent-quarantine.md) page.
- **Refused.** Nothing was sent, and the message says why.

## What happens next

A person who can review agent proposals approves or rejects it in the [{{ui:agents.proposals.title}}](agent-proposals.md) queue. Once approved, it is sent to the outside system according to that connection's [{{ui:admin.externalWriteLadder.title}}](../admin/external-write-policy.md).

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:agents.compose.noTemplatesTitle}}** | No template has been saved yet | An Owner or Admin saves one on the [{{ui:agents.parameterSets.title}}](agent-parameter-sets.md) page |
| A warning in place of a field | The template's list of allowed subjects cannot be read right now, so the request cannot be completed | Try again later, or ask an administrator to check the template |
| A message that the template's fields could not be loaded | The page could not read the template | Choose it again, or reload the page |
| **{{ui:agents.compose.accessTitle}}** | Your role cannot see agent governance | Ask an Owner or Admin |

## Related

- [{{ui:agents.proposals.title}}](agent-proposals.md), where composed requests are approved.
- [{{ui:agents.parameterSets.title}}](agent-parameter-sets.md), where templates are saved and approved.
