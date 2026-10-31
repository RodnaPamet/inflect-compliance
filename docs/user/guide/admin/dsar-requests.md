---
route: /t/[tenantSlug]/admin/dsar-requests
---

# {{ui:admin.dsar.title}}

The {{ui:admin.dsar.title}} page is the workspace's register of privacy requests: people asking for a copy of their data, or for it to be erased. It records each request and where it stands. It does not export or erase anything itself.

## Where to find it

Click **{{ui:nav.admin}}** at the bottom of the sidebar. Under {{ui:admin.section.privacyData}}, click **{{ui:admin.nav.dsarRequests}}**. You can also reach it from the link at the foot of the {{ui:admin.privacy.dsar.title}} card on [{{ui:admin.nav.privacy}}](privacy.md). The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.title}}** › **{{ui:admin.dsar.title}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page and read the register | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}**. An Admin whose membership carries a custom role can open the page only if that role can view data subject requests; a role that can view but not manage them sees **{{ui:admin.dsar.readOnlyNotice}}**.

## What it is for

Under the GDPR, a person can ask an organisation for a copy of the personal data it holds about them (Article 15), or for that data to be erased (Article 17), and the organisation must answer within a month. Auditors and regulators ask to see that every such request was recorded and answered.

Requests arrive by email, post or a support ticket. Each one is recorded here and moved through its statuses as somebody does the work. The notice at the top of the page, **{{ui:admin.dsar.manualTitle}}**, says the same: {{ui:admin.dsar.manualBody}}

## What you see

A table of requests, one row each, newest first, up to 500:

| Column | What it shows |
| --- | --- |
| {{ui:admin.dsar.col.subject}} | The person the request is about: their name, or their email when they have no name |
| {{ui:admin.dsar.col.type}} | {{ui:admin.dsar.type.EXPORT}} or {{ui:admin.dsar.type.ERASURE}} |
| {{ui:admin.dsar.col.status}} | Where the request stands |
| {{ui:admin.dsar.col.requested}} | When it was recorded |
| {{ui:admin.dsar.col.handledBy}} | Who last moved it on, or — |

A request moves through these statuses:

| Status | Meaning |
| --- | --- |
| {{ui:admin.dsar.status.RECEIVED}} | Recorded; nobody has acted on it |
| {{ui:admin.dsar.status.VERIFIED}} | The requester's identity has been checked |
| {{ui:admin.dsar.status.IN_PROGRESS}} | Somebody is carrying out the request |
| {{ui:admin.dsar.status.COMPLETED}} | The work was done, outside Inflect, and recorded |
| {{ui:admin.dsar.status.REJECTED}} | The request was refused, with a reason |
| {{ui:admin.dsar.status.CANCELED}} | The requester withdrew it |

## What you can do

Read the register. The page has no buttons to record a request or change its status.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:admin.dsar.emptyTitle}}** | No request has been recorded in this workspace | Nothing, until a request arrives |
| **{{ui:admin.dsar.readOnlyNotice}}** | Your custom role can read the register but not manage it | Ask an Owner to change your role if you handle requests |

## Related

- [{{ui:admin.nav.privacy}}](privacy.md), which summarises how the workspace's data is protected and links here.
- [{{ui:admin.auditLog}}](audit-log.md), where each recorded request and status change is logged.
