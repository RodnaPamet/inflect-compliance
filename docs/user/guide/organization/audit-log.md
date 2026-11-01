---
route: /org/[orgSlug]/audit
---

# {{ui:org.audit.title}}

The organization's {{ui:org.audit.title}} is the record of what happened at the organization level: who joined or left it, whose role changed, the Admin access those changes gave or took away in its workspaces, invitations, deleted workspaces, settings, the threat level, maturity, initiatives and refused requests. Entries are added in order and chained to one another, so none can be changed or removed afterwards without it showing.

It is separate from each workspace's own [{{ui:admin.auditLog}}](../admin/audit-log.md).

## Where to find it

Open the organization. In the sidebar, under {{ui:org.nav.manage}}, click **{{ui:org.nav.auditLog}}**. The item appears only for Owners and Admins.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and read the log | Owner, Admin |

A Reader who opens the page's address gets **{{ui:org.forbidden.title}}**, saying that owners and admins read the audit log.

## What it is for

"Who could get into our subsidiaries' workspaces, and since when?" is a question an auditor asks of a group. Because organization Owners and Admins are given Admin access to every workspace, a change here changes access across the whole group, and this log is where that is answered.

## What you see

A table, newest entry first, 20 at a time:

| Column | What it shows |
| --- | --- |
| {{ui:org.audit.colTime}} | When it happened |
| {{ui:org.audit.colAction}} | What happened, such as **{{ui:org.audit.actionMemberAdded}}**, **{{ui:org.audit.actionRoleChanged}}**, **{{ui:org.audit.actionInviteCreated}}**, **{{ui:org.audit.actionWorkspaceDeleted}}** or **{{ui:org.audit.actionAccessRefused}}**. The full list is below |
| {{ui:org.audit.colActor}} | Who did it |
| {{ui:org.audit.colTarget}} | Whom it was done to |
| {{ui:org.audit.colSummary}} | The detail in words: the role given, the role before and after, how many workspaces were affected, the level set, or what was refused |

The actions the log records:

| Action | When |
| --- | --- |
| **{{ui:org.audit.actionMemberAdded}}**, **{{ui:org.audit.actionMemberRemoved}}**, **{{ui:org.audit.actionRoleChanged}}** | Someone joined or left the organization, or their organization role changed ([{{ui:org.nav.members}}](members.md)) |
| **{{ui:org.audit.actionProvisioned}}**, **{{ui:org.audit.actionDeprovisioned}}** | Those changes gave or took away Admin access in the workspaces |
| **{{ui:org.audit.actionInviteCreated}}**, **{{ui:org.audit.actionInviteRedeemed}}**, **{{ui:org.audit.actionInviteRevoked}}** | An invitation was sent, accepted or revoked |
| **{{ui:org.audit.actionWorkspaceDeleted}}** | A workspace was deleted ([{{ui:org.nav.allTenants}}](workspaces.md)). This entry outlasts the workspace |
| **{{ui:org.audit.actionAgentSwitchesChanged}}** | The agent features on [{{ui:org.nav.settings}}](settings.md) were turned on or off |
| **{{ui:org.audit.actionThreatLevelSet}}**, **{{ui:org.audit.actionMaturityRated}}** | The threat level or a maturity rating was set on the [{{ui:org.dashboard.title}}](portfolio-overview.md) |
| **{{ui:org.audit.actionInitiativeCreated}}**, **{{ui:org.audit.actionInitiativeStatusChanged}}** | A security initiative was created, or its status changed |
| **{{ui:org.audit.actionAccessRefused}}** | Someone tried something their organization role does not allow |

## What you can do

**Filter.** Choose an action in **{{ui:org.audit.filterLabel}}** to see only those entries; choose **{{ui:org.audit.allActions}}** to see them all again.

**Load older entries.** Click **{{ui:org.audit.loadOlder}}** below the table to see the next 20 older entries. The filter stays as it is.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:org.audit.emptyTitle}}** | Nothing has been recorded for the organization yet | Nothing |
| **{{ui:org.audit.emptyFilteredTitle}}** | No entry has the chosen action | Choose **{{ui:org.audit.allActions}}** |
| **{{ui:org.audit.fetchFailed}}** | The entries did not load | Try again |
| **{{ui:org.forbidden.title}}** | You are a Reader | Ask an Owner or Admin |

## Related

- [{{ui:org.nav.members}}](members.md), where the changes recorded here are made.
