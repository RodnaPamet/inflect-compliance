---
route: /t/[tenantSlug]/risks/import
---

# Import risks

{{ui:riskManager.importTitle}} loads many risks at once from a spreadsheet saved as a CSV file, for example a register you kept before Inflect.

## Where to find it

Open **{{ui:nav.risks}}** under **{{ui:nav.govern}}**, then **{{ui:risks.viewsMenu}}** › **{{ui:risks.importRisks}}**. The entry appears only for roles that can create risks.

## Who can use it

Owners, Admins and Editors. Any other role who opens the page sees **{{ui:riskManager.noImportPermission}}** and a link back to the register.

## What it is for

Move an existing register into Inflect without typing every risk in by hand.

## What you see

**{{ui:riskManager.csvFormat}}.** The columns the file can have, and an example. Only a `title` column is required. The others are `description`, `category`, `likelihood`, `impact` and `owner`.

**{{ui:riskManager.chooseFile}}.** Picks the file.

**The preview.** How many risks the file holds, and the first 20 rows: title, category, likelihood × impact and owner. A likelihood or impact outside your risk matrix is flagged, and that row is imported at the default value instead.

**The result.** How many risks were created, how many rows were skipped because a risk with the same title already exists, and any rows that failed with the reason.

## What you can do

1. Save your register as a CSV file whose first row holds the column names.
2. Click **{{ui:riskManager.chooseFile}}** and pick it.
3. Check the preview, then click the import button.
4. When it finishes, click **{{ui:riskManager.viewRegister}}**, or **{{ui:riskManager.importMore}}** for another file.

## What happens next

The new risks appear in the register. A risk imported without a likelihood or impact takes the default values, so assess it on its own page.

## Empty and error states

| What you see | What it means | What to do |
| --- | --- | --- |
| **{{ui:riskManager.noValidRows}}** | No row of the file has a title | Check the first row names a `title` column |
| **{{ui:riskManager.noImportPermission}}** | Your role cannot create risks | Ask an Owner, Admin or Editor |
| **{{ui:riskManager.errors}}** | Some rows were not created | Read each reason, correct those rows and import them again |

## Related

- [{{ui:risks.title}}](risks.md), where the imported risks appear.
- [A risk](risk-detail.md), where each one is assessed.
