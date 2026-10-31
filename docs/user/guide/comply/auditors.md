---
route: /t/[tenantSlug]/audits/auditors
---

# {{ui:audits.auditorsAdmin.title}}

The {{ui:audits.auditorsAdmin.title}} page keeps a record of the external auditors who review your workspace, and of the audit packs each is meant to see. {{ui:audits.auditorsAdmin.subtitle}}

## Where to find it

Open **{{ui:nav.audits}}** under **{{ui:nav.comply}}** and click **{{ui:audits.hub.auditorManagement}}** under **{{ui:audits.hub.lifecycleTitle}}**. The breadcrumb reads **{{ui:audits.crumb.dashboard}}** › **{{ui:audits.crumb.audits}}** › **{{ui:audits.auditorsAdmin.crumb}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| See the list, and add an auditor to it | Owner, Admin |
| Record or remove a pack against an auditor, and revoke an auditor | Owner, Admin, with a role that can administer the workspace |

Every other role sees **{{ui:audits.auditorsAdmin.restrictedTitle}}**: {{ui:audits.auditorsAdmin.restrictedDesc}}

## What it is for

Know who your auditors are and which packs you meant each to see, in one place. The page is a record only:

- adding an auditor sends them nothing, and gives them no account;
- recording a pack against an auditor gives them no way to open it.

An auditor reads a pack through a share link, which you generate on the pack's page and send them yourself. See [Share an audit pack](../../how-to/audits/share-an-audit-pack.md).

## What you see

One card per auditor, newest first, with:

- their name, or their email if no name was given, and their email;
- their status: **{{ui:audits.auditorsAdmin.statusLISTED}}** or **{{ui:audits.auditorsAdmin.statusREVOKED}}**, and the date they were added;
- **{{ui:audits.auditorsAdmin.accessSection}}**: the packs recorded against them;
- a list to record another frozen pack, and **{{ui:audits.auditorsAdmin.grant}}**.

**{{ui:audits.auditorsAdmin.inviteAuditor}}** is at the top right.

## What you can do

### Add an auditor

1. Click **{{ui:audits.auditorsAdmin.inviteAuditor}}**.
2. Give their **{{ui:audits.auditorsAdmin.emailLabel}}**, and optionally a **{{ui:audits.auditorsAdmin.nameLabel}}**.
3. Click **{{ui:audits.auditorsAdmin.inviteSubmit}}**.

{{ui:audits.auditorsAdmin.inviteDesc}}

Adding an email that is already on the list changes nothing, and the page says so: {{ui:audits.auditorsAdmin.alreadyListed}} Adding a revoked auditor's email puts them back on the list.

### Record a pack against an auditor

Choose a pack from the list on their card and click **{{ui:audits.auditorsAdmin.grant}}**. Only frozen and exported packs are listed: a draft cannot be shared, so it cannot be recorded either. Each pack shows its status in the list. The cross beside a recorded pack removes it, with a few seconds to click **{{ui:audits.auditorsAdmin.undo}}**.

### Revoke an auditor

1. Click **{{ui:audits.auditorsAdmin.revokeAccount}}** on their card.
2. Type their email to confirm, and click **{{ui:audits.auditorsAdmin.revokeAccountConfirm}}**.

The auditor is marked revoked and every pack recorded against them is removed. Share links are not affected: revoke those on each pack's page. Adding them again reactivates them.

## What happens next

- Nothing reaches the auditor from this page. To end an auditor's access to a pack, revoke its share link on the pack's page.
- A revoked auditor's card says {{ui:audits.auditorsAdmin.grantRevokedNote}}

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:audits.auditorsAdmin.emptyTitle}}** | No auditor has been added | {{ui:audits.auditorsAdmin.emptyDesc}} |
| **{{ui:audits.auditorsAdmin.loadErrorTitle}}** | The list could not load | Click **{{ui:audits.auditorsAdmin.retry}}** |
| **{{ui:audits.auditorsAdmin.allGranted}}** | Every frozen pack is already recorded against this auditor | Nothing to do |
| **{{ui:audits.auditorsAdmin.freezeToRecord}}** | The workspace has no frozen pack | Freeze a pack on its page |
| **{{ui:audits.auditorsAdmin.inviteError}}**, **{{ui:audits.auditorsAdmin.grantError}}**, **{{ui:audits.auditorsAdmin.revokeError}}** or **{{ui:audits.auditorsAdmin.revokeAccountError}}** | The change was not saved | Try again |
| **{{ui:audits.auditorsAdmin.refused.AUDITOR_PACK_ALREADY_RECORDED}}** | Someone else recorded the pack first | Nothing to do |
| **{{ui:audits.auditorsAdmin.refused.AUDITOR_ALREADY_REVOKED}}** | Someone else revoked the auditor first | Nothing to do |
| **{{ui:audits.auditorsAdmin.emailInvalid}}** | The email was refused | Correct it and add the auditor again |

## Related

- [An audit pack](audit-pack-detail.md), where share links are made.
- [A shared audit pack](shared-audit-pack.md), what the auditor sees.
- [Share an audit pack](../../how-to/audits/share-an-audit-pack.md).
