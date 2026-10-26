# Build an audit pack

An audit pack is the set of controls, policies, evidence and open issues you hand to an auditor for one audit cycle. You build it as a draft, then freeze it. Freezing records how the items look at that moment, so the auditor reviews a fixed record rather than a page that keeps changing.

## Before you start

- The pack belongs to an audit cycle, so set one up first. See [Set up an audit cycle](set-up-an-audit-cycle.md).
- Owners, Admins and Editors can create the default pack, and add items to a draft pack or remove them. The {{ui:audits.cycleDetail.pack}} and {{ui:audits.packs.addItems}} buttons appear for those roles only.
- Only Owners and Admins can freeze a pack.
- Every role can open a pack and look at it.
- The default pack is available for a cycle on any framework.
- Get your records in order before you freeze. Freezing is permanent: after it, nobody can add items to the pack or remove them.

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
8. To take an item out of the draft, click the cross at the end of its row. The item leaves the list at once, and a message reads {{ui:audits.packs.removeItem.removed}}. Click **{{ui:audits.packs.removeItem.undo}}** in the message within five seconds to keep the item. After that, it is removed from the pack.
9. When the pack is complete, click **{{ui:audits.packs.freezePack}}**, the padlock icon at the top of the page.
10. In the {{ui:audits.packs.freezeConfirm.title}} dialog, click **{{ui:audits.packs.freezeConfirm.confirm}}**.

What the default pack takes in:

| Group | What it includes |
| --- | --- |
| {{ui:audits.cycleDetail.controls}} | Controls mapped to the cycle's framework whose status is {{ui:controls.statusLabels.IMPLEMENTED}} or {{ui:controls.statusLabels.NEEDS_REVIEW}}. If no control is mapped to the framework, every control with one of those two statuses |
| {{ui:audits.cycleDetail.policies}} | {{ui:audits.packs.itemStatus.PUBLISHED}} policies. For ISO 27001, the ones whose title or category mentions security, information security or access control. For NIS2, the ones that mention incident, business continuity, disaster recovery, access control, supplier or supply chain. If no policy matches, every published policy. For any other framework, every published policy |
| {{ui:audits.cycleDetail.evidence}} | {{ui:evidence.statusLabels.APPROVED}} evidence linked to those controls, leaving out evidence that has expired or been archived |
| {{ui:audits.cycleDetail.issues}} | Every task in the workspace that is still open, that is, not {{ui:tasks.statusLabels.RESOLVED}}, {{ui:tasks.statusLabels.CLOSED}} or {{ui:tasks.statusLabels.CANCELED}} |

Until the pack is frozen, each item is listed by its current name: a control by its code where it has one, a policy, a piece of evidence or a task by its title. Freezing records each item's name and details as they are at that moment.

## What happens next

- The pack's status changes to {{ui:audits.packStatus.FROZEN}}. Beside **{{ui:audits.packs.frozen}}**, the page shows when it was frozen and by whom.
- Every item, including the ones you added with **{{ui:audits.packs.addItems}}**, now shows the details it had at that moment, such as its status. A control also shows how many of its tasks are done and how many pieces of evidence it has. Changes you make to the records afterwards do not reach the pack.
- If the cycle's framework has a Statement of Applicability, such as ISO 27001, freezing adds it to the pack under **{{ui:audits.packs.entityType.FRAMEWORK_COVERAGE}}**. It records, for each requirement of the framework, whether it applies, how far it is implemented and which controls cover it.
- The {{ui:audits.packs.addItems}} and {{ui:audits.packs.freezePack}} buttons are gone, and so are the crosses that remove items. **{{ui:audits.packs.generateShareLink}}** appears for Owners and Admins, and **{{ui:audits.packs.cloneForRetest}}** for Owners, Admins and Editors.
- Under **{{ui:audits.packs.exports}}**, anyone who can open the pack can download it with **{{ui:audits.packs.exportJson}}** or **{{ui:audits.packs.exportCsv}}**.
- The pack is listed under **{{ui:audits.cycleDetail.packs}}** on the cycle's page. Click it there to come back to it.
- Creating the pack, adding and removing items, and freezing it are recorded in the workspace's audit log.
- Next, send the pack to your auditor. See [Share an audit pack](share-an-audit-pack.md).

## Make a new version of a frozen pack

A frozen pack cannot change. For a retest, or when the auditor needs a newer version, make a copy.

1. Open the frozen pack.
2. Click **{{ui:audits.packs.cloneForRetest}}**, the circular arrows icon at the top of the page. Owners, Admins and Editors see it.

Inflect creates a new {{ui:audits.packStatus.DRAFT}} pack in the same cycle, named **Retest:** followed by the old pack's name, and opens it. The copy has the same controls, policies, evidence and issues. It also takes in up to 50 tasks that are {{ui:tasks.statusLabels.IN_PROGRESS}}. Add or remove what you need, then freeze it as in steps 6 to 10.

## If something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| No **{{ui:audits.cycleDetail.pack}}** button on the cycle's page | Your role cannot create packs | Ask an Owner, Admin or Editor |
| **{{ui:audits.cycleDetail.pack}}** is greyed out, and the preview reads {{ui:audits.cycleDetail.previewError}} | The preview could not load | Reload the page |
| {{ui:audits.cycleDetail.createPackError}}, or the reason the server gave | No pack was created | Try again. If the message names your role, ask an Owner, Admin or Editor |
| {{ui:audits.cycleDetail.addItemsError}}, or the reason the server gave | The pack was created, but none of its items were added | Open the pack and add the items you need with **{{ui:audits.packs.addItems}}** |
| {{ui:audits.packs.itemsEmptyTitle}} | The pack is empty | Click **{{ui:audits.packs.addItems}}** |
| No **{{ui:audits.packs.addItems}}** button, and no crosses on the items | The pack is already frozen, or your role cannot change packs | Owners, Admins and Editors can change a draft pack. To change a frozen one, use **{{ui:audits.packs.cloneForRetest}}** |
| No **{{ui:audits.packs.freezePack}}** button on a draft | Your role cannot freeze packs | Ask an Owner or Admin |
| **{{ui:audits.packs.addPicker.itemLabel}}** is greyed out in the {{ui:audits.packs.addPicker.title}} dialog | There is nothing of that type to add | Choose another **{{ui:audits.packs.addPicker.typeLabel}}** |
| {{ui:audits.packs.addPicker.added}}, but the item list does not change | The item was already in the pack | Nothing to do. A pack holds each item once |
| {{ui:audits.packs.addPicker.addError}}, or the reason the server gave | The item was not added | Try again. If the pack was frozen meanwhile, reload the page |
| {{ui:audits.packs.removeItem.error}}, or the reason the server gave, and the item is back in the list | The item was not removed. Usually the pack was frozen meanwhile | Reload the page. A frozen pack cannot change; use **{{ui:audits.packs.cloneForRetest}}** |
| {{ui:audits.packs.failedFreeze}}, or the reason the server gave, such as **Cannot freeze an empty pack** | The pack was not frozen | Add at least one item, then freeze it again |
| {{ui:audits.packs.cloneError}} | No copy was made | Try again |
| {{ui:audits.packs.loadError}} | The pack could not be loaded | Click **{{ui:audits.packs.retry}}** |
| {{ui:audits.packs.notFound}} | The pack does not exist in this workspace, or the link is wrong | Open the pack from its cycle's page |
