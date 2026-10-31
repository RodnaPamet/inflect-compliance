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
| Record a request, and move it on | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}**. An Admin whose membership carries a custom role can open the page only if that role can view data subject requests; a role that can view but not manage them sees **{{ui:admin.dsar.readOnlyNotice}}**, and no buttons.

## What it is for

Under the GDPR, a person can ask an organisation for a copy of the personal data it holds about them (Article 15), or for that data to be erased (Article 17), and the organisation must answer within a month. Auditors and regulators ask to see that every such request was recorded and answered.

Requests arrive by email, post or a support ticket. Each one is recorded here and moved through its statuses as somebody does the work. The notice at the top of the page, **{{ui:admin.dsar.manualTitle}}**, says the same: {{ui:admin.dsar.manualBody}}

## What you see

A table of requests, one row each, newest first:

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

The page shows at most 500 requests at a time. When the register holds more, a notice says so; use the search or the filters to reach the rest.

## What you can do

**Search and filter.** Open the filter and type in the search box to find a request by the person's name or email. Filter by **{{ui:admin.dsar.filters.status}}** or by **{{ui:admin.dsar.filters.type}}**.

**Record a request.**

1. Click **{{ui:admin.dsar.record.button}}** in the header. The **{{ui:admin.dsar.record.title}}** dialog opens.
2. Under **{{ui:admin.dsar.record.subject}}**, choose the person. They must be an active member of this workspace.
3. Under **{{ui:admin.dsar.record.type}}**, choose {{ui:admin.dsar.type.EXPORT}} or {{ui:admin.dsar.type.ERASURE}}.
4. Optionally, add **{{ui:admin.dsar.record.notes}}**: how the request arrived, and anything the person handling it should know.
5. Click **{{ui:admin.dsar.record.submit}}**. The request is added to the register as {{ui:admin.dsar.status.RECEIVED}}.

**Open a request.** Click a row. A panel shows the request's right, status and dates (when it was recorded, {{ui:admin.dsar.detail.verified}} and {{ui:admin.dsar.detail.completed}}), who handled it, its notes and, for a rejected request, the reason.

**Move a request on.** In the panel, the buttons offer only the moves its status allows:

| From | You can |
| --- | --- |
| {{ui:admin.dsar.status.RECEIVED}} | **{{ui:admin.dsar.action.VERIFIED}}**, **{{ui:admin.dsar.action.REJECTED}}** or **{{ui:admin.dsar.action.CANCELED}}** |
| {{ui:admin.dsar.status.VERIFIED}} | **{{ui:admin.dsar.action.IN_PROGRESS}}**, **{{ui:admin.dsar.action.REJECTED}}** or **{{ui:admin.dsar.action.CANCELED}}** |
| {{ui:admin.dsar.status.IN_PROGRESS}} | **{{ui:admin.dsar.action.COMPLETED}}** or **{{ui:admin.dsar.action.REJECTED}}** |

{{ui:admin.dsar.status.COMPLETED}}, {{ui:admin.dsar.status.REJECTED}} and {{ui:admin.dsar.status.CANCELED}} are final: the panel offers no move. Notes typed in the panel are saved with the next move, so record there what was done, and how. To reject, first choose a **{{ui:admin.dsar.detail.reasonLabel}}**: {{ui:admin.dsar.rejection.last_owner}}, {{ui:admin.dsar.rejection.outstanding_balance}} or {{ui:admin.dsar.rejection.legal_hold}}.

Marking a request {{ui:admin.dsar.status.COMPLETED}} records that the work was done; Inflect does not export or erase the data itself.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |
| **{{ui:admin.dsar.emptyTitle}}** | No request has been recorded in this workspace | Record one when a request arrives |
| **{{ui:admin.dsar.emptyMatchingTitle}}** | No request matches the search or the filters | Clear the search or the filters |
| **{{ui:admin.dsar.record.failed}}**, or the reason the server gave | The request was not recorded, for example because the person is not an active member | Fix what it names and try again |
| **{{ui:admin.dsar.detail.failed}}**, or the reason the server gave | The request was not moved on | Reload the page and try again |
| **{{ui:admin.dsar.readOnlyNotice}}** | Your custom role can read the register but not manage it | Ask an Owner to change your role if you handle requests |
| A notice that not every request is shown | The register holds more than 500 requests | Search for the request, or filter by status or right |

## Related

- [{{ui:admin.nav.privacy}}](privacy.md), which summarises how the workspace's data is protected and links here.
- [{{ui:admin.auditLog}}](audit-log.md), where each recorded request and status change is logged.
