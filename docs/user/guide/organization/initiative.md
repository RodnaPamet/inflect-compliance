---
route: /org/[orgSlug]/initiatives/[initiativeId]
---

# Initiative

An initiative's page shows one security initiative: its status, owner, target date, progress, and the work linked to it from the organization's workspaces. Owners and Admins edit it, link work to it, move it through its statuses and delete it here.

## Where to find it

On [{{ui:org.initiatives.title}}](initiatives.md), click a row. On the dashboard's {{ui:org.widgets.securityInitiatives}} card, click an initiative. **{{ui:org.initiativeDetail.backToInitiatives}}** at the top returns to the list.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin, Reader |
| Edit, link and unlink work, change the status, delete | Owner, Admin |
| Open a linked item | Anyone who belongs to the item's workspace; organization Owners and Admins have Admin access to every workspace |

## What you see

**The heading.** The initiative's title and its status, then its description, its owner (or **{{ui:org.initiativeDetail.noOwner}}**) and its target date when it has one.

**Progress.** A bar and a percentage, labelled either:

- **{{ui:org.initiativeDetail.progressDerived}}**: the share of linked items that are done, with the count. A control is done when implemented; a risk when mitigated, accepted or closed; a task when resolved or closed; a finding when closed.
- **{{ui:org.initiativeDetail.progressManual}}**: a percentage set for the initiative by hand, which takes the place of the linked work.

**{{ui:org.initiativeDetail.linkedWork}}.** The items linked to the initiative, and how many workspaces they come from:

| Column | What it shows |
| --- | --- |
| {{ui:org.initiativeDetail.colType}} | **{{ui:org.initiativeDetail.typeControl}}**, **{{ui:org.initiativeDetail.typeRisk}}**, **{{ui:org.initiativeDetail.typeTask}}** or **{{ui:org.initiativeDetail.typeFinding}}** |
| {{ui:org.initiativeDetail.colWorkspace}} | The workspace the item belongs to, or **{{ui:org.initiativeDetail.workspaceGone}}** once it has left the organization |
| {{ui:org.initiativeDetail.colEntity}} | The item's name. Click it to open the item in its workspace. An item deleted since it was linked says **{{ui:org.initiativeDetail.itemGone}}** |

## What you can do

### Edit the initiative

Click **{{ui:org.initiativeDetail.edit}}**. In the panel, change any of:

| Field | What it is |
| --- | --- |
| {{ui:org.initiatives.titleLabel}} | What the initiative is. Required |
| {{ui:org.initiatives.descriptionLabel}} | More about it |
| {{ui:org.initiatives.ownerLabel}} | {{ui:org.initiatives.ownerHint}} |
| {{ui:org.initiatives.targetLabel}} | {{ui:org.initiatives.targetHint}} |
| {{ui:org.initiativeDetail.progressLabel}} | **{{ui:org.initiativeDetail.progressFromLinks}}**, or **{{ui:org.initiativeDetail.progressByHand}}** with a percentage |

Click **{{ui:org.initiativeDetail.save}}**.

### Link work

1. Click **{{ui:org.initiativeDetail.linkWork}}**.
2. Choose the **{{ui:org.initiativeDetail.workspaceLabel}}** the item is in, and its **{{ui:org.initiativeDetail.typeLabel}}**: control, risk, task or finding.
3. In **{{ui:org.initiativeDetail.itemLabel}}**, search by name and choose the item.
4. Click **{{ui:org.initiativeDetail.linkWork}}**.

The item joins the list, and, unless progress is set by hand, the progress bar counts it. Linking the same item again changes nothing.

### Change the status

Next to **{{ui:org.initiativeDetail.setStatus}}**, click the new status: **{{ui:org.widgets.statusPlanned}}**, **{{ui:org.widgets.statusInProgress}}**, **{{ui:org.widgets.statusBlocked}}**, **{{ui:org.widgets.statusCompleted}}** or **{{ui:org.widgets.statusCancelled}}**. The button for the current status is greyed out. **{{ui:org.widgets.statusCompleted}}** and **{{ui:org.widgets.statusCancelled}}** end the initiative, so they ask you to confirm first; it stays in the list, and you can set another status later.

### Unlink an item

Click **{{ui:org.initiativeDetail.unlink}}** on its row. It leaves the list at once, and a message offers **{{ui:org.initiativeDetail.undo}}** for 5 seconds; after that it is unlinked. The item itself is not changed.

### Delete the initiative

Click **{{ui:org.initiativeDetail.delete}}**, type the initiative's title to confirm, and click **{{ui:org.initiativeDetail.deleteConfirm}}**. The initiative and its links are deleted for everyone in the organization, and you return to the list. The linked items themselves do not change. This cannot be undone.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:org.initiativeDetail.emptyLinksTitle}}**, and 0% progress | Nothing is linked to the initiative | An Owner or Admin clicks **{{ui:org.initiativeDetail.linkWork}}** |
| A red sentence under the progress bar | A status change or an unlink did not happen; the sentence says why. A refused unlink puts the row back | Fix what it names, or try again |
| A red sentence in the Edit panel or a dialog | The change was not saved, for example because the owner is not a member of the organization or the item no longer exists | Fix what it names, or try again |
| **{{ui:errorPage.notFoundTitle}}** | The initiative does not exist in this organization | Go back to [{{ui:org.initiatives.title}}](initiatives.md) |

## Related

- [{{ui:org.initiatives.title}}](initiatives.md), every initiative in the organization.
