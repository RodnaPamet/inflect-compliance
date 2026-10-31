---
route: /t/[tenantSlug]/audits/packs/[packId]
---

# An audit pack

An audit pack is the evidence you hand to an auditor for one audit cycle: the controls, policies and evidence they will look at. On the pack's page you build it, freeze it, share it with the auditor through a link, and answer what the auditor sends back.

## Where to find it

Open **{{ui:nav.audits}}** under **{{ui:nav.comply}}**, click **{{ui:audits.hub.cycles}}**, open a cycle and click one of its packs. The breadcrumb reads **{{ui:audits.crumb.dashboard}}** › **{{ui:audits.crumb.audits}}** › **{{ui:audits.crumb.cycles}}** › the pack's name. Arrows beside the title step to the previous or next pack.

## Who can use it

| Action | Roles |
| --- | --- |
| View the pack, its items and the auditor's activity | Everyone who can see audits |
| Add and remove items while the pack is a draft | Owner, Admin, Editor |
| Freeze the pack | Owner, Admin |
| Clone a frozen pack for a retest | Owner, Admin, Editor |
| Export a frozen pack as JSON or CSV | Everyone who can see audits |
| See, generate and revoke share links | Owner, Admin |
| Resolve the auditor's requests, or turn them into findings | Owner, Admin |
| Export to SharePoint | Owner, Admin, once a SharePoint account is connected |

Generating a share link needs the Pro or Enterprise plan. On a Free or Trial workspace the button offers an upgrade instead.

## What it is for

Give the auditor one fixed set of records to work from. Once frozen, a pack keeps each item as it was at that moment, so what the auditor sees does not change while they work, and you can show later exactly what you handed over.

## What you see

**The header.** The pack's name, its **{{ui:audits.packs.framework}}**, how many **{{ui:audits.packs.items}}** it holds, its **{{ui:audits.packs.status}}**: **{{ui:audits.packStatus.DRAFT}}**, **{{ui:audits.packStatus.FROZEN}}** or **{{ui:audits.packStatus.EXPORTED}}**, and once frozen, when and by whom under **{{ui:audits.packs.frozen}}**. The framework is shown by its short code, not its full name.

**{{ui:audits.packs.sharesTitle}}.** On a frozen pack, the links you have given auditors, each **{{ui:audits.packs.shareStateActive}}**, **{{ui:audits.packs.shareStateExpired}}** or **{{ui:audits.packs.shareStateRevoked}}**, with the date it was created and when it expires. {{ui:audits.packs.sharesOnceNote}}

**The items.** The pack's records, grouped into **{{ui:audits.packs.entityType.CONTROL}}**, **{{ui:audits.packs.entityType.POLICY}}**, **{{ui:audits.packs.entityType.EVIDENCE}}** and the other kinds. Each shows its name, its status, and for a control how many of its tasks are done and how much evidence it has.

**{{ui:audits.packs.auditorActivity.title}}.** {{ui:audits.packs.auditorActivity.desc}} Each entry is a **{{ui:audits.packs.auditorActivity.kind.COMMENT}}**, **{{ui:audits.packs.auditorActivity.kind.QUESTION}}**, **{{ui:audits.packs.auditorActivity.kind.EVIDENCE_REQUEST}}** or **{{ui:audits.packs.auditorActivity.kind.FINDING}}**, with who sent it, when, and the item it is about. Everything but a comment is **{{ui:audits.packs.auditorActivity.statusOPEN}}** until someone resolves it.

**{{ui:audits.packs.exports}}.** On a frozen pack, **{{ui:audits.packs.exportJson}}** and **{{ui:audits.packs.exportCsv}}**.

## What you can do

### Add items

While the pack is a draft, click **{{ui:audits.packs.addItems}}**, choose the **{{ui:audits.packs.addPicker.typeLabel}}**: **{{ui:audits.packs.addPicker.typeControl}}**, **{{ui:audits.packs.addPicker.typePolicy}}** or **{{ui:audits.packs.addPicker.typeEvidence}}**, pick the **{{ui:audits.packs.addPicker.itemLabel}}** and click **{{ui:audits.packs.addPicker.submit}}**. The cross beside an item removes it, with a few seconds to click **{{ui:audits.packs.removeItem.undo}}**.

See [Build an audit pack](../../how-to/audits/build-an-audit-pack.md).

### Freeze the pack

Click **{{ui:audits.packs.freezePack}}** and confirm. {{ui:audits.packs.freezeConfirm.desc}}

### Share it with the auditor

1. On a frozen pack, click **{{ui:audits.packs.generateShareLink}}**.
2. Choose how long the link lasts, or **{{ui:audits.packs.shareModal.noExpiry}}**, and click **{{ui:audits.packs.shareModal.submit}}**.
3. Copy the link from **{{ui:audits.packs.shareLinkGenerated}}** and send it to the auditor. {{ui:audits.packs.shareLinkOnceWarning}}

The auditor opens the pack without an account. To end their access, click **{{ui:audits.packs.revokeShare}}** beside the link and confirm: {{ui:audits.packs.revokeShareModal.desc}}

See [Share an audit pack](../../how-to/audits/share-an-audit-pack.md).

### Answer the auditor

Click **{{ui:audits.packs.auditorActivity.resolve}}** on an entry once you have dealt with it. On a finding, **{{ui:audits.packs.auditorActivity.createFinding}}** records it as a nonconformity in the workspace's findings. On an evidence request, **{{ui:audits.packs.auditorActivity.createObservation}}** records it as an observation. Either way a follow-up task is created and the entry is resolved.

### Retest from a frozen pack

Click **{{ui:audits.packs.cloneForRetest}}**. A new draft pack opens, named "Retest:" and the original name, with the same controls, policies and evidence and any task still in progress. Change it and freeze it again; its items are captured afresh when it is frozen.

### Export it

**{{ui:audits.packs.exportJson}}** and **{{ui:audits.packs.exportCsv}}** download the frozen pack. **{{ui:audits.sharepoint.exportBtn}}** puts it, with its evidence files, in a SharePoint folder you choose. Files that failed the malware scan, are still waiting for it, or are too large are left out, and the message says how many.

## What happens next

- A frozen pack cannot be unfrozen. To change it, clone it.
- A finding created from the auditor's activity is attached to the cycle's fieldwork audit, when the cycle has one: {{ui:audits.packs.auditorActivity.findingCreatedNoAudit}}
- A share link stops working when it expires or is revoked. The auditor's comments stay on the pack.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:audits.packs.notFound}}** | The pack does not exist or is in another workspace | Go back to the cycle |
| **{{ui:audits.packs.loadError}}** | The pack could not load | Click **{{ui:audits.packs.retry}}** |
| **{{ui:audits.packs.itemsEmptyTitle}}** | Nothing has been added yet | Click **{{ui:audits.packs.addItems}}**, or ask an Owner, Admin or Editor |
| **{{ui:audits.packs.sharesEmpty}}** | No link has been generated for this pack | Generate one |
| **{{ui:audits.packs.sharesRestricted}}** | Your role cannot see the share links | Ask an Owner or Admin |
| **{{ui:audits.packs.sharesLoadError}}** | The share links could not load | Click **{{ui:audits.packs.retry}}** |
| **{{ui:audits.packs.auditorActivity.empty}}** | {{ui:audits.packs.auditorActivity.emptyDesc}} | Nothing to do |
| **{{ui:audits.packs.failedFreeze}}**, **{{ui:audits.packs.shareError}}**, **{{ui:audits.packs.addPicker.addError}}**, or a reason the server gave | The change was not made. A reason from the server is in English, whatever language you use the app in | Follow the reason given, then try again |

## Related

- [{{ui:audits.cycles.title}}](audit-cycles.md), every audit cycle.
- [A shared audit pack](shared-audit-pack.md), what the auditor sees.
- [Build an audit pack](../../how-to/audits/build-an-audit-pack.md).
- [Share an audit pack](../../how-to/audits/share-an-audit-pack.md).
