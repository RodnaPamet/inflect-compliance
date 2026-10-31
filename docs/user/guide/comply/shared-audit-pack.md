---
route: /audit/shared/[token]
---

# {{ui:external.auditShare.sharedAuditPack}}

A {{ui:external.auditShare.sharedAuditPack}} is the read-only page an external auditor opens from a share link. It shows a frozen audit pack, exactly as it was when it was frozen, without the auditor needing an Inflect account. The auditor can also send the workspace comments, evidence requests, findings and questions from it.

## Where to find it

The workspace's Owners and Admins create the link on the pack's page and send it to the auditor; see [Share an audit pack](../../how-to/audits/share-an-audit-pack.md). The auditor opens it in any browser.

## Who can use it

| Action | Who |
| --- | --- |
| Open the pack and send messages | Anyone holding the link, until it expires or is revoked |
| Create, revoke and see share links, and answer the messages | Owners and Admins of the workspace |

Anyone who has the link can open the pack. Send it only to the auditor, and give it an expiry.

## What it is for

It gives your external auditor the evidence they asked for, in one place, without giving them access to the workspace. Their questions and requests come back to the pack instead of to email.

## What you see

**The header.** **{{ui:external.auditShare.sharedAuditPack}}**, then the pack's name, its audit cycle, its framework, its status, and when it was frozen.

**The items.** Everything in the pack, grouped by type: {{ui:external.auditShare.entityType.CONTROL}}, {{ui:external.auditShare.entityType.POLICY}}, {{ui:external.auditShare.entityType.EVIDENCE}}, {{ui:external.auditShare.entityType.FILE}}, {{ui:external.auditShare.entityType.ISSUE}}, {{ui:external.auditShare.entityType.READINESS_REPORT}} and {{ui:external.auditShare.entityType.FRAMEWORK_COVERAGE}}, and the Statement of Applicability when the pack holds one. Each item shows its name and status as they were at freezing, and, depending on its type, its task progress, how much evidence it had, the requirements it maps to, or its severity. A pack that includes the auditor agent's work also shows how internal audit reviewed it. Nothing here changes after the pack was frozen, even if the records in the workspace do.

**{{ui:external.auditShare.returnChannel.title}}.** A form for the auditor's messages, then **{{ui:external.auditShare.returnChannel.submittedTitle}}**, the messages sent from this browser in this visit.

At the bottom: {{ui:external.auditShare.footer}}

## What you can do

### Send the team a message

In **{{ui:external.auditShare.returnChannel.title}}**:

1. Choose the **{{ui:external.auditShare.returnChannel.kindLabel}}**: {{ui:external.auditShare.returnChannel.kind.COMMENT}}, {{ui:external.auditShare.returnChannel.kind.EVIDENCE_REQUEST}}, {{ui:external.auditShare.returnChannel.kind.FINDING}} or {{ui:external.auditShare.returnChannel.kind.QUESTION}}.
2. Optionally, enter **{{ui:external.auditShare.returnChannel.nameLabel}}**, so the team knows who wrote.
3. Under **{{ui:external.auditShare.returnChannel.attachLabel}}**, choose the item the message is about, or **{{ui:external.auditShare.returnChannel.attachWholePack}}**.
4. Write the **{{ui:external.auditShare.returnChannel.messageLabel}}** and click **{{ui:external.auditShare.returnChannel.submit}}**.

The message joins **{{ui:external.auditShare.returnChannel.submittedTitle}}** on your page and appears on the pack's page for the team.

## What happens next

- The team sees each message on the pack's page and answers it there. A raised finding, once accepted, becomes a finding in the workspace with a remediation task. See [Share an audit pack](../../how-to/audits/share-an-audit-pack.md).
- Each message is recorded in the workspace's audit log.
- When the link expires or is revoked, it stops opening the pack.

## Empty and error states

| What the auditor sees | What it means | What to do |
| --- | --- | --- |
| **{{ui:external.auditShare.accessDenied}}**, with **{{ui:external.auditShare.invalidOrExpired}}** or a reason | The link is wrong, has expired or was revoked | Ask the team for a new link |
| **{{ui:external.auditShare.returnChannel.submittedEmpty}}** | No message has been sent from this browser in this visit | Nothing; it fills as you send messages |
| The reason the message was refused, such as an expired link or too many messages in a short time | The message was not sent | Follow the reason given; for an expired link, ask for a new one |
| **{{ui:external.auditShare.returnChannel.submitError}}** | The message was not sent, and the server gave no reason | Try again |

## Related

- [Share an audit pack](../../how-to/audits/share-an-audit-pack.md), for the team: creating, revoking and answering.
- [Build an audit pack](../../how-to/audits/build-an-audit-pack.md), on what goes into a pack.
- [{{ui:audits.title}}](audits.md), where packs belong to audit cycles.
