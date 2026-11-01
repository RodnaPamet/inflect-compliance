---
route: /org/[orgSlug]/initiatives/[initiativeId]
---

# Initiative

An initiative's page shows one security initiative: its status, target date, progress, and the work linked to it from the organization's workspaces. Owners and Admins move it through its statuses here.

## Where to find it

On [{{ui:org.initiatives.title}}](initiatives.md), click a row. On the dashboard's {{ui:org.widgets.securityInitiatives}} card, click an initiative. **{{ui:org.initiativeDetail.backToInitiatives}}** at the top returns to the list.

## Who can use it

| Action | Roles |
| --- | --- |
| Open the page | Owner, Admin, Reader |
| Change the status | Owner, Admin |
| Unlink an item of work | Owner, Admin |

## What you see

**The heading.** The initiative's title and its status, then its description and target date when it has them.

**Progress.** A bar and a percentage, labelled either:

- **{{ui:org.initiativeDetail.progressDerived}}**: the share of linked items that are done, with the count. A control is done when implemented; a risk when mitigated, accepted or closed; a task when resolved or closed; a finding when closed.
- **{{ui:org.initiativeDetail.progressManual}}**: a percentage set for the initiative by hand, which takes the place of the linked work.

**{{ui:org.initiativeDetail.linkedWork}}.** The items linked to the initiative, and how many workspaces they come from. Each row gives its {{ui:org.initiativeDetail.colType}} (control, risk, task or finding), its {{ui:org.initiativeDetail.colTenant}} and the {{ui:org.initiativeDetail.colEntity}}.

## What you can do

### Change the status

Next to **{{ui:org.initiativeDetail.setStatus}}**, click the new status: **{{ui:org.widgets.statusPlanned}}**, **{{ui:org.widgets.statusInProgress}}**, **{{ui:org.widgets.statusBlocked}}**, **{{ui:org.widgets.statusCompleted}}** or **{{ui:org.widgets.statusCancelled}}**. The button for the current status is greyed out.

### Unlink an item

Click **{{ui:org.initiativeDetail.unlink}}** on its row. It leaves the list at once, and a message offers **{{ui:org.initiativeDetail.undo}}** for 5 seconds; after that it is unlinked. The item itself is not changed.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| An empty {{ui:org.initiativeDetail.linkedWork}} table, and 0% progress | Nothing is linked to the initiative | Nothing on this page links work to it |
| **{{ui:errorPage.notFoundTitle}}** | The initiative does not exist in this organization | Go back to [{{ui:org.initiatives.title}}](initiatives.md) |

## Related

- [{{ui:org.initiatives.title}}](initiatives.md), every initiative in the organization.
