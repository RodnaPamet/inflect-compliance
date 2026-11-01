---
route: /org/[orgSlug]/initiatives
---

# {{ui:org.initiatives.title}}

The {{ui:org.initiatives.title}} page lists the organization's security initiatives: programmes of work that run across its workspaces, such as rolling out multi-factor authentication in every subsidiary. Each one has a status, a target date and progress worked out from the work linked to it.

## Where to find it

Open the organization. On the [{{ui:org.dashboard.title}}](portfolio-overview.md), the {{ui:org.widgets.securityInitiatives}} card has a **{{ui:org.widgets.viewAll}}** link; click it. The sidebar has no item for this page.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and see every initiative | Owner, Admin, Reader |
| Create an initiative | Owner, Admin |

## What you see

A table, one row per initiative, grouped by status and then by target date:

| Column | What it shows |
| --- | --- |
| {{ui:org.initiatives.colInitiative}} | Its title |
| {{ui:org.initiatives.colStatus}} | **{{ui:org.widgets.statusPlanned}}**, **{{ui:org.widgets.statusInProgress}}**, **{{ui:org.widgets.statusBlocked}}**, **{{ui:org.widgets.statusCompleted}}** or **{{ui:org.widgets.statusCancelled}}** |
| {{ui:org.initiatives.colRisk}} | **{{ui:org.initiatives.atRisk}}** when it is blocked, or when its target date has passed and it is neither completed nor cancelled |
| {{ui:org.initiatives.colLinkedWork}} | How many items are linked to it, and across how many workspaces |
| {{ui:org.initiatives.colTarget}} | Its target date, or — |

Click a row to open the initiative (see [the initiative page](initiative.md)).

## What you can do

### Create an initiative

1. Click **{{ui:org.initiatives.newInitiative}}**.
2. Give it a title and, if you like, a description.
3. Click **{{ui:org.initiatives.createInitiative}}**. Its page opens, with the status **{{ui:org.widgets.statusPlanned}}**.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| An empty table | The organization has no initiatives | An Owner or Admin creates one |
| **{{ui:org.initiatives.titleRequired}}** | The title is empty | Give it a title |
| **{{ui:org.initiatives.failedCreate}}** | The initiative was not created | Try again |

## Related

- [The initiative page](initiative.md), its progress, status and linked work.
- [{{ui:org.dashboard.title}}](portfolio-overview.md), whose {{ui:org.widgets.securityInitiatives}} card shows up to five of them.
