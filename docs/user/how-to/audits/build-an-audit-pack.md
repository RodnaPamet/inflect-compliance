# Build an audit pack

An audit pack is the set of controls, policies, evidence and open issues you hand to an auditor for one audit cycle. You build it as a draft, then freeze it. Freezing records how the items look at that moment, so the auditor reviews a fixed record rather than a page that keeps changing.

## Before you start

- The pack belongs to an audit cycle, so set one up first. See [Set up an audit cycle](set-up-an-audit-cycle.md).
- Owners, Admins and Editors can create the default pack.
- Only Owners and Admins can add items to a pack and freeze it.
- Every role can open a pack and look at it.
- The default pack is available for ISO 27001 and NIS2 cycles only. For a cycle on another framework, the page cannot build a pack.
- Get your records in order before you freeze. Freezing is permanent: after it, nobody can add items to the pack.
- The page has no way to remove an item from a pack, even a draft one. Add items with care.

## Steps

1. In the sidebar, under {{ui:nav.comply}}, click **{{ui:nav.audits}}**. The {{ui:audits.title}} page opens.
2. In the {{ui:audits.hub.lifecycleTitle}} section, click **{{ui:audits.hub.cycles}}**.
3. On the cycle's card, click **{{ui:audits.cycles.openCycle}}**.
4. Look at **{{ui:audits.cycleDetail.defaultPackPreview}}**. It counts what the default pack takes in: {{ui:audits.cycleDetail.controls}}, {{ui:audits.cycleDetail.policies}}, {{ui:audits.cycleDetail.evidence}} and {{ui:audits.cycleDetail.issues}}. The table below says what each one is.
5. Click **{{ui:audits.cycleDetail.pack}}**. Inflect creates the pack with every counted item in it, and the pack's page opens. The pack is named after the framework, for example **ISO27001 Default Pack**, and its status is {{ui:audits.packStatus.DRAFT}}.
6. To add something the default pack left out, click **{{ui:audits.packs.addItems}}**, the package icon at the top of the page. In the {{ui:audits.packs.addPicker.title}} dialog:
    - In **{{ui:audits.packs.addPicker.typeLabel}}**, choose {{ui:audits.packs.addPicker.typeControl}}, {{ui:audits.packs.addPicker.typePolicy}} or {{ui:audits.packs.addPicker.typeEvidence}}.
    - In **{{ui:audits.packs.addPicker.itemLabel}}**, choose the item. Controls are listed by their code where they have one.
    - Click **{{ui:audits.packs.addPicker.submit}}**. A message reads {{ui:audits.packs.addPicker.added}}.
7. Repeat step 6 for each item you want to add.
8. When the pack is complete, click **{{ui:audits.packs.freezePack}}**, the padlock icon at the top of the page.
9. In the {{ui:audits.packs.freezeConfirm.title}} dialog, click **{{ui:audits.packs.freezeConfirm.confirm}}**.

What the default pack takes in:

| Group | What it includes |
| --- | --- |
| {{ui:audits.cycleDetail.controls}} | Controls mapped to the cycle's framework whose status is {{ui:controls.statusLabels.IMPLEMENTED}} or {{ui:controls.statusLabels.NEEDS_REVIEW}}. If no control is mapped to the framework, every control with one of those two statuses |
| {{ui:audits.cycleDetail.policies}} | {{ui:audits.packs.itemStatus.PUBLISHED}} policies. For ISO 27001, the ones whose title or category mentions security, information security or access control. For NIS2, the ones that mention incident, business continuity, disaster recovery, access control, supplier or supply chain. If no policy matches, every published policy |
| {{ui:audits.cycleDetail.evidence}} | {{ui:evidence.statusLabels.APPROVED}} evidence linked to those controls, leaving out evidence that has expired or been archived |
| {{ui:audits.cycleDetail.issues}} | Every task in the workspace that is still open, that is, not {{ui:tasks.statusLabels.RESOLVED}}, {{ui:tasks.statusLabels.CLOSED}} or {{ui:tasks.statusLabels.CANCELED}} |

Until the pack is frozen, the items that came from the default pack are listed by an internal reference rather than by name. Freezing fills in their names and details.

## What happens next

- The pack's status changes to {{ui:audits.packStatus.FROZEN}}. Beside **{{ui:audits.packs.frozen}}**, the page shows when it was frozen and by whom.
- Every item now shows the details it had at that moment, such as its status. A control also shows how many of its tasks are done and how many pieces of evidence it has. Changes you make to the records afterwards do not reach the pack.
- An item you added with **{{ui:audits.packs.addItems}}** keeps only its name, without its status or other details.
- The {{ui:audits.packs.addItems}} and {{ui:audits.packs.freezePack}} buttons are gone. **{{ui:audits.packs.generateShareLink}}** and **{{ui:audits.packs.cloneForRetest}}** appear in their place.
- Under **{{ui:audits.packs.exports}}**, anyone who can open the pack can download it with **{{ui:audits.packs.exportJson}}** or **{{ui:audits.packs.exportCsv}}**.
- The pack is listed under **{{ui:audits.cycleDetail.packs}}** on the cycle's page. Click it there to come back to it.
- Creating the pack, adding items and freezing it are recorded in the workspace's audit log.
- Next, send the pack to your auditor. See [Share an audit pack](share-an-audit-pack.md).

## Make a new version of a frozen pack

A frozen pack cannot change. For a retest, or when the auditor needs a newer version, make a copy.

1. Open the frozen pack.
2. Click **{{ui:audits.packs.cloneForRetest}}**, the circular arrows icon at the top of the page. Owners and Admins see it.

Inflect creates a new {{ui:audits.packStatus.DRAFT}} pack in the same cycle, named **Retest:** followed by the old pack's name, and opens it. The copy has the same controls, policies, evidence and issues. It also takes in up to 50 tasks that are {{ui:tasks.statusLabels.IN_PROGRESS}}. Add what you need, then freeze it as in steps 6 to 9.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:audits.cycleDetail.pack}}** is greyed out, and the preview reads {{ui:audits.cycleDetail.previewError}} | The cycle's framework has no default pack, or the preview could not load. Only ISO 27001 and NIS2 cycles have one | Reload the page. For a cycle on another framework, the page cannot build a pack |
| {{ui:audits.cycleDetail.createPackError}} | No pack was created. Your role may not create packs | Ask an Owner, Admin or Editor |
| {{ui:audits.cycleDetail.addItemsError}} | The pack was created, but none of its items were added | Open the pack and add the items you need with **{{ui:audits.packs.addItems}}** |
| {{ui:audits.packs.itemsEmptyTitle}} | The pack is empty | Click **{{ui:audits.packs.addItems}}** |
| No **{{ui:audits.packs.addItems}}** or **{{ui:audits.packs.freezePack}}** button | The pack is already frozen, or your role cannot change packs | Only Owners and Admins can change a pack. To change a frozen one, use **{{ui:audits.packs.cloneForRetest}}** |
| **{{ui:audits.packs.addPicker.itemLabel}}** is greyed out in the {{ui:audits.packs.addPicker.title}} dialog | There is nothing of that type to add | Choose another **{{ui:audits.packs.addPicker.typeLabel}}** |
| {{ui:audits.packs.addPicker.added}}, but the item list does not change | The item was already in the pack | Nothing to do. A pack holds each item once |
| {{ui:audits.packs.addPicker.addError}} | The item was not added | Try again. If the pack was frozen meanwhile, reload the page |
| {{ui:audits.packs.failedFreeze}} | The pack was not frozen. Usually it has no items | Add at least one item, then freeze it again |
| {{ui:audits.packs.cloneError}} | No copy was made | Try again |
| {{ui:audits.packs.loadError}} | The pack could not be loaded | Click **{{ui:audits.packs.retry}}** |
