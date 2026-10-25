---
route: /t/[tenantSlug]/policies
---

# {{ui:policies.title}}

The {{ui:policies.title}} page is the workspace's policy library. It lists every policy with its status, owner, published version, acknowledgement progress and next review date, and it is where a new policy is started.

## Where to find it

Open **{{ui:nav.policies}}** under **{{ui:nav.manage}}** in the sidebar. The breadcrumb reads **{{ui:policies.list.dashboard}}** › **{{ui:policies.title}}**.

Older links to a separate new-policy page or policy-templates page still work: they open this page with the new-policy dialog already open, for roles that can create policies.

## Who can use it

| Action | Roles |
| --- | --- |
| View the list, search it and filter it | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Create a policy, blank or from a template | Owner, Admin, Editor |
| Link the controls a template suggests | Owner, Admin, Editor |
| Assign an owner to many policies at once | Owner, Admin, Editor |
| Archive or delete many policies at once | Owner, Admin |

Owners and Admins get three actions in the selection bar, and Editors get only **{{ui:policies.bulk.assignOwner}}**. The other roles cannot tick rows.

If your workspace uses custom roles, what you can do depends on the permissions your role was given. The page chooses its buttons from the built-in role your custom role is based on, so it can offer an action that then fails.

Asking for approval, approving, publishing and collecting acknowledgements happen on each policy's own page. The how-tos under Related say who can do each.

## What it is for

Use the library to see which policies exist, which are live, and which need attention: a draft to finish, a version waiting for approval, a review date that has passed, or people who have not acknowledged the published version.

## What you see

**Summary cards.** The first four cards show by default, each with a trend line. The last two are off until you turn them on with the cards settings button described under the toolbar.

| Card | What it counts | Clicking it |
| --- | --- | --- |
| {{ui:policies.list.kpiTotal}} | Every policy in the workspace, whatever the filters | Clears every filter and the search |
| {{ui:policies.list.kpiDraft}} | Policies that are {{ui:policies.filterEnums.status.draft}} | Filters to that status |
| {{ui:policies.list.kpiInReview}} | Policies that are {{ui:policies.filterEnums.status.inReview}} | Filters to that status |
| {{ui:policies.list.kpiApproved}} | Policies that are {{ui:policies.filterEnums.status.approved}} or {{ui:policies.filterEnums.status.published}} | Filters to those two statuses |
| {{ui:policies.list.kpiOverdueReview}} | Policies whose next review date has passed, archived ones included | Filters to {{ui:policies.filterEnums.reviewBucket.overdue}} |
| {{ui:policies.list.kpiOutstandingAck}} | Policies where someone asked to acknowledge the current version has not done so, archived ones included | Filters to {{ui:policies.filters.acknowledgement}} › {{ui:policies.filterEnums.acknowledgement.outstanding}} |

Apart from {{ui:policies.list.kpiTotal}}, each count follows the search and the filters you have set. Click a selected card again to drop its filter. Clicking a card replaces any status, review-cycle or acknowledgement filter with its own, and keeps the search and the category. So while one of those filters is set, a card's number can differ from the rows its click shows.

**The toolbar.** From left to right:

- **{{ui:policies.list.addBtn}}**, the button with a plus sign, opens the new-policy dialog. Only roles that can create policies see it.
- The **{{ui:common.ui.filter}}** button holds the search and the filters. Its search box, **{{ui:policies.list.searchPlaceholder}}**, filters the table as you type and matches the title and the description. The filters are:
    - **{{ui:policies.filters.status}}**: one or more statuses.
    - **{{ui:policies.filters.category}}**: lists only the categories of the policies the table shows, so once one is chosen it offers only that one.
    - **{{ui:policies.filters.reviewBucket}}**: {{ui:policies.filterEnums.reviewBucket.overdue}} or {{ui:policies.filterEnums.reviewBucket.upcoming}}.
    - **{{ui:policies.filters.acknowledgement}}**: {{ui:policies.filterEnums.acknowledgement.outstanding}}.
- Two settings buttons close the row. The first chooses which table columns are shown, the second which summary cards.

Each active filter shows as a pill beside the **{{ui:common.ui.filter}}** button; remove a pill to drop that filter. Filters are kept in the page address, so a filtered view can be bookmarked or shared with a colleague who has access to the workspace.

**The table.** Each row is one policy, most recently updated first. Click a column heading to sort by it; every column but {{ui:policies.colHeaders.acknowledgement}} sorts. More rows load as you scroll.

| Column | What it shows |
| --- | --- |
| {{ui:policies.colHeaders.title}} | The policy's name, linked to the policy |
| {{ui:policies.colHeaders.status}} | Where the policy is in its life, as described below |
| {{ui:policies.colHeaders.category}} | The category chosen when the policy was created, or a dash |
| {{ui:policies.colHeaders.owner}} | The person accountable for the policy: their name, or the first part of their email address if their account has no name. A dash means nobody |
| {{ui:policies.colHeaders.version}} | The number of the published version, or of the last one published. A policy that has never been published shows v1, however many versions it has, and even if it has none |
| {{ui:policies.colHeaders.acknowledgement}} | For a published policy, how many people have acknowledged the published version out of how many were asked: amber while someone still owes it, green when everyone has. A dash means nobody was asked, or the policy is not published |
| {{ui:policies.colHeaders.nextReview}} | When the policy is next due for review. **{{ui:policies.list.overdue}}** marks a date that has passed, except on an archived policy |
| {{ui:policies.colHeaders.updated}} | When the policy last changed. This date and the review date show as a relative time, such as "in 3 days"; hover one for the exact date |

The statuses are:

- **{{ui:policies.filterEnums.status.draft}}**: being written or changed. Nobody is asked to follow it.
- **{{ui:policies.filterEnums.status.inReview}}**: someone asked for approval of a version.
- **{{ui:policies.filterEnums.status.approved}}**: an Owner or Admin approved a version, which waits to be published.
- **{{ui:policies.filterEnums.status.published}}**: live. Staff follow it and can acknowledge it. A published policy keeps this status while a new version of it goes through approval, so a pending revision shows only on the policy's page.
- **{{ui:policies.filterEnums.status.archived}}**: taken out of use. Its text cannot be changed and it cannot be sent for approval until an Owner or Admin restores it.

Click a policy's title to open it. For roles that can tick rows, a single click on a row ticks it and a double-click opens the policy; for the others, a single click opens it. On a policy's page, the arrows at the top step to the previous or next policy in the order this list showed them.

## What you can do

### Create a policy

Click **{{ui:policies.list.addBtn}}**. The **{{ui:policies.new.titleBlank}}** dialog opens on **{{ui:policies.new.modeNew}}**, also when you arrive from an older templates link. In **{{ui:policies.new.startWith}}**, keep **{{ui:policies.new.modeNew}}** for a blank policy, or choose **{{ui:policies.new.modeFromTemplate}}** and click a template under **{{ui:policies.new.chooseTemplate}}**.

Fill in **{{ui:policies.new.fieldTitle}}**, which is required, and if you like **{{ui:policies.new.fieldDescription}}** and **{{ui:policies.new.fieldCategory}}**. A blank policy can also take its first text under **{{ui:policies.new.fieldContent}}**. Click **{{ui:policies.createPolicy}}**. The policy's page opens.

If the template is mapped to framework requirements your workspace already has controls for, a dialog first suggests linking the policy to them. Tick the controls the policy supports and click the link button, or click **{{ui:policies.templates.skip}}**. [Create a policy](../../how-to/policies/create-a-policy.md) walks through each field.

### Assign an owner to many policies

Tick the rows, up to 100 at a time. In the selection bar, choose **{{ui:policies.bulk.assignOwner}}** from **{{ui:common.table.chooseAction}}**. Pick an active member in the box beside it, which reads **{{ui:policies.bulk.ownerBlank}}**, and click **{{ui:common.table.apply}}**. Leave the box empty to remove the owner from every selected policy. A message confirms how many policies changed.

### Archive many policies

Owners and Admins only. Tick the rows, choose **{{ui:policies.bulk.archive}}**, click **{{ui:common.table.apply}}**, then confirm with **{{ui:policies.bulk.archiveConfirmLabel}}**. The policies stay on the list as {{ui:policies.filterEnums.status.archived}}.

### Delete many policies

Owners and Admins only. Tick the rows, choose **{{ui:policies.bulk.delete}}** and click **{{ui:common.table.apply}}**. There is no confirmation. The rows leave the table, and for five seconds a message offers **{{ui:policies.bulk.undo}}**. Nothing is deleted until that time runs out. If someone else had already deleted some of them, a second message says how many.

A failed owner change or archive leaves the rows selected, so you can try again without picking them again. A failed deletion puts the rows back in the table.

## What happens next

- A new policy starts as {{ui:policies.filterEnums.status.draft}}. To make it live, write its content and take it through approval and publication: see [Publish a policy](../../how-to/policies/publish-a-policy.md).
- A policy created from a template already has its first version, written from the template, and you as its owner. If the template sets a review frequency, it also gets a next review date. A blank policy has no owner until someone assigns one.
- Every creation, owner change, archive and deletion writes one entry per policy to the workspace's audit log, naming who made it.
- From shortly before a policy's next review date until it is marked reviewed, Inflect emails its owner once a day, if your workspace sends notifications, and opens one review task assigned to them. Archived policies and policies with no owner get neither.
- An archived policy stays on the list. An Owner or Admin can bring it back with **{{ui:policies.detail.restoreFromArchive}}** on the policy's page. It returns as {{ui:policies.filterEnums.status.draft}} and must be approved and published again.
- A deleted policy leaves the list at once and is removed for good after 90 days. If one was deleted by mistake, an Owner or Admin can restore it within those 90 days; this page has no restore button, so they do it through the Inflect API.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:common.ui.listLoadFailed}}** | The list could not be loaded | Reload the page |
| **{{ui:common.ui.listRefreshFailed}}** above the table | The list could not be refreshed after a change, so the rows shown may be from before it | Click **{{ui:common.retry}}** |
| **{{ui:policies.noPolicies}}** | The workspace has no policies | Click **{{ui:policies.list.addBtn}}**, or ask an Owner, Admin or Editor |
| **{{ui:policies.list.emptyFilterTitle}}** | Policies exist, but none match the search and filters | Click **{{ui:policies.list.clearFilters}}** |
| **{{ui:policies.new.templatesEmpty}}** in the dialog | Your workspace has no policy templates | Choose **{{ui:policies.new.modeNew}}** and write the policy yourself |
| **{{ui:policies.new.templatesFailed}}** in the dialog | The templates could not be loaded | Close the dialog and open it again |
| A red message at the top of the dialog after **{{ui:policies.createPolicy}}** | Inflect did not create the policy. The message says why | Fix what it names, then try again |
| **{{ui:policies.templates.linkFailed}}** or another red message in the suggested-controls dialog | The policy was created, but the controls were not linked | Try again, or click **{{ui:policies.templates.skip}}** and link them later on the policy's **{{ui:policies.detail.tabTraceability}}** tab |
| **{{ui:policies.bulk.failed}}** | A bulk change did not go through, for example because more than 100 rows were selected or your role cannot apply it. The message gives no reason | Select fewer rows, reload the page and try again |
| A banner reading **Showing the first 5,000 results.** | More than 5,000 policies match, more than the page loads at once | Narrow the list with a filter or the search |

## Related

- [Create a policy](../../how-to/policies/create-a-policy.md), every field of the new-policy dialog and how to write a version.
- [Publish a policy](../../how-to/policies/publish-a-policy.md), from asking for approval to publishing, and how to revise a published policy.
- [Collect policy acknowledgements](../../how-to/policies/collect-policy-acknowledgements.md), which fills the {{ui:policies.colHeaders.acknowledgement}} column.
