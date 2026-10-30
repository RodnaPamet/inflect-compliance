---
route: /t/[tenantSlug]/admin/audit-log
---

# {{ui:admin.auditLog}}

The {{ui:admin.auditLog}} page shows this workspace's audit log, newest first, a page at a time: when each change was made, who made it, what they did and to what kind of record. Owners and Admins use it to check recent activity, and Auditors to read the record.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens. Under {{ui:admin.section.security}}, click **{{ui:admin.auditLog}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.title}}** › **{{ui:admin.auditLog}}**.

Auditors cannot open the {{ui:admin.title}} page, so the gear does not lead them here. Instead, on the dashboard, click **{{ui:dashboard.activity.viewAuditLog}}** under the **{{ui:dashboard.recentActivity}}** card; Owners and Admins see that link too. For an Auditor the breadcrumb leaves out {{ui:admin.title}}.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and read every entry, a page at a time | Owner, Admin, Auditor |

Editors, Readers and AI admins see **{{ui:admin.forbidden.title}}** instead of the page.

A member whose membership carries a custom role can open the page only if the custom role is built on Owner, Admin or Auditor. Built on Editor or Reader, they see **{{ui:admin.forbidden.title}}**.

The page only reads. Nobody can change or delete an entry, here or anywhere else in Inflect. The one exception is erasing a person's data at their request, which removes their name from the entries recorded against them and keeps the entries.

## What it is for

Almost every change in the workspace writes an entry to the audit log: invites and role changes, risks, controls, evidence, policies, integrations, API keys, custom roles and more, along with refused attempts to use a permission. Each entry is linked to the one before it, so an entry changed or removed after the fact can be detected. That makes the log the workspace's record of who did what, which auditors ask for.

This page is the in-product view of that record. Page back through it to find an older change.

## What you see

One table, one row per entry, newest first.

| Column | What it shows |
| --- | --- |
| {{ui:admin.time}} | The date and time of the entry |
| {{ui:admin.user}} | The name of the person the entry is recorded against. A dash means no person, as for many entries written by Inflect's scheduled jobs, or an account with no name |
| {{ui:admin.action}} | What happened, in words, such as "Custom role created" or "Member role changed". A refused attempt reads "Authorization denied". The words are in English, whatever your language |
| {{ui:admin.entity}} | The kind of record the change was made to, such as "Tenant membership" or "Integration connection" |
| {{ui:admin.details}} | A sentence describing the change, where one was written. Some entries have none |

Each page shows 100 entries. Below the table, **{{ui:admin.auditLogOlder}}** moves to the next 100 older entries, and **{{ui:admin.auditLogNewest}}** returns to the latest. **{{ui:admin.auditLogOlder}}** is not offered on the page that holds the oldest entry. The page has no search, filters, sorting or export.

## What you can do

Read the entries. Scroll the table to see all of them. On a narrow screen the rows show as cards.

To find who made a change, look for its action and the time you expect. For an older change, click **{{ui:admin.auditLogOlder}}** until you reach its time.

## What happens next

- New entries appear when you reload the page or click **{{ui:admin.auditLogNewest}}**. The page does not refresh by itself.
- Entries stay in the log. Deactivating or removing a member does not remove the entries recorded against them.
- If your workspace streams its audit log to an outside security monitoring system, each entry is sent there too. The **{{ui:admin.nav.privacy}}** page shows whether it does.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot read the audit log | Ask an Owner or Admin |
| **{{ui:admin.noEntries}}** | The workspace's audit log has no entries | Nothing to do |
| An error page instead of the table | The log did not load | Reload the page |

## Related

- [{{ui:dashboard.recentActivity}}](../overview/dashboard.md), the dashboard card that shows the latest entries and links here.
- [{{ui:admin.members.title}}](members.md), whose every change is recorded here.
- [{{ui:admin.roles.title}}](roles.md), whose changes are recorded here.
- [{{ui:admin.security.title}}](security.md), whose changes are recorded here.
