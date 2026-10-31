# Share an audit pack

To give an external auditor your audit pack, send them a share link. The auditor opens it in a browser without signing in to Inflect, reads the frozen pack, and can send you comments, evidence requests, findings and questions. You choose how long the link works, and you can revoke it at any time.

## Before you start

- You need the Owner or Admin role. The share buttons, the list of links and the actions on an auditor's messages appear for those roles only.
- The pack must be frozen. A draft pack cannot be shared. See [Build an audit pack](build-an-audit-pack.md).
- If your workspace has a billing plan, it must include audit pack sharing. If it does not, **{{ui:audits.packs.generateShareLink}}** is greyed out, with a padlock and the name of the plan you need beside it. Clicking the plan name opens the billing page.
- Anyone who has the link can open the pack, without signing in. Send it only to the auditor, and give it an expiry.
- Have a way to send the link, such as email. You can copy the link only once, right after you create it.

## Steps

1. In the sidebar, under {{ui:nav.comply}}, click **{{ui:nav.audits}}**. Then click **{{ui:audits.hub.cycles}}** in the {{ui:audits.hub.lifecycleTitle}} section.
2. On the cycle's card, click **{{ui:audits.cycles.openCycle}}**. Under **{{ui:audits.cycleDetail.packs}}**, click the pack. Its status must read {{ui:audits.packStatus.FROZEN}}.
3. Click **{{ui:audits.packs.generateShareLink}}**, the share icon at the top of the page. The {{ui:audits.packs.shareModal.title}} dialog opens.
4. Choose when the link stops working. It starts at 30 days from today.
    - Click **7 days**, **30 days** or **90 days**, or pick a date in **{{ui:audits.packs.shareModal.expiryLabel}}**.
    - Click **{{ui:audits.packs.shareModal.noExpiry}}** only if the link must keep working until you revoke it.
5. Click **{{ui:audits.packs.shareModal.submit}}**. A message reads {{ui:audits.packs.shareCreated}}.
6. The **{{ui:audits.packs.shareLinkGenerated}}** box shows the link. Click **{{ui:audits.packs.copyShareLink}}**. A message reads {{ui:audits.packs.shareLinkCopied}}.
7. Send the link to the auditor. Do it before you leave or reload the page: the link is never shown again.

## What happens next

- The link appears under **{{ui:audits.packs.sharesTitle}}** on the pack's page, marked {{ui:audits.packs.shareStateActive}}, with the date it was created and when it expires. When the expiry passes, it is marked {{ui:audits.packs.shareStateExpired}}. Only Owners and Admins see the links in this list. Anyone else reads {{ui:audits.packs.sharesRestricted}} in its place.
- You can create several links for one pack, for example one per auditor. Each can be revoked on its own.
- The auditor's page reads **{{ui:external.auditShare.sharedAuditPack}}** above the pack's name, with its cycle, its framework and when it was frozen. Below that are the items, grouped by type, as they were when the pack was frozen. The auditor cannot change anything in the pack.
- At the bottom, under **{{ui:external.auditShare.returnChannel.title}}**, the auditor can send you a message. They choose a **{{ui:external.auditShare.returnChannel.kindLabel}}**: {{ui:external.auditShare.returnChannel.kind.COMMENT}}, {{ui:external.auditShare.returnChannel.kind.EVIDENCE_REQUEST}}, {{ui:external.auditShare.returnChannel.kind.FINDING}} or {{ui:external.auditShare.returnChannel.kind.QUESTION}}. They can say which item the message is **{{ui:external.auditShare.returnChannel.attachLabel}}**, and give their name or email address.
- Messages arrive on the pack's page, under **{{ui:audits.packs.auditorActivity.title}}**, with a count of the open ones. Inflect does not notify you when one arrives, so check the pack while the audit runs.
- Sharing and revoking a link are recorded in the workspace's audit log, and so is each message an auditor sends.

## Answer the auditor

Under **{{ui:audits.packs.auditorActivity.title}}**, a {{ui:audits.packs.auditorActivity.kind.COMMENT}} is for reading only. The other three types start as {{ui:audits.packs.auditorActivity.statusOPEN}}. Owners and Admins can act on them, and only they see these buttons:

- **{{ui:audits.packs.auditorActivity.createFinding}}**, on a {{ui:audits.packs.auditorActivity.kind.FINDING}}, records a {{ui:findings.typeOptions.NONCONFORMITY}} finding with a task to fix it.
- **{{ui:audits.packs.auditorActivity.createObservation}}**, on an {{ui:audits.packs.auditorActivity.kind.EVIDENCE_REQUEST}}, records an {{ui:findings.typeOptions.OBSERVATION}} finding with a follow-up task.
- **{{ui:audits.packs.auditorActivity.resolve}}** marks the entry {{ui:audits.packs.auditorActivity.statusRESOLVED}} without creating anything. It is the only action on a {{ui:audits.packs.auditorActivity.kind.QUESTION}}. Answer the question outside Inflect, then resolve it.

A finding created this way has medium severity and takes its title from the auditor's message. It is attached to the cycle's earliest fieldwork audit, if the cycle has one. A finding attached to no fieldwork audit does not count toward the cycle's readiness score, so add a fieldwork audit to the cycle first. See [Set up an audit cycle](set-up-an-audit-cycle.md). The message after you create the finding says which happened:

- {{ui:audits.packs.auditorActivity.findingCreated}}
- {{ui:audits.packs.auditorActivity.findingCreatedNoAudit}}

If the auditor wrote about a control, the finding and its task are linked to that control too. The entry is then marked {{ui:audits.packs.auditorActivity.statusRESOLVED}}. Find the finding under **{{ui:audits.findingsTab}}**, from the {{ui:audits.title}} page, and its task under **{{ui:nav.tasks}}**.

## Revoke a link

1. On the pack's page, under **{{ui:audits.packs.sharesTitle}}**, find the link. Use its creation date to tell links apart.
2. Click **{{ui:audits.packs.revokeShare}}**.
3. In the {{ui:audits.packs.revokeShareModal.title}} dialog, click **{{ui:audits.packs.revokeShareModal.confirm}}**.

The link stops working at once, and revoking cannot be undone. The link stays in the list, marked {{ui:audits.packs.shareStateRevoked}}. To give the auditor access again, create a new link.

## About {{ui:audits.hub.auditorManagement}}

The {{ui:audits.hub.lifecycleTitle}} section of the {{ui:audits.title}} page also links to **{{ui:audits.hub.auditorManagement}}**. That page keeps a list of named external auditors and the packs each one is meant to see. Adding an auditor there sends them no invitation and gives them no way into Inflect, and neither does recording a pack against them there. To let an auditor read a pack, send them a share link.

Only Owners and Admins can see the list. Anyone else reads **{{ui:audits.auditorsAdmin.restrictedTitle}}** on that page. **{{ui:audits.auditorsAdmin.revokeAccount}}** marks the auditor revoked and removes the packs recorded for them on that page. It does not revoke a share link you sent them: revoke that on the pack's page.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| No **{{ui:audits.packs.generateShareLink}}** button | The pack is still a draft, or your role is not Owner or Admin | Freeze the pack first. If it is frozen, ask an Owner or Admin |
| **{{ui:audits.packs.generateShareLink}}** is greyed out, with a padlock and a plan name | Your workspace's plan does not include audit pack sharing | Click the plan name to see the billing options, or ask an Owner |
| {{ui:audits.packs.shareError}}, or the reason the server gave | The link was not created | Try again. If the message says the pack is a draft, freeze it first |
| You lost the link, or closed the page before copying it | A link is shown only once and cannot be shown again | Revoke that link, then create a new one |
| The auditor sees **{{ui:external.auditShare.accessDenied}}** and a reason, such as **Share link has expired** or **Invalid or expired share link** | The link has expired, was revoked, or was copied incompletely | Check the link's state under **{{ui:audits.packs.sharesTitle}}**. Send a new link if you need to |
| The auditor sees **{{ui:external.auditShare.returnChannel.submitError}}** | Their message did not reach you. The link may have expired or been revoked | Ask them to try again, or send a new link |
| **{{ui:audits.packs.sharesTitle}}** reads {{ui:audits.packs.sharesRestricted}} | Your role cannot see the list of links | Ask an Owner or Admin |
| **{{ui:audits.packs.sharesTitle}}** reads {{ui:audits.packs.sharesLoadError}} | The list of links could not be loaded | Click **{{ui:audits.packs.retry}}** beside the message |
| {{ui:audits.packs.shareRevokeError}} | The link was not revoked | Reload the page and try again. A link that was already revoked shows {{ui:audits.packs.shareStateRevoked}} |
| {{ui:audits.packs.auditorActivity.materializeError}}, or the reason the server gave | Creating the finding failed | Reload the page and look under **{{ui:audits.findingsTab}}** before you try again |
| {{ui:audits.packs.auditorActivity.resolveError}}, or the reason the server gave | The entry was not resolved | Reload the page. If the entry is still open, try again |
| No **{{ui:audits.packs.auditorActivity.resolve}}** or **{{ui:audits.packs.auditorActivity.createFinding}}** button on an open entry | Your role cannot act on an auditor's message | Ask an Owner or Admin |
