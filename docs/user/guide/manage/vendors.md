---
route: /t/[tenantSlug]/vendors
---

# {{ui:vendors.title}}

The {{ui:vendors.title}} lists the workspace's third parties: suppliers, service providers and sub-processors. It shows each vendor's lifecycle status, how critical it is to the business, the risk its assessments found, when it is next due for review and who owns it.

## Where to find it

Open **{{ui:nav.vendors}}** under **{{ui:nav.manage}}** in the sidebar. The breadcrumb reads **{{ui:vendors.breadcrumbDashboard}}** › **{{ui:vendors.title}}**.

Older links to a separate new-vendor page still work: they open this page with the new-vendor dialog already open, for roles that can create vendors.

## Who can use it

| Action | Roles |
| --- | --- |
| View the register, its summary cards and the vendor dashboard | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Create a vendor | Owner, Admin, Editor |
| Set status or assign an owner in bulk | Owner, Admin, Editor |
| Delete in bulk | Owner, Admin |

The selection bar offers only the bulk actions your role can apply: Editors see no {{ui:vendors.bulk.delete}}. Readers, Auditors and AI admins cannot tick rows at all; clicking a row opens the vendor.

If your workspace uses custom roles, what you can do depends on the permissions your role was given. Creating a vendor needs permission both to create and to edit vendors, and a role without both sees no **{{ui:vendors.createButton}}**. Setting status and assigning an owner need permission to edit vendors. Deleting needs permission to manage the workspace and a custom role built on Owner or Admin.

## What it is for

Use the register to keep track of who the business depends on and what they can reach. Record each vendor once, rate how critical it is and how much of your data it can access, mark the sub-processors, and keep its review and contract renewal dates in view. The risk rating comes from the vendor's assessments, so it reflects what the latest reviewed questionnaire found.

## What you see

**The header.** The breadcrumb, and the line {{ui:vendors.subtitle}}

**Summary cards.** Four cards sit above the table, each with a trend line once the workspace has a few days of history:

| Card | What it counts | Clicking it |
| --- | --- | --- |
| {{ui:vendors.kpi.total}} | Every vendor in the workspace, whatever the filters | Clears every filter |
| {{ui:vendors.kpi.active}} | {{ui:vendors.statusOption.ACTIVE}} vendors that match your other filters and search | Filters to {{ui:vendors.statusOption.ACTIVE}} |
| {{ui:vendors.kpi.critical}} | Vendors of {{ui:vendors.criticalityLabel.CRITICAL}} criticality that match your other filters and search | Filters to that criticality |
| {{ui:vendors.kpi.reviewOverdue}} | Vendors whose next review date has passed, among those that match your filters and search | Filters to {{ui:vendors.filterEnums.reviewDue.overdue}} |

Click a highlighted card again to drop its filter. When the list cannot be loaded, the cards show a dash.

**The toolbar.** From left to right:

- **{{ui:vendors.createButton}}** opens the new-vendor dialog. Only roles that can create vendors see it.
- The **{{ui:common.ui.filter}}** button holds the search and the filters. Its search box, **{{ui:vendors.searchPlaceholder}}**, filters the table as you type and matches a vendor's name, legal name and domain. The filters are {{ui:vendors.filters.status}}, {{ui:vendors.filters.criticality}}, {{ui:vendors.filters.riskRating}} and {{ui:vendors.filters.reviewDue}}. You can pick several values in each of the first three. {{ui:vendors.filters.reviewDue}} offers {{ui:vendors.filterEnums.reviewDue.overdue}} or {{ui:vendors.filterEnums.reviewDue.next30d}}.
- {{ui:vendors.filters.riskRating}} matches a vendor if any of its assessments ever received that rating, not only the latest one. The vendor dashboard counts by the latest assessment, so the two can differ.
- The dashboard button, whose hint reads **{{ui:vendors.dashboardTooltip}}**, opens the **{{ui:vendors.dashboard.title}}**.
- Two settings buttons close the row. The first chooses which table columns are shown, the second which summary cards. The page remembers both choices.

Filters and the search are kept in the page address, so a filtered view can be bookmarked or shared with a colleague who has access to the workspace.

**The table.** The most critical vendors come first, then A to Z by name. Click a column header to sort by it. {{ui:vendors.columns.criticality}} and {{ui:vendors.columns.risk}} sort by level, from low to high or high to low; a vendor with no risk rating sorts with the empty values.

| Column | What it shows |
| --- | --- |
| {{ui:vendors.columns.name}} | The vendor's name, linked to its page |
| {{ui:vendors.columns.status}} | {{ui:vendors.statusOption.ONBOARDING}}, {{ui:vendors.statusOption.ACTIVE}}, {{ui:vendors.statusOption.OFFBOARDING}} or {{ui:vendors.statusOption.OFFBOARDED}} |
| {{ui:vendors.columns.criticality}} | How much the business depends on the vendor, as your team set it: {{ui:vendors.criticalityLabel.LOW}}, {{ui:vendors.criticalityLabel.MEDIUM}}, {{ui:vendors.criticalityLabel.HIGH}} or {{ui:vendors.criticalityLabel.CRITICAL}} |
| {{ui:vendors.columns.risk}} | The risk rating from the vendor's latest completed assessment review. A dash means no review has set one |
| {{ui:vendors.columns.nextReview}} | When the next review is due, as a relative time such as "in 3 days". Hover it for the exact date. **{{ui:vendors.badge.overdue}}** appears once the date has passed |
| {{ui:vendors.columns.contractRenewal}} | When the contract renews, with **{{ui:vendors.badge.due}}** once that date has passed. Hidden until you turn it on |
| {{ui:vendors.columns.owner}} | The member accountable for the vendor, or a dash |
| {{ui:vendors.columns.subprocessor}} | A **{{ui:vendors.detail.subprocessor}}** badge for a vendor marked as one. Hidden until you turn it on |

Click a row or a vendor's name to open the vendor's own page. Its tabs are {{ui:vendors.detail.tabs.overview}}, {{ui:vendors.detail.tabs.documents}}, {{ui:vendors.detail.tabs.assessments}}, {{ui:vendors.detail.tabs.monitoring}}, {{ui:vendors.detail.tabs.links}}, {{ui:vendors.detail.tabs.bundles}}, {{ui:vendors.detail.tabs.subprocessors}} and {{ui:vendors.detail.tabs.tasks}}. Editing a vendor, sending it an assessment and adding its documents all happen there.

## What you can do

### Create a vendor

Click **{{ui:vendors.createButton}}**. The **{{ui:vendors.modal.title}}** dialog has these fields:

- **{{ui:vendors.form.name}}**, the only required field, up to 200 characters. No other vendor in the workspace may have the same name; a deleted vendor's name is free to use.
- **{{ui:vendors.form.legalName}}**, **{{ui:vendors.form.domain}}**, **{{ui:vendors.form.websiteUrl}}** and **{{ui:vendors.form.country}}**. The website must be a full address, such as https://example.com.
- **{{ui:vendors.form.description}}**.
- **{{ui:vendors.form.status}}**, shown as {{ui:vendors.form.statusOnboarding}} and not chosen here. The hint reads: {{ui:vendors.form.statusOnCreateHint}}
- **{{ui:vendors.form.criticality}}**, starting on {{ui:vendors.form.critMedium}}.
- **{{ui:vendors.form.dataAccess}}**: how much of your data the vendor can reach, from {{ui:vendors.form.dataNone}} to {{ui:vendors.form.dataHigh}}. You can leave it unset.
- **{{ui:vendors.form.nextReviewDate}}** and **{{ui:vendors.form.contractRenewalDate}}**, each today or later.
- **{{ui:vendors.form.isSubprocessor}}**, a tick box.

Click **{{ui:vendors.modal.create}}**. It stays greyed out until the name is filled in and the website, if you typed one, is a full address. A website that is not a full address is marked under the field: {{ui:vendors.form.websiteUrlInvalid}} Each field stops at the length the server accepts. When the vendor is created, the dialog closes and the vendor's page opens. If you close the dialog after typing, it asks **{{ui:vendors.modal.discardConfirm}}**

The dialog has no owner field. Assign one on the vendor's page, or in bulk from the table.

A vendor can be made {{ui:vendors.statusOption.ACTIVE}} only once an assessment of it has completed review with a risk rating, on its page or in bulk.

### Change many vendors at once

Tick the rows you want, up to 100 at a time; with more ticked, the bar says **Select at most 100 vendors at a time.** In the selection bar, choose an action from **{{ui:common.table.chooseAction}}**, fill in its value if it asks for one, and click **{{ui:common.table.apply}}**:

- **{{ui:vendors.bulk.setStatus}}** moves every selected vendor to the status you choose. A vendor can move to {{ui:vendors.statusOption.ACTIVE}} only when its latest assessment has completed review with a risk rating. The others are skipped, and the message names up to three of them.
- **{{ui:vendors.bulk.assignOwner}}** gives them all one owner, who must be an active member of the workspace. Leave the owner empty to unassign them.
- **{{ui:vendors.bulk.delete}}** asks you to confirm, then removes the selected vendors from the register at once. There is no undo. Owners and Admins only.

The message that follows says how many vendors the change applied to. If a colleague deleted some of them in the meantime, it says how many were already gone. A refused action says why and leaves the rows ticked, so you can try again without picking them again.

## What happens next

- Every creation, and every status change, owner change and deletion made in bulk, writes one entry per vendor to the workspace's audit log, naming who made it.
- A deleted vendor leaves the register at once, and its name is free for a new vendor straight away. The product has no way to restore it, and it is removed for good after 90 days.
- A vendor whose next review date has passed stays **{{ui:vendors.badge.overdue}}**, and counts on the {{ui:vendors.kpi.reviewOverdue}} card, until a review is done. When an assessment of it completes review, with or without a risk rating, the next review date moves to a year later, unless a later date is already set. You can also change the date on the vendor's page.
- Each night, unless your installation has switched the vendor checks off, the owner of every overdue vendor that is not {{ui:vendors.statusOption.OFFBOARDED}} gets a notification that the review is due, once for each due date. A vendor with no owner notifies nobody in the app; its overdue review is included in the daily renewal email to Owners and Admins.
- Assigning an owner from this page sends them no notification.
- A vendor's next review and contract renewal dates appear on the {{ui:calendar.title}}.
- The {{ui:vendors.dashboard.title}} catches up with changes made here within a minute.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:vendors.empty.noRecordsTitle}}** | The workspace has no vendors | Click **{{ui:vendors.createButton}}**. Roles that cannot create vendors see no button |
| **{{ui:vendors.empty.noResultsTitle}}** | Vendors exist, but none match the search and filters | Click **{{ui:vendors.empty.clearFilters}}** |
| The server's reason, or **{{ui:vendors.bulk.failed}}**, after a bulk action | A bulk action did not go through, for example because the owner you chose is no longer an active member | Act on the reason, then try again |
| A message that some vendors were skipped, after **{{ui:vendors.bulk.setStatus}}** | Those vendors have no completed assessment review, so they cannot become {{ui:vendors.statusOption.ACTIVE}} | Complete an assessment review for each, then try again |
| **{{ui:vendors.form.nameTaken}}** in the new-vendor dialog | Another vendor in the workspace has that name | Choose a different name |
| **{{ui:vendors.createFailed}}** | The vendor was not created | Try again |
| **{{ui:vendors.loadError}}** | The list did not load. The summary cards show a dash | Reload the page |
| A banner saying only the first 5,000 results are shown | More than 5,000 vendors match the search and filters | Narrow the list with a filter or the search |

## Related

- [{{ui:assets.title}}](../govern/assets.md), [{{ui:risks.title}}](../govern/risks.md) and [{{ui:controls.list.pageTitle}}](../govern/controls.md). A vendor's {{ui:vendors.detail.tabs.links}} tab links it to the assets, risks and controls it bears on.
- [{{ui:tasks.list.srTitle}}](../comply/tasks.md), for the work linked to a vendor, which its {{ui:vendors.detail.tabs.tasks}} tab lists.
