---
route: /org/[orgSlug]/audit
---

# {{ui:org.audit.title}}

The organization's {{ui:org.audit.title}} is the record of what changed at the organization level: who joined or left it, whose role changed, and the Admin access those changes gave or took away in its workspaces. Entries are added in order and chained to one another, so none can be changed or removed afterwards without it showing.

It is separate from each workspace's own [{{ui:admin.auditLog}}](../admin/audit-log.md).

## Where to find it

Open the organization. In the sidebar, under {{ui:org.nav.manage}}, click **{{ui:org.nav.auditLog}}**. The item appears only for Owners and Admins.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and read the log | Owner, Admin |

A Reader who opens the page's address gets an error page instead.

## What it is for

"Who could get into our subsidiaries' workspaces, and since when?" is a question an auditor asks of a group. Because organization Owners and Admins are given Admin access to every workspace, a change here changes access across the whole group, and this log is where that is answered.

## What you see

A table, newest entry first, 20 at a time:

| Column | What it shows |
| --- | --- |
| {{ui:org.audit.colTime}} | When it happened |
| {{ui:org.audit.colAction}} | What happened: **{{ui:org.audit.actionMemberAdded}}**, **{{ui:org.audit.actionMemberRemoved}}**, **{{ui:org.audit.actionRoleChanged}}**, **{{ui:org.audit.actionProvisioned}}** or **{{ui:org.audit.actionDeprovisioned}}** |
| {{ui:org.audit.colActor}} | Who did it |
| {{ui:org.audit.colTarget}} | Whom it was done to |
| {{ui:org.audit.colSummary}} | The detail: the role given, the role before and after, or how many workspaces were affected |

The log records more than these five kinds of change, such as invitations, threat-level and maturity updates, initiatives, workspace removals and changes to [{{ui:org.nav.settings}}](settings.md).

## What you can do

Read the log. Click **{{ui:org.audit.loadOlder}}** below the table to see the next 20 older entries.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:org.audit.emptyTitle}}** | Nothing has been recorded for the organization yet | Nothing |
| **{{ui:org.audit.fetchFailed}}** or another red message under the table | Older entries did not load | Click **{{ui:org.audit.loadOlder}}** again |

## Related

- [{{ui:org.nav.members}}](members.md), where the changes recorded here are made.
