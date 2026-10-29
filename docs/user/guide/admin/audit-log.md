---
route: /t/[tenantSlug]/admin/audit-log
---

# {{ui:admin.auditLog}}

The {{ui:admin.auditLog}} page shows the most recent entries in this workspace's audit log, newest first: when each change was made, who made it, what they did and to what kind of record. Owners and Admins use it for a quick look at recent activity.

## Where to find it

Click **{{ui:nav.admin}}**, the gear icon at the bottom of the sidebar. The {{ui:admin.title}} page opens. Under {{ui:admin.section.security}}, click **{{ui:admin.auditLog}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.title}}** › **{{ui:admin.auditLog}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and read the 100 most recent entries | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}** instead of the page.

An Admin whose membership carries a custom role sees the entries only if the custom role is built on Admin or Auditor. Built on Editor or Reader, the page opens and reads **{{ui:admin.noEntries}}**, however many entries exist.

The page only reads. Nobody can change or delete an entry, here or anywhere else in Inflect. The one exception is erasing a person's data at their request, which removes their name from the entries recorded against them and keeps the entries.

## What it is for

Almost every change in the workspace writes an entry to the audit log: invites and role changes, risks, controls, evidence, policies, integrations, API keys, custom roles and more, along with refused attempts to use a permission. Each entry is linked to the one before it, so an entry changed or removed after the fact can be detected. That makes the log the workspace's record of who did what, which auditors ask for.

This page is the in-product view of that record. It shows the latest entries only, which is enough to check a change you or a colleague just made.

## What you see

One table, one row per entry, newest first.

| Column | What it shows |
| --- | --- |
| {{ui:admin.time}} | The date and time of the entry |
| {{ui:admin.user}} | The name of the person the entry is recorded against. A dash means no person, as for many entries written by Inflect's scheduled jobs, or an account with no name |
| {{ui:admin.action}} | What happened, as a code in capitals, such as `CUSTOM_ROLE_CREATED` or `MEMBER_ROLE_CHANGED`. A refused attempt reads `AUTHZ_DENIED` |
| {{ui:admin.entity}} | The kind of record the change was made to, by its internal name, such as `TenantMembership` or `IntegrationConnection` |
| {{ui:admin.details}} | A sentence describing the change, where one was written, followed by `Context:` and a reference for the request. Some entries carry only the reference |

The page has no search, filters, sorting, paging or export, and it does not say when older entries exist. It always shows at most the 100 most recent entries.

## What you can do

Read the entries. Scroll the table to see all of them. On a narrow screen the rows show as cards.

To find who made a recent change, look for its action and the time you expect. A change older than the latest 100 entries is in the log, but this page cannot show it.

## What happens next

- New entries appear when you reload the page. The page does not refresh by itself.
- Entries stay in the log. Deactivating or removing a member does not remove the entries recorded against them.
- If your workspace streams its audit log to an outside security monitoring system, each entry is sent there too. The **{{ui:admin.nav.privacy}}** page shows whether it does.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:admin.noEntries}}** | No entries could be shown. On an active workspace this usually means your custom role cannot read the log, or the log did not load: the page does not tell these apart from an empty log | Reload the page. If it persists, ask an Owner to check your role |

## Related

- [{{ui:admin.members.title}}](members.md), whose every change is recorded here.
- [{{ui:admin.roles.title}}](roles.md), whose changes are recorded here.
- [{{ui:admin.security.title}}](security.md), whose changes are recorded here.
