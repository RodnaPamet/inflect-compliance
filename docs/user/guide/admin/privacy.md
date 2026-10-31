---
route: /t/[tenantSlug]/admin/privacy
---

# {{ui:admin.privacy.title}}

The {{ui:admin.privacy.title}} page summarises how this workspace's data is protected: how it is encrypted, where it is declared to live, how long deleted data is kept, which vendors process it, whether its audit trail is streamed out, and how privacy requests are handled. It reports and changes nothing; each item is set on the page that owns it.

## Where to find it

Click **{{ui:nav.admin}}** at the bottom of the sidebar. Under {{ui:admin.section.privacyData}}, click **{{ui:admin.nav.privacy}}**. The breadcrumb reads **{{ui:admin.crumb.dashboard}}** › **{{ui:admin.title}}** › **{{ui:admin.privacy.title}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin |

Editors, Readers, Auditors and AI admins see **{{ui:admin.forbidden.title}}**.

## What it is for

A data-protection officer, an auditor or a customer's security reviewer asks the same questions about any system that holds personal data. This page answers them for this workspace in one place, from the workspace's own records, so you can quote it or screenshot it.

## What you see

Six cards.

**{{ui:admin.privacy.encryption.title}}.**

| Item | What it shows |
| --- | --- |
| {{ui:admin.privacy.encryption.perTenantDek}} | **{{ui:admin.privacy.encryption.active}}** when the workspace's content is encrypted under a key of its own; **{{ui:admin.privacy.encryption.globalKeyOnly}}** when only the platform's shared key protects it |
| {{ui:admin.privacy.encryption.rotation}} | **{{ui:admin.privacy.encryption.rotationInFlight}}** while the workspace's key is being replaced; **{{ui:admin.privacy.encryption.rotationIdle}}** otherwise |

**{{ui:admin.privacy.residency.title}}.** The {{ui:admin.privacy.residency.region}}, and whether infrastructure exists in that region (**{{ui:admin.privacy.residency.provisioned}}** or **{{ui:admin.privacy.residency.notProvisioned}}**). The region is a commitment recorded when the workspace was created, not a reading of where its data sits; the card's notice says so.

**{{ui:admin.privacy.retention.title}}.**

| Item | What it shows |
| --- | --- |
| {{ui:admin.privacy.retention.softDelete}} | How long a deleted record can still be restored before it is erased for good |
| {{ui:admin.privacy.retention.evidencePurge}} | How long expired, archived evidence is kept before its files are erased |
| {{ui:admin.privacy.retention.evidenceWithRule}} | How many evidence items carry their own retention date |

The first two are platform-wide; the card says so.

**{{ui:admin.privacy.subProcessors.title}}.** How many of the workspace's vendors are marked as sub-processors, and how many sub-processor relationships are recorded. Each relationship is kept on the vendor's own page.

**{{ui:admin.privacy.auditStream.title}}.** **{{ui:admin.privacy.yes}}** when the workspace sends its audit trail to an external system such as a SIEM; **{{ui:admin.privacy.no}}** otherwise.

**{{ui:admin.privacy.dsar.title}}.** Whether the {{ui:admin.privacy.dsar.register}} is available, and whether requests are fulfilled automatically or by hand. Today they are fulfilled by hand, and a notice, **{{ui:admin.privacy.dsar.manualTitle}}**, says what that means. A link, **{{ui:admin.privacy.dsar.openRegister}}**, opens the register.

## What you can do

Read the page, and open the request register from its last card. To change an item, go to the page that owns it:

| Item | Where it is set |
| --- | --- |
| {{ui:admin.privacy.auditStream.title}} | No page sets it up; ask whoever administers your deployment |
| {{ui:admin.privacy.subProcessors.title}} | Each vendor's page under [{{ui:nav.vendors}}](../manage/vendors.md) |
| An evidence item's retention date | The evidence item itself, under [{{ui:nav.evidence}}](../comply/evidence.md) |
| {{ui:admin.privacy.dsar.title}} | [{{ui:admin.dsar.title}}](dsar-requests.md) |

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:admin.forbidden.title}}** | Your role cannot use the admin pages | Ask an Owner or Admin |

## Related

- [{{ui:admin.dsar.title}}](dsar-requests.md), the request register.
- [{{ui:admin.nav.aiFeatures}}](ai-features.md), which decides whether this workspace's data may go to an external model provider.
