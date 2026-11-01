---
route: /org/[orgSlug]/initiatives
---

# {{ui:org.initiatives.title}}

The {{ui:org.initiatives.title}} page lists the organization's security initiatives: programmes of work that run across its workspaces, such as rolling out multi-factor authentication in every subsidiary. Each one has a status, an owner, a target date and progress worked out from the work linked to it.

## Where to find it

Open the organization. In the sidebar, under {{ui:org.nav.portfolio}}, click **{{ui:org.nav.initiatives}}**. The {{ui:org.widgets.securityInitiatives}} card on the [{{ui:org.dashboard.title}}](portfolio-overview.md) also has a **{{ui:org.widgets.viewAll}}** link here.

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
| {{ui:org.initiatives.colOwner}} | The member of the organization who answers for it, or **{{ui:org.initiatives.noOwner}}** |
| {{ui:org.initiatives.colRisk}} | **{{ui:org.initiatives.atRisk}}** when it is blocked, or when its target date has passed and it is neither completed nor cancelled |
| {{ui:org.initiatives.colLinkedWork}} | How many items are linked to it, and across how many workspaces |
| {{ui:org.initiatives.colTarget}} | Its target date, or — |

Click a row to open the initiative (see [the initiative page](initiative.md)).

## What you can do

### Create an initiative

1. Click **{{ui:org.initiatives.newInitiative}}**.
2. Fill in the dialog:

   | Field | What it is |
   | --- | --- |
   | {{ui:org.initiatives.titleLabel}} | What the initiative is. Required |
   | {{ui:org.initiatives.descriptionLabel}} | More about it, if you like |
   | {{ui:org.initiatives.ownerLabel}} | {{ui:org.initiatives.ownerHint}} |
   | {{ui:org.initiatives.targetLabel}} | {{ui:org.initiatives.targetHint}} |

3. Click **{{ui:org.initiatives.createInitiative}}**. Its page opens, with the status **{{ui:org.widgets.statusPlanned}}**.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:org.initiatives.emptyTitle}}** | The organization has no initiatives | An Owner or Admin creates one with **{{ui:org.initiatives.newInitiative}}** |
| **{{ui:org.initiatives.titleRequired}}** | The title is empty | Give it a title |
| **{{ui:org.initiatives.failedCreate}}**, or another sentence in the dialog | The initiative was not created; a sentence from the organization says why, for example that the owner must be a member | Fix what it names, or try again |

## Related

- [The initiative page](initiative.md), its progress, status and linked work.
- [{{ui:org.dashboard.title}}](portfolio-overview.md), whose {{ui:org.widgets.securityInitiatives}} card shows up to five of them.
