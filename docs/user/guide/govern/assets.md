---
route: /t/[tenantSlug]/assets
---

# {{ui:assets.title}}

The {{ui:assets.title}} lists every asset the workspace manages: its systems, applications, data stores, vendors and processes. It shows how critical each one is, who owns it, and how many controls, open vulnerabilities and tasks are linked to it.

## Where to find it

Open **{{ui:nav.assets}}** under **{{ui:nav.govern}}** in the sidebar. The breadcrumb reads **{{ui:assets.breadcrumbDashboard}}** › **{{ui:assets.title}}**.

## Who can use it

| Action | Roles |
| --- | --- |
| View the inventory, the summary cards and an asset's preview | Every role: Owner, Admin, Editor, Reader, Auditor and AI admin |
| Create assets and import them from a CSV file | Owner, Admin, Editor |
| Set status or assign an owner in bulk | Owner, Admin, Editor |
| Delete in bulk | Owner, Admin |
| Open the deleted assets, restore them and purge them | Owner, Admin |

Every role can tick rows, but only Owners, Admins and Editors get the selection bar's actions. Editors are offered **{{ui:assets.bulk.delete}}** there too, and the deletion fails: see [Change many assets at once](#change-many-assets-at-once).

If your workspace uses custom roles, what you can do depends on the permissions your role was given. The page shows its buttons according to the built-in role your custom role is based on, so a button can appear and the change still be refused.

## What it is for

Use the inventory to know what you are protecting before you map risks and controls to it. Each asset is rated 1 to 5 for confidentiality, integrity and availability, and its criticality follows from those scores. Its product details let Inflect match newly published vulnerabilities to it.

## What you see

**Summary cards.** Four cards sit above the table, each with a trend line once the workspace has a few days of history:

| Card | What it counts | Clicking it |
| --- | --- | --- |
| {{ui:assets.kpi.total}} | Every asset in the workspace, whatever the filters | Clears every filter |
| {{ui:assets.kpi.active}} | {{ui:assets.filterEnums.status.ACTIVE}} assets that match your other filters and search | Filters to {{ui:assets.filterEnums.status.ACTIVE}} |
| {{ui:assets.kpi.highCriticality}} | Assets of {{ui:assets.filterEnums.criticality.HIGH}} or {{ui:assets.filterEnums.criticality.CRITICAL}} criticality that match your other filters and search | Filters to those two criticalities |
| {{ui:assets.kpi.retired}} | {{ui:assets.filterEnums.status.RETIRED}} assets that match your other filters and search | Filters to {{ui:assets.filterEnums.status.RETIRED}} |

Click a highlighted card again to drop its filter.

**The toolbar.** From left to right:

- **{{ui:assets.addAsset}}** opens the new-asset dialog. Only Owners, Admins and Editors see it.
- The **{{ui:common.ui.filter}}** button holds the search and the filters. Its search box, **{{ui:assets.searchPlaceholder}}**, filters the table as you type and matches an asset's name, classification and owner. The filters are {{ui:assets.filters.type}}, {{ui:assets.filters.status}} and {{ui:assets.filters.criticality}}, and you can pick several values in each. Each active filter shows as a pill beside the button.
- **{{ui:common.ui.viewsMenu}}** holds **{{ui:assets.coverageTooltip}}** and **{{ui:assets.viewVulnerabilities}}**, which open those pages. Owners, Admins and Editors also get **{{ui:assets.importAssets}}**, and Owners and Admins get **{{ui:assets.deleted.toggle}}**.
- Two settings buttons close the row. The first chooses which table columns are shown, the second which summary cards. The page remembers both choices.

Filters and the search are kept in the page address, so a filtered view can be bookmarked or shared with a colleague who has access to the workspace.

**The table.** Newest assets come first. Click a column header, other than {{ui:assets.colHeaders.vulnerabilities}}, to sort by it.

| Column | What it shows |
| --- | --- |
| {{ui:assets.colHeaders.code}} | The asset's short reference, such as AST-12. Hidden until you turn it on |
| {{ui:assets.name}} | The asset's name. Click it to open the preview |
| {{ui:assets.type}} | The kind of asset, in capitals, such as SYSTEM or DATA STORE |
| {{ui:assets.colHeaders.criticality}} | {{ui:assets.filterEnums.criticality.LOW}}, {{ui:assets.filterEnums.criticality.MEDIUM}}, {{ui:assets.filterEnums.criticality.HIGH}} or {{ui:assets.filterEnums.criticality.CRITICAL}} |
| {{ui:assets.classification}} | The data classification. Hidden until you turn it on |
| {{ui:assets.owner}} | The member who owns the asset. A name followed by ({{ui:assets.list.ownerImported}}) came from a CSV import and matched no member |
| {{ui:assets.controlsCol}} | How many controls are linked to the asset |
| {{ui:assets.colHeaders.vulnerabilities}} | Open vulnerabilities and open scanner findings on the asset, coloured by the worst severity. Click the number to open the vulnerabilities page for that asset, which lists matched vulnerabilities only, not scanner findings |
| {{ui:assets.colHeaders.tasks}} | Linked tasks as done/total, shown in green when all are done |

The table has no status column; use the {{ui:assets.filters.status}} filter or the cards.

An asset's criticality comes from its three scores. Any score of 5 makes it {{ui:assets.filterEnums.criticality.CRITICAL}}. Otherwise the two highest scores are averaged and rounded: 4 is {{ui:assets.filterEnums.criticality.HIGH}}, 3 is {{ui:assets.filterEnums.criticality.MEDIUM}}, and 1 or 2 is {{ui:assets.filterEnums.criticality.LOW}}.

**Moving around the table.** Hovering an asset's name shows the hint **{{ui:assets.rowInteractionHint}}**.

- Click the name to open the preview in a side panel.
- Click anywhere else on the row to tick it.
- Double-click the row to open the asset's own page.

**The preview.** It shows the asset's code and type, its criticality and score, its status as ACTIVE or RETIRED, its owner, classification and three scores, and its open vulnerabilities. Location, external reference, data residency, retention and notes appear when they are filled in. While it is open, the ↑ and ↓ keys move to the previous or next asset. They follow the newest-first order even when you have sorted the table. **{{ui:assets.detail.fullView}}** opens the asset's own page.

## What you can do

### Create an asset

Click **{{ui:assets.addAsset}}**. A dialog opens with these fields:

- **{{ui:assets.name}}**, the only required field. Another asset with exactly the same name is refused.
- **{{ui:assets.type}}**, one of ten kinds, starting on SYSTEM. The list spells them in capitals.
- **{{ui:assets.classification}}**: {{ui:assets.formOptions.classification.Public}}, {{ui:assets.formOptions.classification.Internal}}, {{ui:assets.formOptions.classification.Confidential}} or {{ui:assets.formOptions.classification.Restricted}}.
- **{{ui:assets.owner}}**, a member of the workspace, starting on {{ui:assets.form.unassigned}}. Also **{{ui:assets.location}}**, **{{ui:assets.form.status}}** (starting on {{ui:assets.formOptions.status.ACTIVE}}) and **{{ui:assets.dataResidency}}**.
- **{{ui:assets.crit.heading}}**: sliders for {{ui:assets.confidentiality}}, {{ui:assets.integrity}} and {{ui:assets.availability}}, each starting at 3. The resulting criticality shows beside them.
- **{{ui:assets.form.identityHeading}}**: {{ui:assets.form.cpe}}, {{ui:assets.form.vendor}}, {{ui:assets.form.product}} and {{ui:assets.form.version}}. Without them, new vulnerabilities cannot be matched to the asset.
- **{{ui:assets.form.externalRef}}**, **{{ui:assets.form.retention}}**, a **{{ui:assets.form.retentionUntil}}** date, **{{ui:assets.form.dependencies}}** and **{{ui:assets.form.businessProcesses}}**. The notes are free text and link nothing.

Click **{{ui:assets.createAsset}}**. The dialog closes and the new asset's page opens. If you close the dialog after typing, it asks **{{ui:assets.modal.discardConfirm}}**

To edit, retire or delete a single asset, open its page.

### Change many assets at once

Tick the rows you want, up to 100 at a time. In the selection bar, choose an action from **{{ui:common.table.chooseAction}}**, fill in its value if it asks for one, and click **{{ui:common.table.apply}}**:

- **{{ui:assets.bulk.setStatus}}** moves every selected asset to {{ui:assets.statusOption.ACTIVE}} or {{ui:assets.statusOption.RETIRED}}.
- **{{ui:assets.bulk.assignOwner}}** gives them all one owner. Leave the owner empty to unassign them.
- **{{ui:assets.bulk.delete}}** takes them out of the table at once, and for five seconds a message offers **{{ui:assets.deleted.undo}}**. Nothing is deleted until that time runs out. Only Owners and Admins can delete: when an Editor tries, the request is refused once the five seconds pass, and the rows come back.

A failed status or owner change leaves the rows ticked, so you can try again without picking them again.

### Import assets from a CSV file

Open **{{ui:common.ui.viewsMenu}}** › **{{ui:assets.importAssets}}**. The **{{ui:assets.import.title}}** page explains the format and shows an example row.

- The file needs a header row with a Name column and a Type column. The format box lists Type as optional, but a row without one is refused.
- The other columns are optional: Status, Owner, Classification, Location, Confidentiality, Integrity and Availability (1 to 5), Retention, RetentionUntil (YYYY-MM-DD), ExternalRef, Dependencies, BusinessProcesses, DataResidency, CPE, Vendor, Product and Version. Header names may be in any case.
- Type and Status use the codes in the example, such as DATA_STORE or ACTIVE.

Click **{{ui:assets.import.chooseFile}}**. A preview shows the first 20 rows, and its **{{ui:assets.import.colStatus}}** column reads **{{ui:assets.import.rowOk}}** or names the problem. Click the import button, which shows how many valid rows the file holds. Rows with a problem are left out.

The import skips a row whose name matches an existing asset, ignoring case, or a row earlier in the file, and lists each skipped row. An Owner that matches a member's name or email becomes that member. Criticality is worked out from the three scores, and a missing score counts as 3. A file can import at most 500 assets at once.

### Restore or purge deleted assets

Owners and Admins only. Choose **{{ui:common.ui.viewsMenu}}** › **{{ui:assets.deleted.toggle}}** to switch the table to deleted assets, and choose it again to switch back. The view hides the cards and adds a **{{ui:assets.deleted.actions}}** column with **{{ui:assets.deleted.restore}}** and **{{ui:assets.deleted.purge}}**. Purge removes the asset for good, and asks you to type its code, or its name if it has none, before it goes ahead.

At present the view always reads **{{ui:assets.deleted.emptyTitle}}**, even when assets have been deleted, so neither button can be reached. Until a deleted asset is removed for good, 90 days after its deletion, an Owner or Admin can still restore it through the Inflect API.

## What happens next

- A new asset gets the next code in the workspace's sequence: AST-1, AST-2 and so on.
- Every creation, including each imported asset, and every status change, owner change, deletion, restore and purge is recorded in the workspace's audit log, naming who made it.
- A deleted asset leaves the inventory at once and is removed for good after 90 days. Its name can be used again straight away.
- When an asset's {{ui:assets.form.retentionUntil}} date has passed, the nightly clean-up deletes it, the same as a deletion by hand. The hint in the form says the asset is retired, but it is deleted.
- Retired assets stay in the inventory and count under {{ui:assets.kpi.retired}}.
- Assigning an owner from this page sends them no notification. Changing the owner on the asset's own page does.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:assets.noAssets}}** | The workspace has no assets | Click **{{ui:assets.empty.addAssetAction}}**, or import assets |
| **{{ui:assets.empty.noResultsTitle}}** | No asset matches the search and filters. A list that failed to load after you changed a filter shows the same message | Click **{{ui:assets.empty.clearFilters}}**, or reload the page |
| **{{ui:assets.deleted.emptyTitle}}** | Shown in the deleted view whether or not assets have been deleted | See [Restore or purge deleted assets](#restore-or-purge-deleted-assets) |
| **{{ui:assets.bulk.actionFailed}}** | A bulk action did not go through, because more than 100 rows were selected or your role cannot delete | Select fewer rows, or ask an Owner or Admin to delete |
| A banner saying only the first 5,000 results are shown | More than 5,000 assets match the search and filters | Narrow the list with a filter or the search |
| **A resource with that unique constraint already exists** in the new-asset dialog | Another asset already has that name | Choose a different name |
| **Owner must be an active member of this tenant** | The chosen owner is no longer an active member | Choose another owner |
| **Permission denied** in the new-asset dialog | Your role cannot create assets. The dialog opens for every role from an old link to the new-asset page | Ask an Owner, Admin or Editor |
| **{{ui:assets.form.createFailed}}** | The asset was not created | Try again |
| **{{ui:assets.import.invalidCsv}}** | The file has no Name header, or no data rows | Fix the header and choose the file again |
| **{{ui:assets.import.errNameRequired}}**, **{{ui:assets.import.errTypeRequired}}**, an invalid type or status, or **{{ui:assets.import.errCia}}** in the preview | That row cannot be imported | Fix the row, or import without it |
| **Import complete — 0 of …** with **Invalid request payload** under {{ui:assets.import.errors}} | The import was refused as a whole, usually because it had more than 500 valid rows | Split the file and import each part |
| **{{ui:assets.import.forbidden}}** | Your role cannot import assets | Ask an Owner, Admin or Editor |

## Related

- [{{ui:risks.title}}](risks.md), for the risks that sit on your assets.
- [{{ui:controls.list.pageTitle}}](controls.md), for the controls that protect them.
- An asset's own page holds its linked risks, controls, evidence, tasks and vulnerabilities, and its edit and delete buttons.
