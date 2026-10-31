---
route: /t/[tenantSlug]/assets/import
---

# {{ui:assets.import.title}}

The {{ui:assets.import.title}} page adds many assets at once from a CSV file. A preview of the rows, with any problems marked, comes before anything is created.

## Where to find it

Open **{{ui:nav.assets}}** under **{{ui:nav.govern}}** in the sidebar, open **{{ui:common.ui.viewsMenu}}** in the toolbar and choose **{{ui:assets.importAssets}}**. The menu item is offered only to roles that can create assets. The breadcrumb reads **{{ui:assets.breadcrumbDashboard}}** › **{{ui:assets.title}}** › **{{ui:assets.import.breadcrumb}}**, and the back link returns you to the page you came from.

## Who can use it

Owners, Admins and Editors. Anyone else who opens the page sees **{{ui:assets.import.forbidden}}** and a **{{ui:assets.import.backToAssets}}** button.

If your workspace uses custom roles, the page needs permission to create assets.

## What it is for

Use it to load an existing inventory, such as an export from a CMDB or a spreadsheet, instead of creating assets one by one.

## What you see

**{{ui:assets.import.csvFormat}}.** {{ui:assets.import.csvDesc}} An example row shows the layout with every column, including a quoted value that contains a comma.

The columns:

| Column | Notes |
| --- | --- |
| Name | Required |
| Type | Required. One of INFORMATION, APPLICATION, SYSTEM, SERVICE, DATA_STORE, INFRASTRUCTURE, VENDOR, PROCESS, PEOPLE_PROCESS or OTHER, in any case |
| Status | ACTIVE or RETIRED. Left empty, the asset is active |
| Owner | A member's name or email. A value that matches a member makes them the owner; anything else is kept as text and shown as imported |
| Confidentiality, Integrity, Availability | Whole numbers from 1 to 5. They set the asset's criticality |
| Classification, Location, Retention, RetentionUntil, ExternalRef, Dependencies, BusinessProcesses, DataResidency | Free text, except RetentionUntil, a date in the form YYYY-MM-DD |
| CPE, Vendor, Product, Version | The product identity used to match the asset to known vulnerabilities |

Column headings are not case-sensitive, and their order does not matter. Spaces around a name are ignored, so a name of only spaces counts as missing.

**The preview.** After you choose a file, the first 20 rows appear with their **{{ui:assets.import.colName}}**, **{{ui:assets.import.colType}}** (in words, such as {{ui:assets.assetTypes.DATA_STORE}}), **{{ui:assets.import.colCriticality}}**, **{{ui:assets.import.colOwner}}** and **{{ui:assets.import.colStatus}}**. The status reads **{{ui:assets.import.rowOk}}** or names the problem: a missing name or type, an unknown type or status, or a confidentiality, integrity or availability value outside 1 to 5. Below the preview, a line says how many more rows the file holds.

## What you can do

### Import a file

1. Click **{{ui:assets.import.chooseFile}}** and pick a `.csv` file.
2. Check the preview. Rows with a problem are left out.
3. Click the import button, which counts the valid rows.

The result card shows how many assets were created out of the rows in the file, and then:

- **Skipped rows.** A row whose name matches an existing asset, or a row earlier in the same file, is skipped. Names are compared without regard to case. Each skipped row is listed with its reason.
- **{{ui:assets.import.errors}}.** Rows the preview refused, and rows the server refused, each with its row number and reason.

Row numbers count the data rows of your file, the header not included, so a row has the same number in the preview, in the skipped list and in the errors.

A file can hold up to 500 rows. A larger file is refused as a whole and nothing is created; the card says **{{ui:assets.import.importFailed}}**

Click **{{ui:assets.import.viewRegister}}** to see the new assets, or **{{ui:assets.import.importMore}}** to import another file.

## What happens next

The new assets appear in the {{ui:assets.title}} register, with their criticality worked out from their confidentiality, integrity and availability. An asset's CPE, vendor and product are what vulnerability matching uses to find it. Each created asset is recorded in the audit log.

## Empty and error states

| What you see | Why | What to do |
| --- | --- | --- |
| **{{ui:assets.import.invalidCsv}}** | The file has no Name column, or no rows | Add a header row with a Name column |
| A row marked with a problem in the preview | The row is missing a value or has one the importer does not accept | Fix the row in your file and choose it again |
| **{{ui:assets.import.importFailed}}** | The whole import was refused, for example because the file has more than 500 rows. The reason is listed under **{{ui:assets.import.errors}}** | Fix what it names, or split the file, and try again |

## Related

- [{{ui:assets.title}}](assets.md), the register the assets are added to.
- [An asset](asset-detail.md), where an imported asset's owner and details can be corrected.
- [Import risks](risk-import.md), the same kind of import for risks.
